import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'x'.repeat(40);
const UID = '6f1c1f0e-8a49-4c53-9c06-3f0a1d1c2b11';
const config = vi.hoisted(() => ({ env: { AUTH_JWT_SECRET: undefined as string | undefined, AUTH_TOKEN_TTL_HOURS: 1 } }));
const db = vi.hoisted(() => ({ findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() }));

vi.mock('../../shared/config/env.js', () => config);
vi.mock('../../shared/db/prisma.js', () => ({ prisma: { user: { findUnique: db.findUnique, findFirst: db.findFirst, create: db.create, delete: db.delete } } }));

const { BCRYPT_COST, LOGIN_FAILURE_LIMIT, discardRegisteredUser, login, register, resetLoginFailures, signJwt, verifyJwt } = await import('./local.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  resetLoginFailures();
  db.findFirst.mockResolvedValue(null);
  config.env.AUTH_JWT_SECRET = SECRET;
  config.env.AUTH_TOKEN_TTL_HOURS = 1;
});

describe('signJwt / verifyJwt', () => {
  it('round-trips the user id and email', () => {
    expect(verifyJwt(signJwt(UID, 'ana@example.com'))).toEqual({ sub: UID, email: 'ana@example.com' });
  });

  it('expires after the configured number of hours', () => {
    const token = signJwt(UID, 'ana@example.com');
    const { exp, iat } = jwt.decode(token) as { exp: number; iat: number };

    expect(exp - iat).toBe(3600);
  });

  it('rejects a token signed with another secret', () => {
    const forged = jwt.sign({ sub: UID, email: 'ana@example.com' }, 'y'.repeat(40));

    expect(() => verifyJwt(forged)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects an expired token', () => {
    const expired = jwt.sign({ sub: UID, email: 'ana@example.com' }, SECRET, { expiresIn: -10 });

    expect(() => verifyJwt(expired)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects a validly signed token without the expected claims', () => {
    expect(() => verifyJwt(jwt.sign({ sub: UID }, SECRET))).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects an unsigned (alg none) token', () => {
    const none = jwt.sign({ sub: UID, email: 'ana@example.com' }, '', { algorithm: 'none' });

    expect(() => verifyJwt(none)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects a token signed with another HMAC algorithm', () => {
    const hs512 = jwt.sign({ sub: UID, email: 'ana@example.com' }, SECRET, { algorithm: 'HS512', expiresIn: 60 });

    expect(() => verifyJwt(hs512)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects a token that never expires', () => {
    const noExp = jwt.sign({ sub: UID, email: 'ana@example.com' }, SECRET);

    expect(() => verifyJwt(noExp)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('rejects a subject that is not a user id', () => {
    const odd = jwt.sign({ sub: 'not-a-uuid', email: 'ana@example.com' }, SECRET, { expiresIn: 60 });

    expect(() => verifyJwt(odd)).toThrow(expect.objectContaining({ code: 'INVALID_TOKEN' }));
  });

  it('fails loudly when the secret is not configured', () => {
    config.env.AUTH_JWT_SECRET = undefined;

    expect(() => signJwt(UID, 'ana@example.com')).toThrow('AUTH_JWT_SECRET is required');
  });
});

describe('register', () => {
  it('stores a bcrypt hash, never the password, and returns no hash', async () => {
    db.create.mockImplementation(async ({ data }) => ({ id: UID, createdAt: new Date(), ...data }));

    const user = await register('ana@example.com', 'correct horse');

    const stored = db.create.mock.calls[0][0].data;
    expect(stored.passwordHash).not.toContain('correct horse');
    expect(await bcrypt.compare('correct horse', stored.passwordHash)).toBe(true);
    expect(stored.firebaseUid).toBeNull();
    expect(user).not.toHaveProperty('passwordHash');
    expect(user.email).toBe('ana@example.com');
  });

  it('rejects an email that is already registered', async () => {
    db.findFirst.mockResolvedValue({ id: UID });

    await expect(register('ana@example.com', 'correct horse')).rejects.toMatchObject({ statusCode: 409 });
    expect(db.create).not.toHaveBeenCalled();
  });

  it('rejects a short password and a malformed email without touching the database', async () => {
    await expect(register('ana@example.com', 'short')).rejects.toMatchObject({ statusCode: 400 });
    await expect(register('not-an-email', 'correct horse')).rejects.toMatchObject({ statusCode: 400 });
    expect(db.findFirst).not.toHaveBeenCalled();
  });
});

describe('register: email and password rules', () => {
  const created = () => db.create.mock.calls[0][0].data;

  beforeEach(() => {
    db.create.mockImplementation(async ({ data }) => ({ id: UID, createdAt: new Date(), ...data }));
  });

  it('stores and looks up the email trimmed and lowercased', async () => {
    await register('  Ana@Example.COM ', 'correct horse');

    expect(db.findFirst).toHaveBeenCalledWith({ where: { email: { equals: 'ana@example.com', mode: 'insensitive' } }, select: { id: true } });
    expect(created().email).toBe('ana@example.com');
  });

  it('refuses an email that exists with other capitals (a user created through Firebase)', async () => {
    db.findFirst.mockResolvedValue({ id: UID });

    await expect(register('mixed.case@example.com', 'correct horse')).rejects.toMatchObject({ statusCode: 409 });
    expect(db.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { email: { equals: 'mixed.case@example.com', mode: 'insensitive' } } }));
  });

  it('hashes with bcrypt cost 12', async () => {
    await register('ana@example.com', 'correct horse');

    expect(created().passwordHash).toMatch(/^\$2[aby]\$12\$/);
    expect(BCRYPT_COST).toBe(12);
  });

  it('accepts a password of exactly 72 bytes and refuses 73', async () => {
    await expect(register('ana@example.com', 'a'.repeat(72))).resolves.toBeDefined();
    await expect(register('ana@example.com', 'a'.repeat(73))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('counts bytes, not characters: 25 three-byte characters are 75 bytes', async () => {
    await expect(register('ana@example.com', 'é'.repeat(36))).resolves.toBeDefined();
    await expect(register('ana@example.com', '€'.repeat(25))).rejects.toMatchObject({ statusCode: 400 });
  });

  it('answers 409 when the unique index rejects a concurrent registration of the same email', async () => {
    db.create.mockRejectedValue(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    await expect(register('ana@example.com', 'correct horse')).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lets other database errors through', async () => {
    db.create.mockRejectedValue(new Error('connection lost'));

    await expect(register('ana@example.com', 'correct horse')).rejects.toThrow('connection lost');
  });

  it('can discard the user it created', async () => {
    db.delete.mockResolvedValue({});

    await discardRegisteredUser(UID);

    expect(db.delete).toHaveBeenCalledWith({ where: { id: UID } });
  });
});

describe('login', () => {
  const passwordHash = bcrypt.hashSync('correct horse', 4);

  it('returns a token for the user and no hash', async () => {
    db.findUnique.mockResolvedValue({ id: UID, email: 'ana@example.com', passwordHash });

    const { user, token } = await login('ana@example.com', 'correct horse');

    expect(verifyJwt(token)).toEqual({ sub: UID, email: 'ana@example.com' });
    expect(user).not.toHaveProperty('passwordHash');
  });

  it('answers a wrong password, an unknown email and a Firebase-only user the same way', async () => {
    const rejected = async (row: unknown, password: string) => {
      db.findUnique.mockResolvedValue(row);
      return login('ana@example.com', password).catch((e) => ({ status: e.statusCode, message: e.message }));
    };

    const wrongPassword = await rejected({ id: UID, email: 'ana@example.com', passwordHash }, 'wrong password');
    const unknown = await rejected(null, 'correct horse');
    const firebaseOnly = await rejected({ id: 'user-2', email: 'ana@example.com', passwordHash: null }, 'correct horse');

    expect(wrongPassword).toEqual({ status: 401, message: 'Invalid credentials' });
    expect(unknown).toEqual(wrongPassword);
    expect(firebaseOnly).toEqual(wrongPassword);
  });
});

describe('login: email, passwords and timing', () => {
  const passwordHash = bcrypt.hashSync('correct horse', 4);

  it('finds the user by the lowercased, trimmed email', async () => {
    db.findUnique.mockResolvedValue({ id: UID, email: 'ana@example.com', passwordHash });

    await login('  Ana@Example.COM ', 'correct horse');

    expect(db.findUnique).toHaveBeenCalledWith({ where: { email: 'ana@example.com' } });
  });

  it('runs one bcrypt comparison whether the password is wrong, the user is unknown or it has no hash', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    try {
      for (const row of [{ id: UID, email: 'ana@example.com', passwordHash }, null, { id: UID, email: 'ana@example.com', passwordHash: null }]) {
        compare.mockClear();
        db.findUnique.mockResolvedValue(row);

        await expect(login('ana@example.com', 'wrong password')).rejects.toMatchObject({ statusCode: 401 });

        expect(compare).toHaveBeenCalledTimes(1);
      }
    } finally {
      compare.mockRestore();
    }
  });

  it('compares against a hash of the same cost when there is no user', async () => {
    const compare = vi.spyOn(bcrypt, 'compare');
    try {
      db.findUnique.mockResolvedValue(null);

      await login('ana@example.com', 'correct horse').catch(() => undefined);

      expect(String(compare.mock.calls[0][1])).toMatch(/^\$2[aby]\$12\$/);
    } finally {
      compare.mockRestore();
    }
  });

  it('does not let a 73rd byte stand in for the rest: the long password is refused outright', async () => {
    const stored = bcrypt.hashSync('a'.repeat(72), 4);
    db.findUnique.mockResolvedValue({ id: UID, email: 'ana@example.com', passwordHash: stored });

    await expect(login('ana@example.com', 'a'.repeat(72) + 'QQQ')).rejects.toMatchObject({ statusCode: 401 });
    await expect(login('ana@example.com', 'a'.repeat(72) + 'XYZ')).rejects.toMatchObject({ statusCode: 401 });
    await expect(login('ana@example.com', 'a'.repeat(72))).resolves.toBeDefined();
  });
});

describe('login: failures per email', () => {
  const passwordHash = bcrypt.hashSync('correct horse', 4);

  beforeEach(() => db.findUnique.mockResolvedValue({ id: UID, email: 'ana@example.com', passwordHash }));

  const fail = () => login('ana@example.com', 'wrong password').catch((e) => e);

  it('answers 429 with a retry delay after the limit of failed attempts, even with the right password', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      expect(await fail()).toMatchObject({ statusCode: 401 });
    }

    const blocked = await login('ana@example.com', 'correct horse').catch((e) => e);

    expect(blocked).toMatchObject({ statusCode: 429, code: 'RATE_LIMITED' });
    expect(blocked.retryAfterSeconds).toBeGreaterThan(3500);
  });

  it('counts the lowercased email, so changing the casing does not reset it', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      await login(i % 2 ? 'ANA@example.com' : ' Ana@Example.com ', 'wrong password').catch(() => undefined);
    }

    expect(await login('ana@example.com', 'correct horse').catch((e) => e)).toMatchObject({ statusCode: 429 });
  });

  it('forgets earlier failures after a successful login', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) await fail();
    await login('ana@example.com', 'correct horse');

    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) await fail();

    expect(await login('ana@example.com', 'correct horse')).toBeDefined();
  });

  it('does not let one email lock another', async () => {
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await fail();

    db.findUnique.mockResolvedValue({ id: UID, email: 'bob@example.com', passwordHash });
    expect(await login('bob@example.com', 'correct horse')).toBeDefined();
  });

  it('counts unknown emails too, so the limit does not reveal which exist', async () => {
    db.findUnique.mockResolvedValue(null);
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) await fail();

    expect(await fail()).toMatchObject({ statusCode: 429 });
  }, 30000); // 30 comparisons against the real-cost dummy hash
});

describe('registration cleanup', () => {
  it('builds the dummy hash on the first login, not at import', async () => {
    vi.resetModules();
    const hash = vi.spyOn(bcrypt, 'hash');
    try {
      const fresh = await import('./local.service.js');
      expect(hash).not.toHaveBeenCalled();

      db.findUnique.mockResolvedValue(null);
      await fresh.login('ana@example.com', 'correct horse').catch(() => undefined);
      await fresh.login('ana@example.com', 'correct horse').catch(() => undefined);

      expect(hash).toHaveBeenCalledTimes(1);
    } finally {
      hash.mockRestore();
    }
  });
});
