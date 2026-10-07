import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Reset and delete look the signed-in user up by the token subject: the user id in local mode, the Firebase UID
// in Firebase mode. Neither may create a user just to remove it.
const config = vi.hoisted(() => {
  const state = { local: true };
  return {
    state,
    env: { AUTH_MODE: 'local', AUTH_JWT_SECRET: 'x'.repeat(40), AUTH_TOKEN_TTL_HOURS: 1 },
    get isLocalAuth() {
      return state.local;
    },
    isProduction: false,
  };
});
const db = vi.hoisted(() => ({ userFindUnique: vi.fn(), userCreate: vi.fn(), resetUserData: vi.fn(), deleteUser: vi.fn() }));

vi.mock('../../shared/config/env.js', () => config);
vi.mock('../../shared/db/prisma.js', () => ({ prisma: { user: { findUnique: db.userFindUnique, create: db.userCreate } } }));
vi.mock('./users.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./users.service.js')>()),
  resetUserData: db.resetUserData,
  deleteUser: db.deleteUser,
}));
vi.mock('../../shared/config/firebase.js', () => ({
  getFirebaseAuth: () => ({
    verifyIdToken: vi.fn().mockResolvedValue({ uid: 'firebase-uid-1', email: 'ana@example.com', email_verified: true }),
  }),
}));

const { userRoutes } = await import('./users.routes.js');
const { errorHandler } = await import('../../shared/errors/error-handler.js');
const { signJwt } = await import('../auth/local.service.js');

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(userRoutes, { prefix: '/users' });
});
afterAll(() => app.close());

const USER_ID = '6f1c1f0e-8a49-4c53-9c06-3f0a1d1c2b11';
const localToken = () => ({ authorization: `Bearer ${signJwt(USER_ID, 'ana@example.com')}` });
const firebaseToken = { authorization: 'Bearer firebase-id-token' };

beforeEach(() => {
  vi.clearAllMocks();
  config.state.local = true;
});

describe.each([
  ['DELETE', 'deleteUser', db.deleteUser],
  ['POST', 'resetUserData', db.resetUserData],
] as const)('%s /users/me (%s)', (method, _name, action) => {
  const url = method === 'DELETE' ? '/users/me' : '/users/me/reset';

  it('local mode: finds the user by id', async () => {
    db.userFindUnique.mockResolvedValue({ id: USER_ID });

    const res = await app.inject({ method, url, headers: localToken() });

    expect(res.statusCode).toBe(200);
    expect(db.userFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: USER_ID } }));
    expect(action).toHaveBeenCalledWith(USER_ID);
  });

  it('Firebase mode: finds the user by Firebase UID and does not create one', async () => {
    config.state.local = false;
    db.userFindUnique.mockResolvedValue({ id: USER_ID });

    const res = await app.inject({ method, url, headers: firebaseToken });

    expect(res.statusCode).toBe(200);
    expect(db.userFindUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { firebaseUid: 'firebase-uid-1' } }));
    expect(action).toHaveBeenCalledWith(USER_ID);
  });

  it('answers 404 and creates nothing when the user is unknown', async () => {
    config.state.local = false;
    db.userFindUnique.mockResolvedValue(null);

    const res = await app.inject({ method, url, headers: firebaseToken });

    expect(res.statusCode).toBe(404);
    expect(db.userCreate).not.toHaveBeenCalled();
    expect(action).not.toHaveBeenCalled();
  });
});
