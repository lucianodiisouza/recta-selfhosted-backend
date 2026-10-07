import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '../../shared/errors/error-handler.js';
import { categoryRoutes } from './categories.routes.js';
import * as categoriesService from './categories.service.js';

const db = vi.hoisted(() => ({ findFirst: vi.fn() }));

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(async () => '11111111-1111-4111-8111-111111111111'),
  getUserByFirebaseUid: vi.fn(async () => ({ id: 'u1' })),
}));
vi.mock('../../shared/db/prisma.js', () => ({ prisma: { category: { findFirst: db.findFirst } } }));
vi.mock('./categories.service.js', () => ({ createCategory: vi.fn(), updateCategory: vi.fn() }));
vi.mock('./categories.merge.service.js', () => ({ findSourceHousehold: vi.fn(), mergeCategory: vi.fn() }));

const HH = '11111111-1111-4111-8111-111111111111';
const CAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const stored = { id: CAT, householdId: HH, name: 'Test Voucher', type: 'EXPENSE', color: '#112233', icon: null };

// The response schema of these routes used to declare an empty `data` object, which the serializer turns into `{}`: the
// client got `{ success: true, data: {} }` instead of the category. These tests read what actually goes over the wire.
describe('category responses carry the category', () => {
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
    vi.clearAllMocks();
    vi.mocked(categoriesService.createCategory).mockResolvedValue(stored as never);
    vi.mocked(categoriesService.updateCategory).mockResolvedValue({ ...stored, name: 'Renamed' } as never);
    db.findFirst.mockResolvedValue({ householdId: HH });
  });

  it('POST /categories returns the created category', async () => {
    const res = await app.inject({ method: 'POST', url: '/categories', payload: { name: 'Test Voucher', type: 'EXPENSE', householdId: HH } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ id: CAT, householdId: HH, name: 'Test Voucher', type: 'EXPENSE', color: '#112233', icon: null, isSystem: false });
  });

  it('PATCH /categories/:id returns the updated category', async () => {
    const res = await app.inject({ method: 'PATCH', url: `/categories/${CAT}`, payload: { name: 'Renamed' } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: CAT, name: 'Renamed', isSystem: false });
  });

  it('GET /categories/:id returns a system category', async () => {
    const res = await app.inject({ method: 'GET', url: '/categories/FOOD' });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toMatchObject({ id: 'FOOD', type: 'EXPENSE', isSystem: true });
  });
});
