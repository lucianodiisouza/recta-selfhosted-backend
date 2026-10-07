import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => {
  const state = { local: true };
  return {
    state,
    env: { AUTH_MODE: 'local', AUTH_JWT_SECRET: 'x'.repeat(40), AUTH_TOKEN_TTL_HOURS: 1, AUTH_ALLOW_REGISTRATION: true, AUTH_FIREBASE_WEB_API_KEY: undefined as string | undefined },
    // A getter, so each test can flip the mode the middleware and routes read.
    get isLocalAuth() {
      return state.local;
    },
    isProduction: false,
  };
});
const db = vi.hoisted(() => ({
  userFindUnique: vi.fn(),
  userFindFirst: vi.fn(),
  userCreate: vi.fn(),
  userUpdate: vi.fn(),
  userDelete: vi.fn(),
  memberFindMany: vi.fn(),
  referralFindUnique: vi.fn(),
  personalHousehold: vi.fn(),
}));

vi.mock('../../shared/config/env.js', () => config);
vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    user: { findUnique: db.userFindUnique, findFirst: db.userFindFirst, create: db.userCreate, update: db.userUpdate, delete: db.userDelete },
    householdMember: { findMany: db.memberFindMany },
    referral: { findUnique: db.referralFindUnique },
  },
}));
vi.mock('../households/households.service.js', () => ({ getOrCreatePersonalHousehold: db.personalHousehold }));
vi.mock('../../shared/config/firebase.js', () => ({
  getFirebaseAuth: () => ({ verifyIdToken: vi.fn().mockRejectedValue(new Error('not a Firebase token')) }),
}));

const { authRoutes } = await import('./auth.routes.js');
const { errorHandler } = await import('../../shared/errors/error-handler.js');
const { resetLoginFailures, signJwt } = await import('./local.service.js');

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(authRoutes, { prefix: '/auth' });
});
afterAll(() => app.close());

const HOUSEHOLD_ID = 'bb9d2a52-0f0e-4a3e-a0f5-6d6a1b2c3d4e';
const USER_ROW = { id: '6f1c1f0e-8a49-4c53-9c06-3f0a1d1c2b11', email: 'ana@example.com', firebaseUid: null, createdAt: new Date('2026-01-05T10:00:00Z') };
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const credentials = { email: 'ana@example.com', password: 'correct horse' };

beforeEach(() => {
  vi.clearAllMocks();
  resetLoginFailures();
  db.userFindFirst.mockResolvedValue(null);
  config.state.local = true;
  config.env.AUTH_ALLOW_REGISTRATION = true;
  db.personalHousehold.mockResolvedValue({ id: HOUSEHOLD_ID });
  db.memberFindMany.mockResolvedValue([]);
  db.referralFindUnique.mockResolvedValue(null);
});

describe('POST /auth/register', () => {
  it('creates the user and its personal household, without exposing the hash', async () => {
    db.userFindUnique.mockResolvedValue(null);
    db.userCreate.mockImplementation(async ({ data }) => ({ ...USER_ROW, ...data }));

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ success: true, data: { id: USER_ROW.id, email: 'ana@example.com', householdId: HOUSEHOLD_ID } });
    expect(res.body).not.toContain('passwordHash');
  });

  it('answers 409 with an error object when the email exists', async () => {
    db.userFindFirst.mockResolvedValue(USER_ROW);

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'CONFLICT', message: 'Email already registered' } });
  });

  it('registers the lowercased email, so a different casing is the same account', async () => {
    db.userFindUnique.mockResolvedValue(null);
    db.userCreate.mockImplementation(async ({ data }) => ({ ...USER_ROW, ...data }));

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { ...credentials, email: ' Ana@Example.COM ' } });

    expect(res.statusCode).toBe(201);
    expect(db.userFindFirst).toHaveBeenCalledWith({ where: { email: { equals: 'ana@example.com', mode: 'insensitive' } }, select: { id: true } });
    expect(res.json().data.email).toBe('ana@example.com');
  });

  it('answers 409 when a concurrent request took the email between the lookup and the insert', async () => {
    db.userCreate.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });

    expect(res.statusCode).toBe(409);
  });

  it('removes the user again when its personal household cannot be created', async () => {
    db.userFindUnique.mockResolvedValue(null);
    db.userCreate.mockImplementation(async ({ data }) => ({ ...USER_ROW, ...data }));
    db.personalHousehold.mockRejectedValue(new Error('database unavailable'));

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });

    expect(res.statusCode).toBe(500);
    expect(db.userDelete).toHaveBeenCalledWith({ where: { id: USER_ROW.id } });
  });

  it('reports the household failure, not the cleanup failure, when both go wrong', async () => {
    db.userFindUnique.mockResolvedValue(null);
    db.userCreate.mockImplementation(async ({ data }) => ({ ...USER_ROW, ...data }));
    db.personalHousehold.mockRejectedValue(new Error('household failed'));
    db.userDelete.mockRejectedValue(new Error('delete failed'));

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });

    expect(res.json().error.message).toBe('household failed');
  });

  it('answers 403 and creates nothing when registration is closed', async () => {
    config.env.AUTH_ALLOW_REGISTRATION = false;

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'REGISTRATION_DISABLED' } });
    expect(db.userCreate).not.toHaveBeenCalled();
  });

  it('answers 400 for a password over 72 bytes', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { ...credentials, password: 'a'.repeat(73) } });

    expect(res.statusCode).toBe(400);
    expect(db.userCreate).not.toHaveBeenCalled();
  });

  it('answers 400 for a password under 8 characters', async () => {
    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: { ...credentials, password: 'short' } });

    expect(res.statusCode).toBe(400);
    expect(db.userCreate).not.toHaveBeenCalled();
  });

  it('is not available in Firebase mode', async () => {
    config.state.local = false;

    const res = await app.inject({ method: 'POST', url: '/auth/register', payload: credentials });

    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(db.userCreate).not.toHaveBeenCalled();
  });
});

describe('POST /auth/login', () => {
  it('answers 401 with an error object for unknown credentials', async () => {
    db.userFindUnique.mockResolvedValue(null);

    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: credentials });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } });
  });

  it('returns a token that opens GET /auth/me', async () => {
    const passwordHash = bcrypt.hashSync(credentials.password, 4);
    db.userFindUnique.mockImplementation(async ({ where }) => ({ ...USER_ROW, ...(where.email ? { passwordHash } : {}) }));

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: credentials });
    expect(login.statusCode).toBe(200);
    const { token } = login.json().data;

    const me = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(token) });

    expect(me.statusCode).toBe(200);
    expect(me.json().data).toMatchObject({ id: USER_ROW.id, email: 'ana@example.com', firebaseUid: null });
    expect(db.userFindUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { id: USER_ROW.id }, omit: { passwordHash: true } }));
  });

  it('finds the account whatever the casing of the email', async () => {
    db.userFindUnique.mockResolvedValue(null);

    await app.inject({ method: 'POST', url: '/auth/login', payload: { ...credentials, email: 'ANA@example.com' } });

    expect(db.userFindUnique).toHaveBeenCalledWith({ where: { email: 'ana@example.com' } });
  });

  it('is not available in Firebase mode', async () => {
    config.state.local = false;

    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: credentials });

    expect(res.statusCode).toBe(404);
  });
});

describe('protected routes in local mode', () => {
  it('rejects a request without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/me' });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
  });

  it('rejects a token signed with another secret', async () => {
    const forged = jwt.sign({ sub: USER_ROW.id, email: 'ana@example.com' }, 'y'.repeat(40));

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(forged) });

    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: { code: 'INVALID_TOKEN' } });
  });

  it('answers 401 when the token belongs to a user that no longer exists', async () => {
    db.userFindUnique.mockResolvedValue(null);

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(signJwt(USER_ROW.id, 'ana@example.com')) });

    expect(res.statusCode).toBe(401);
  });

  it('syncs without creating a user or setting firebaseUid', async () => {
    db.userFindUnique.mockResolvedValue(USER_ROW);

    const res = await app.inject({ method: 'POST', url: '/auth/sync', headers: bearer(signJwt(USER_ROW.id, 'ana@example.com')), payload: {} });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: USER_ROW.id, emailVerified: true, householdId: HOUSEHOLD_ID });
    expect(db.userCreate).not.toHaveBeenCalled();
    expect(db.userUpdate).not.toHaveBeenCalled();
  });
});

describe('Firebase mode', () => {
  it('does not accept a local JWT', async () => {
    config.state.local = false;

    const res = await app.inject({ method: 'GET', url: '/auth/me', headers: bearer(signJwt(USER_ROW.id, 'ana@example.com')) });

    expect(res.statusCode).toBe(401);
  });
});

describe('GET /auth/config', () => {
  it('advertises the mode', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/config' });

    expect(res.json()).toEqual({ success: true, data: { authMode: 'local', firebaseWebApiKey: null, registrationEnabled: true } });
  });

  it('reports closed registration', async () => {
    config.env.AUTH_ALLOW_REGISTRATION = false;

    const res = await app.inject({ method: 'GET', url: '/auth/config' });

    expect(res.json().data.registrationEnabled).toBe(false);
  });
});

describe('rate limit on the credential routes', () => {
  it('keeps counting one email when the client rotates X-Forwarded-For to dodge the per-IP limit', async () => {
    const limited = Fastify({ trustProxy: true });
    limited.setErrorHandler(errorHandler);
    await limited.register(rateLimit, { max: 1000, timeWindow: 60000 });
    await limited.register(authRoutes, { prefix: '/auth' });
    db.userFindUnique.mockResolvedValue(null);

    const statuses: number[] = [];
    let blocked;
    for (let i = 0; i < 31; i++) {
      const res = await limited.inject({
        method: 'POST',
        url: '/auth/login',
        headers: { 'x-forwarded-for': `10.0.0.${i + 1}` },
        payload: credentials,
      });
      statuses.push(res.statusCode);
      blocked = res;
    }
    await limited.close();

    expect(statuses.slice(0, 30)).toEqual(Array(30).fill(401));
    expect(statuses[30]).toBe(429);
    expect(blocked?.headers['retry-after']).toBeDefined();
    expect(blocked?.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
  }, 30000);

  it('answers 429 as an error object after 10 attempts from one IP, and only on those routes', async () => {
    const limited = Fastify();
    limited.setErrorHandler(errorHandler);
    await limited.register(rateLimit, { max: 1000, timeWindow: 60000 });
    await limited.register(authRoutes, { prefix: '/auth' });
    db.userFindUnique.mockResolvedValue(null);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await limited.inject({ method: 'POST', url: '/auth/login', payload: credentials })).statusCode);
    }
    const blocked = await limited.inject({ method: 'POST', url: '/auth/login', payload: credentials });
    const other = await limited.inject({ method: 'GET', url: '/auth/config' });
    await limited.close();

    expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
    expect(statuses[10]).toBe(429);
    expect(blocked.json()).toMatchObject({ success: false, error: { code: 'RATE_LIMITED' } });
    expect(other.statusCode).toBe(200);
  });
});
