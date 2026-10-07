import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InsufficientRoleError, NotFoundError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { categoryRoutes } from './categories.routes.js';
import { findSourceHousehold, mergeCategory } from './categories.merge.service.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  // Unauthenticated unless the request carries a bearer header
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('../../shared/db/prisma.js', () => ({ prisma: {} }));
vi.mock('./categories.service.js', () => ({}));
vi.mock('./categories.merge.service.js', () => ({
  findSourceHousehold: vi.fn(),
  mergeCategory: vi.fn(),
}));

const HH = '11111111-1111-4111-8111-111111111111';
const SRC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const AUTH = { authorization: 'Bearer test' };

const m = {
  editor: vi.mocked(requireEditor),
  household: vi.mocked(findSourceHousehold),
  merge: vi.mocked(mergeCategory),
};

const RESULT = {
  preview: false,
  sourceId: SRC,
  sourceName: 'Source',
  type: 'EXPENSE',
  target: { id: DST, name: 'Target', isSystem: false },
  counts: { transactions: 2, recurringTransactions: 1, budgets: 0, budgetsCombined: 0 },
};

describe('POST /categories/:categoryId/merge', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(categoryRoutes, { prefix: '/categories' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.resetAllMocks();
    m.household.mockResolvedValue(HH);
    m.editor.mockResolvedValue({} as never);
    m.merge.mockResolvedValue(RESULT as never);
  });

  const post = (url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'POST', url, payload: payload as never, headers });

  it('answers 401 without credentials, before anything is looked up', async () => {
    expect((await post(`/categories/${SRC}/merge`, { targetCategoryId: DST }, {})).statusCode).toBe(401);
    expect(m.household).not.toHaveBeenCalled();
    expect(m.merge).not.toHaveBeenCalled();
  });

  it('asks for EDITOR on the household that owns the SOURCE, and merges inside that household only', async () => {
    const res = await post(`/categories/${SRC}/merge`, { targetCategoryId: DST });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: RESULT });
    expect(m.household).toHaveBeenCalledWith(SRC);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.merge).toHaveBeenCalledWith(HH, { sourceId: SRC, targetCategoryId: DST, targetSystemName: undefined, preview: false });
  });

  it('never merges when the user is not an editor of that household', async () => {
    m.editor.mockRejectedValueOnce(new InsufficientRoleError());

    const res = await post(`/categories/${SRC}/merge`, { targetCategoryId: DST });

    expect(res.statusCode).toBe(403);
    expect(m.merge).not.toHaveBeenCalled();
  });

  it('answers 404 for a source that does not exist (anymore) and does not touch authorization', async () => {
    m.household.mockResolvedValueOnce(null);

    const res = await post(`/categories/${SRC}/merge`, { targetCategoryId: DST });

    expect(res.statusCode).toBe(404);
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.merge).not.toHaveBeenCalled();
  });

  it('passes preview=true through as a preview and nothing else', async () => {
    await post(`/categories/${SRC}/merge?preview=true`, { targetSystemName: 'FOOD' });

    expect(m.merge).toHaveBeenCalledWith(HH, { sourceId: SRC, targetCategoryId: undefined, targetSystemName: 'FOOD', preview: true });
  });

  it('refuses a body that names no target, both targets, or a system name that does not exist', async () => {
    for (const body of [{}, { targetCategoryId: DST, targetSystemName: 'FOOD' }, { targetSystemName: 'NOT_A_CATEGORY' }, { targetCategoryId: 'not-a-uuid' }]) {
      const res = await post(`/categories/${SRC}/merge`, body);
      expect(res.statusCode, JSON.stringify(body)).toBe(400);
    }
    expect(m.merge).not.toHaveBeenCalled();
  });

  it('refuses a source id that is not a uuid before looking it up', async () => {
    const res = await post('/categories/not-a-uuid/merge', { targetCategoryId: DST });

    expect(res.statusCode).toBe(400);
    expect(m.household).not.toHaveBeenCalled();
  });

  it('forwards the 404 of the service (target of another household, or source already merged)', async () => {
    m.merge.mockRejectedValueOnce(new NotFoundError('Target category'));

    const res = await post(`/categories/${SRC}/merge`, { targetCategoryId: DST });

    expect(res.statusCode).toBe(404);
  });
});
