import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, InsufficientRoleError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { applyDetectedRecurrences, detectRecurringTransactions } from './recurring-detect.service.js';
import { recurringTransactionRoutes } from './recurring-transactions.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  // Unauthenticated unless the request carries a bearer header
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('./recurring-detect.service.js', () => ({
  detectRecurringTransactions: vi.fn(),
  applyDetectedRecurrences: vi.fn(),
}));
vi.mock('./recurring-transactions.service.js', () => ({}));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };
const EMPTY_SKIPPED = { alreadyRecurring: 0, installments: 0, sparse: 0, consumption: 0 };

const m = {
  editor: vi.mocked(requireEditor),
  member: vi.mocked(requireHouseholdMember),
  detect: vi.mocked(detectRecurringTransactions),
  apply: vi.mocked(applyDetectedRecurrences),
};

describe('recurring detect routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(recurringTransactionRoutes, { prefix: '/recurring-transactions' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    m.member.mockResolvedValue({} as never);
    m.editor.mockResolvedValue({} as never);
    m.detect.mockResolvedValue({ candidates: [], skipped: EMPTY_SKIPPED });
    m.apply.mockResolvedValue({ created: 1, skipped: 0, linkedTransactions: 3, warnings: [] });
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'POST', url, payload: payload as never, headers });

  describe('POST /detect', () => {
    it('answers 401 without credentials, before anything else', async () => {
      expect((await post('/recurring-transactions/detect', { householdId: HH }, {})).statusCode).toBe(401);
      expect(m.member).not.toHaveBeenCalled();
      expect(m.detect).not.toHaveBeenCalled();
    });

    it('lets any member read: membership, not editor, and the envelope', async () => {
      const res = await post('/recurring-transactions/detect', { householdId: HH, minMonths: 4, months: 6 });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true, data: { candidates: [], skipped: EMPTY_SKIPPED } });
      expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
      expect(m.editor).not.toHaveBeenCalled();
      expect(m.detect).toHaveBeenCalledWith({ householdId: HH, minMonths: 4, months: 6 });
    });

    it('answers 403 to a non-member before touching the data', async () => {
      m.member.mockRejectedValueOnce(new ForbiddenError());
      expect((await post('/recurring-transactions/detect', { householdId: HH })).statusCode).toBe(403);
      expect(m.detect).not.toHaveBeenCalled();
    });

    it('validates the body: household id, caps and minMonths <= months', async () => {
      for (const body of [
        {},
        { householdId: 'nope' },
        { householdId: HH, minMonths: 1 },
        { householdId: HH, minMonths: 13 },
        { householdId: HH, months: 2 },
        { householdId: HH, months: 37 },
        { householdId: HH, minMonths: 6, months: 5 },
        { householdId: HH, minMonths: 2.5 },
      ]) {
        const res = await post('/recurring-transactions/detect', body);
        expect(res.statusCode, JSON.stringify(body)).toBe(400);
      }
      expect(m.detect).not.toHaveBeenCalled();
    });
  });

  describe('POST /detect/apply', () => {
    const item = { id: 'rc_abc' };

    it('answers 401 without credentials', async () => {
      expect((await post('/recurring-transactions/detect/apply', { householdId: HH, items: [item] }, {})).statusCode).toBe(401);
      expect(m.apply).not.toHaveBeenCalled();
    });

    it('requires EDITOR: a viewer gets 403 and nothing is computed or written', async () => {
      m.editor.mockRejectedValueOnce(new InsufficientRoleError('EDITOR'));
      const res = await post('/recurring-transactions/detect/apply', { householdId: HH, items: [item] });
      expect(res.statusCode).toBe(403);
      expect(m.apply).not.toHaveBeenCalled();
    });

    it('answers 201 with the result in the envelope and passes the adjustments through', async () => {
      const items = [{ id: 'rc_abc', amount: 49.9, dayOfMonth: 12, description: ' Plano ', followLastAmount: false }];
      const res = await post('/recurring-transactions/detect/apply', { householdId: HH, items });
      expect(res.statusCode).toBe(201);
      expect(res.json()).toEqual({ success: true, data: { created: 1, skipped: 0, linkedTransactions: 3, warnings: [] } });
      expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
      expect(m.apply).toHaveBeenCalledWith({
        householdId: HH,
        items: [{ id: 'rc_abc', amount: 49.9, dayOfMonth: 12, description: 'Plano', followLastAmount: false }],
      });
    });

    it('caps and validates the items', async () => {
      const tooMany = Array.from({ length: 301 }, (_, i) => ({ id: `rc_${i}` }));
      for (const body of [
        { householdId: HH, items: [] },
        { householdId: HH },
        { householdId: HH, items: tooMany },
        { householdId: HH, items: [{ id: '' }] },
        { householdId: HH, items: [{ id: 'x'.repeat(65) }] },
        { householdId: HH, items: [{ id: 'a', amount: 0 }] },
        { householdId: HH, items: [{ id: 'a', amount: -5 }] },
        { householdId: HH, items: [{ id: 'a', amount: 2_000_000_000 }] },
        { householdId: HH, items: [{ id: 'a', dayOfMonth: 0 }] },
        { householdId: HH, items: [{ id: 'a', dayOfMonth: 32 }] },
        { householdId: HH, items: [{ id: 'a', dayOfMonth: 1.5 }] },
        { householdId: HH, items: [{ id: 'a', description: '   ' }] },
        { householdId: HH, items: [{ id: 'a', description: 'x'.repeat(256) }] },
        { householdId: HH, items: [{ id: 'a', followLastAmount: 'yes' }] },
        { householdId: HH, items: [item], minMonths: 8, months: 5 },
      ]) {
        const res = await post('/recurring-transactions/detect/apply', body);
        expect(res.statusCode, JSON.stringify(body).slice(0, 80)).toBe(400);
      }
      expect(m.apply).not.toHaveBeenCalled();
      const ok = await post('/recurring-transactions/detect/apply', {
        householdId: HH,
        items: Array.from({ length: 300 }, (_, i) => ({ id: `rc_${i}` })),
      });
      expect(ok.statusCode).toBe(201);
    });
  });
});
