import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../shared/db/prisma.js';
import { env } from '../../shared/config/env.js';
import {
  ConflictError,
  TooManyRequestsError,
  InvalidTokenError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors/index.js';

const isUniqueConstraintError = (error: unknown): boolean => (error as { code?: string } | null)?.code === 'P2002';

// bcrypt only reads the first 72 bytes of a password, so a longer one would silently match any password that
// shares its first 72 bytes. Count bytes, not characters: UTF-8 characters can take up to 4.
export const PASSWORD_MAX_BYTES = 72;
export const BCRYPT_COST = 12;

// Emails are compared case-insensitively by every mail provider, and the unique index on users.email is
// case-sensitive, so the address is trimmed and lowercased before it is looked up or stored.
const emailSchema = z.string().trim().toLowerCase().email('Invalid email address');

const credentialsSchema = z.object({
  email: emailSchema,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .refine((value) => Buffer.byteLength(value, 'utf8') <= PASSWORD_MAX_BYTES, `Password must be at most ${PASSWORD_MAX_BYTES} bytes`),
});

// Login runs bcrypt even when there is no user or no hash, against a hash of a random password, so that the
// response time does not tell whether an email is registered. Built on first use, not at import: hashing takes
// about 300 ms, which a server in Firebase mode (or a test that never logs in) should not pay.
let dummyPasswordHash: Promise<string> | null = null;
const getDummyPasswordHash = (): Promise<string> =>
  (dummyPasswordHash ??= bcrypt.hash(randomBytes(16).toString('hex'), BCRYPT_COST));

// Failed logins per email, in memory (one counter per server process). Together with the per-IP limit on the
// route it keeps a guesser from trying passwords for one account without end, even when the IP header is
// spoofed. The price: anyone can lock a known email out for the rest of the window by failing on purpose.
export const LOGIN_FAILURE_LIMIT = 30;
export const LOGIN_FAILURE_WINDOW_MS = 60 * 60 * 1000;
const loginFailures = new Map<string, { count: number; resetAt: number }>();

function assertLoginAllowed(email: string, now = Date.now()): void {
  const entry = loginFailures.get(email);
  if (!entry) return;
  if (entry.resetAt <= now) {
    loginFailures.delete(email);
    return;
  }
  if (entry.count >= LOGIN_FAILURE_LIMIT) {
    throw new TooManyRequestsError('Too many failed sign-in attempts for this account, try again later', Math.ceil((entry.resetAt - now) / 1000));
  }
}

function recordLoginFailure(email: string, now = Date.now()): void {
  const entry = loginFailures.get(email);
  if (!entry || entry.resetAt <= now) {
    loginFailures.set(email, { count: 1, resetAt: now + LOGIN_FAILURE_WINDOW_MS });
    return;
  }
  entry.count += 1;
}

/** For tests: forget every failure counter. */
export function resetLoginFailures(): void {
  loginFailures.clear();
}

export interface LocalJwtPayload {
  sub: string;
  email: string;
}

function requireJwtSecret(): string {
  const secret = env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error('AUTH_JWT_SECRET is required when AUTH_MODE=local');
  }
  return secret;
}

export function signJwt(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, requireJwtSecret(), {
    algorithm: 'HS256',
    expiresIn: env.AUTH_TOKEN_TTL_HOURS * 3600,
  });
}

export function verifyJwt(token: string): LocalJwtPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, requireJwtSecret(), { algorithms: ['HS256'] });
  } catch {
    throw new InvalidTokenError();
  }

  const parsed = z
    .object({ sub: z.string().uuid(), email: z.string().email(), exp: z.number() })
    .safeParse(decoded);

  if (!parsed.success) {
    throw new InvalidTokenError();
  }

  return { sub: parsed.data.sub, email: parsed.data.email };
}

export async function register(email: string, password: string) {
  const parsed = credentialsSchema.safeParse({ email, password });
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten().fieldErrors);
  }

  // Case-insensitive: a user created elsewhere (Firebase) may be stored with capitals, and the unique index
  // would not see `Mixed@x.com` and `mixed@x.com` as the same email.
  const existing = await prisma.user.findFirst({
    where: { email: { equals: parsed.data.email, mode: 'insensitive' } },
    select: { id: true },
  });
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_COST);

  try {
    const user = await prisma.user.create({
      data: { email: parsed.data.email, passwordHash, firebaseUid: null },
    });
    const { passwordHash: _omitted, ...safeUser } = user;
    return safeUser;
  } catch (error) {
    // Two requests for the same email can both pass the lookup above; the unique index decides.
    if (isUniqueConstraintError(error)) {
      throw new ConflictError('Email already registered');
    }
    throw error;
  }
}

/** Undo a registration whose follow-up step (the personal household) failed, so no user is left half-created. */
export async function discardRegisteredUser(userId: string): Promise<void> {
  await prisma.user.delete({ where: { id: userId } });
}

export async function login(email: string, password: string) {
  const parsed = credentialsSchema.safeParse({ email, password });
  if (!parsed.success) {
    throw new UnauthorizedError('Invalid credentials');
  }

  assertLoginAllowed(parsed.data.email);

  // Local accounts are always stored lowercase (register lowercases), so the exact lookup finds them.
  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });

  // Always one bcrypt comparison, whether or not the user or its hash exists (see getDummyPasswordHash).
  const matches = await bcrypt.compare(parsed.data.password, user?.passwordHash ?? (await getDummyPasswordHash()));

  if (!user?.passwordHash || !matches) {
    recordLoginFailure(parsed.data.email);
    throw new UnauthorizedError('Invalid credentials');
  }
  loginFailures.delete(parsed.data.email);

  const token = signJwt(user.id, user.email);
  const { passwordHash: _omitted, ...safeUser } = user;
  return { user: safeUser, token };
}
