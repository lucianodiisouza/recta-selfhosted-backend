import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '../../shared/errors/error-handler.js';
import { accountRoutes } from './accounts.routes.js';
import * as accountsService from './accounts.service.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
  getUserByFirebaseUid: vi.fn(),
}));
vi.mock('./accounts.service.js', () => ({
  getAccount: vi.fn(),
  adjustBalance: vi.fn(),
}));

// Invented data only.
const ACC = '11111111-1111-4111-8111-111111111111';

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(accountRoutes, { prefix: '/accounts' });
  await app.ready();
});
afterAll(() => app.close());

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(accountsService.getAccount).mockResolvedValue({ id: ACC, householdId: 'hh-1' } as never);
  vi.mocked(accountsService.adjustBalance).mockResolvedValue({ account: {}, adjustment: null } as never);
});

const post = (payload: unknown) => app.inject({ method: 'POST', url: `/accounts/${ACC}/adjust-balance`, payload: payload as object });

describe('POST /accounts/:id/adjust-balance body validation', () => {
  // Ajv used to coerce null/false to 0 and true to 1 before zod saw them, silently zeroing the balance.
  it.each([
    ['null', { newBalance: null }],
    ['false', { newBalance: false }],
    ['true', { newBalance: true }],
    ['hex string', { newBalance: '0x10' }],
    ['exponent string', { newBalance: '1e2' }],
    ['empty string', { newBalance: '' }],
  ])('rejects %s without touching the account', async (_name, body) => {
    const res = await post(body);
    expect(res.statusCode).toBe(400);
    expect(accountsService.adjustBalance).not.toHaveBeenCalled();
  });

  it('accepts a number and a plain decimal string', async () => {
    expect((await post({ newBalance: 3802.27, date: '2025-12-31' })).statusCode).toBe(200);
    expect((await post({ newBalance: '3802.27' })).statusCode).toBe(200);
    expect(accountsService.adjustBalance).toHaveBeenCalledTimes(2);
  });
});
