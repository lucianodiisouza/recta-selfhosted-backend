import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, InsufficientRoleError, NotFoundError, UnauthorizedError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { peopleRoutes, settlementRoutes, transactionSharesRoutes } from './people.routes.js';
import {
  createPerson,
  deletePerson,
  findPersonHousehold,
  getLedger,
  listBalances,
  listPeople,
  updatePerson,
} from './people.service.js';
import { createSettlement, deleteSettlement, findSettlementHousehold, listSettlements } from './settlements.service.js';
import {
  findTransactionHousehold,
  getTransactionShares,
  previewTransactionShares,
  putTransactionShares,
} from './shares.service.js';

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
}));
vi.mock('./people.service.js', () => ({
  createPerson: vi.fn(),
  deletePerson: vi.fn(),
  findPersonHousehold: vi.fn(),
  getLedger: vi.fn(),
  listBalances: vi.fn(),
  listPeople: vi.fn(),
  updatePerson: vi.fn(),
}));
vi.mock('./settlements.service.js', () => ({
  createSettlement: vi.fn(),
  deleteSettlement: vi.fn(),
  findSettlementHousehold: vi.fn(),
  listSettlements: vi.fn(),
}));
vi.mock('./shares.service.js', () => ({
  findTransactionHousehold: vi.fn(),
  getTransactionShares: vi.fn(),
  previewTransactionShares: vi.fn(),
  putTransactionShares: vi.fn(),
}));

const HH = '11111111-1111-4111-8111-111111111111';
const PERSON = '22222222-2222-4222-8222-222222222222';
const TX = '33333333-3333-4333-8333-333333333333';
const SETTLEMENT = '44444444-4444-4444-8444-444444444444';
const ACCOUNT = '55555555-5555-4555-8555-555555555555';
const AUTH = { authorization: 'Bearer test' };

const m = {
  editor: vi.mocked(requireEditor),
  member: vi.mocked(requireHouseholdMember),
  createPerson: vi.mocked(createPerson),
  deletePerson: vi.mocked(deletePerson),
  personHousehold: vi.mocked(findPersonHousehold),
  getLedger: vi.mocked(getLedger),
  listBalances: vi.mocked(listBalances),
  listPeople: vi.mocked(listPeople),
  updatePerson: vi.mocked(updatePerson),
  createSettlement: vi.mocked(createSettlement),
  deleteSettlement: vi.mocked(deleteSettlement),
  settlementHousehold: vi.mocked(findSettlementHousehold),
  listSettlements: vi.mocked(listSettlements),
  transactionHousehold: vi.mocked(findTransactionHousehold),
  getShares: vi.mocked(getTransactionShares),
  previewShares: vi.mocked(previewTransactionShares),
  putShares: vi.mocked(putTransactionShares),
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(peopleRoutes, { prefix: '/people' });
  await app.register(transactionSharesRoutes, { prefix: '/transactions' });
  await app.register(settlementRoutes, { prefix: '/settlements' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.resetAllMocks();
  m.editor.mockResolvedValue({} as never);
  m.member.mockResolvedValue({} as never);
});

function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = AUTH) {
  return app.inject({ method, url, payload: payload as never, headers });
}

const putBody = { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: PERSON }] };
const settlementBody = { householdId: HH, direction: 'RECEIVED', amount: 10, date: '2026-10-05' };

// Every route, with a valid request and what it needs: 'editor' or 'member' on the household
const ROUTES: Array<{ name: string; method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; url: string; body?: unknown; access: 'editor' | 'member' }> = [
  { name: 'list people', method: 'GET', url: `/people?householdId=${HH}`, access: 'member' },
  { name: 'create person', method: 'POST', url: '/people', body: { householdId: HH, name: 'Bia' }, access: 'editor' },
  { name: 'balances', method: 'GET', url: `/people/balances?householdId=${HH}`, access: 'member' },
  { name: 'ledger', method: 'GET', url: `/people/${PERSON}/ledger?householdId=${HH}`, access: 'member' },
  { name: 'list settlements', method: 'GET', url: `/people/${PERSON}/settlements?householdId=${HH}`, access: 'member' },
  { name: 'create settlement', method: 'POST', url: `/people/${PERSON}/settlements`, body: settlementBody, access: 'editor' },
  { name: 'update person', method: 'PATCH', url: `/people/${PERSON}?householdId=${HH}`, body: { name: 'Bia' }, access: 'editor' },
  { name: 'delete person', method: 'DELETE', url: `/people/${PERSON}?householdId=${HH}`, access: 'editor' },
  { name: 'get shares', method: 'GET', url: `/transactions/${TX}/shares?householdId=${HH}`, access: 'member' },
  { name: 'put shares', method: 'PUT', url: `/transactions/${TX}/shares?householdId=${HH}`, body: putBody, access: 'editor' },
  { name: 'preview shares', method: 'POST', url: `/transactions/${TX}/shares/preview?householdId=${HH}`, body: putBody, access: 'member' },
  { name: 'delete settlement', method: 'DELETE', url: `/settlements/${SETTLEMENT}?householdId=${HH}`, access: 'editor' },
];

describe('authentication and authorization', () => {
  it.each(ROUTES)('$name: 401 without credentials, and nothing runs', async ({ method, url, body }) => {
    const res = await call(method, url, body, {});
    expect(res.statusCode).toBe(401);
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.member).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$name: authorizes the household before touching any data', async ({ method, url, body, access }) => {
    m.editor.mockRejectedValue(new InsufficientRoleError());
    m.member.mockRejectedValue(new ForbiddenError());
    // Reads reject members only; writes reject non-editors
    if (access === 'member') m.editor.mockResolvedValue({} as never);

    const res = await call(method, url, body);

    expect(res.statusCode).toBe(403);
    const anyService = [
      m.createPerson, m.deletePerson, m.getLedger, m.listBalances, m.listPeople, m.updatePerson, m.createSettlement,
      m.deleteSettlement, m.listSettlements, m.getShares, m.previewShares, m.putShares,
    ];
    for (const service of anyService) expect(service).not.toHaveBeenCalled();
    expect(m.editor.mock.calls.length + m.member.mock.calls.length).toBeGreaterThan(0);
    expect(access === 'editor' ? m.editor : m.member).toHaveBeenCalledWith(expect.anything(), HH);
  });

  it.each(ROUTES.filter((r) => r.access === 'editor'))('$name: a member who cannot edit is refused', async ({ method, url, body }) => {
    m.editor.mockRejectedValue(new InsufficientRoleError());
    const res = await call(method, url, body);
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'INSUFFICIENT_ROLE' } });
  });

  it('answers 403 before a data-dependent 404 or 409: the household is checked first', async () => {
    m.editor.mockRejectedValue(new ForbiddenError());
    m.updatePerson.mockRejectedValue(new NotFoundError('Person'));
    const res = await call('PATCH', `/people/${PERSON}?householdId=${HH}`, { name: 'x' });
    expect(res.statusCode).toBe(403);
    expect(m.updatePerson).not.toHaveBeenCalled();
  });
});

describe('routes keyed by an id alone', () => {
  it('resolve the household from the record, authorize it, then call the service scoped to it', async () => {
    m.personHousehold.mockResolvedValue(HH);
    m.updatePerson.mockResolvedValue({ id: PERSON } as never);

    const res = await call('PATCH', `/people/${PERSON}`, { name: 'Bia' });

    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.updatePerson).toHaveBeenCalledWith(HH, PERSON, { name: 'Bia' });
  });

  it('answer 404 for an id that does not exist, and the same 404 when the record belongs to a household the caller is not in', async () => {
    m.personHousehold.mockResolvedValue(null);
    const missing = await call('PATCH', `/people/${PERSON}`, { name: 'Bia' });

    m.personHousehold.mockResolvedValue(HH);
    m.member.mockRejectedValue(new ForbiddenError());
    const foreign = await call('PATCH', `/people/${PERSON}`, { name: 'Bia' });

    expect(missing.statusCode).toBe(404);
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json().error).toMatchObject({ code: 'NOT_FOUND', message: missing.json().error.message });
    expect(m.updatePerson).not.toHaveBeenCalled();
    expect(m.editor).not.toHaveBeenCalled();
  });

  it('a member who cannot edit gets 403 (not 404): they can see the record', async () => {
    m.personHousehold.mockResolvedValue(HH);
    m.editor.mockRejectedValue(new InsufficientRoleError());
    const res = await call('DELETE', `/people/${PERSON}`);
    expect(res.statusCode).toBe(403);
    expect(m.deletePerson).not.toHaveBeenCalled();
  });

  it('with a householdId hint, the hint is authorized and no lookup is made', async () => {
    m.deletePerson.mockResolvedValue({ deleted: true });
    const res = await call('DELETE', `/people/${PERSON}?householdId=${HH}`);
    expect(res.statusCode).toBe(204);
    expect(m.personHousehold).not.toHaveBeenCalled();
    expect(m.deletePerson).toHaveBeenCalledWith(HH, PERSON);
  });

  it('a settlement with a householdId hint is authorized the same way, without a lookup', async () => {
    m.deleteSettlement.mockResolvedValue(undefined);
    const res = await call('DELETE', `/settlements/${SETTLEMENT}?householdId=${HH}`);
    expect(res.statusCode).toBe(204);
    expect(m.settlementHousehold).not.toHaveBeenCalled();
    expect(m.deleteSettlement).toHaveBeenCalledWith(HH, SETTLEMENT);
  });

  it('settlements and transaction shares resolve their household the same way', async () => {
    m.settlementHousehold.mockResolvedValue(HH);
    m.transactionHousehold.mockResolvedValue(HH);
    m.getShares.mockResolvedValue({ transactionId: TX } as never);
    m.putShares.mockResolvedValue({ transactionId: TX } as never);
    m.previewShares.mockResolvedValue({ shares: [], myPart: 1 });

    expect((await call('DELETE', `/settlements/${SETTLEMENT}`)).statusCode).toBe(204);
    expect((await call('GET', `/transactions/${TX}/shares`)).statusCode).toBe(200);
    expect((await call('PUT', `/transactions/${TX}/shares`, putBody)).statusCode).toBe(200);
    expect((await call('POST', `/transactions/${TX}/shares/preview`, putBody)).statusCode).toBe(200);
    expect(m.deleteSettlement).toHaveBeenCalledWith(HH, SETTLEMENT);
    expect(m.getShares).toHaveBeenCalledWith(HH, TX);
    expect(m.putShares).toHaveBeenCalledWith(HH, TX, putBody);
    expect(m.previewShares).toHaveBeenCalledWith(HH, TX, putBody);
    // reads need membership, the write needs an editor
    expect(m.editor).toHaveBeenCalledTimes(2);
  });

  it('answers 404 for a transaction or settlement that does not exist', async () => {
    m.transactionHousehold.mockResolvedValue(null);
    m.settlementHousehold.mockResolvedValue(null);
    expect((await call('GET', `/transactions/${TX}/shares`)).statusCode).toBe(404);
    expect((await call('DELETE', `/settlements/${SETTLEMENT}`)).statusCode).toBe(404);
  });
});

describe('responses', () => {
  it('lists people, parsing includeInactive', async () => {
    m.listPeople.mockResolvedValue([{ id: PERSON }] as never);
    const res = await call('GET', `/people?householdId=${HH}&includeInactive=true`);
    expect(res.json()).toEqual({ success: true, data: [{ id: PERSON }] });
    expect(m.listPeople).toHaveBeenCalledWith(HH, true);

    await call('GET', `/people?householdId=${HH}`);
    expect(m.listPeople).toHaveBeenLastCalledWith(HH, false);
  });

  it('creates a person (201)', async () => {
    m.createPerson.mockResolvedValue({ id: PERSON, name: 'Bia' } as never);
    const res = await call('POST', '/people', { householdId: HH, name: '  Bia  ', aliases: ['B'] });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ success: true, data: { id: PERSON, name: 'Bia' } });
    expect(m.createPerson).toHaveBeenCalledWith({ householdId: HH, name: 'Bia', aliases: ['B'] });
  });

  it('answers a conflict as 409', async () => {
    const { ConflictError } = await import('../../shared/errors/app-error.js');
    m.createPerson.mockRejectedValue(new ConflictError('"Bia" is already used by another person'));
    const res = await call('POST', '/people', { householdId: HH, name: 'Bia' });
    expect(res.statusCode).toBe(409);
  });

  it('deleting a person answers 204 when removed and 200 with the person when only deactivated', async () => {
    m.personHousehold.mockResolvedValue(HH);
    m.deletePerson.mockResolvedValueOnce({ deleted: true });
    const removed = await call('DELETE', `/people/${PERSON}`);
    expect(removed.statusCode).toBe(204);
    expect(removed.body).toBe('');

    m.deletePerson.mockResolvedValueOnce({ deleted: false, person: { id: PERSON, isActive: false } as never });
    const kept = await call('DELETE', `/people/${PERSON}`);
    expect(kept.statusCode).toBe(200);
    expect(kept.json()).toEqual({ success: true, data: { id: PERSON, isActive: false } });
  });

  it('serves the ledger with its pagination beside the data, with defaults', async () => {
    m.getLedger.mockResolvedValue({ data: [], pagination: { nextCursor: null, hasMore: false, total: 0 } });
    const res = await call('GET', `/people/${PERSON}/ledger?householdId=${HH}`);
    expect(res.json()).toEqual({ success: true, data: [], pagination: { nextCursor: null, hasMore: false, total: 0 } });
    expect(m.getLedger).toHaveBeenCalledWith(HH, PERSON, { limit: 50, cursor: undefined, order: 'desc' });

    await call('GET', `/people/${PERSON}/ledger?householdId=${HH}&limit=10&cursor=share:abc&order=asc`);
    expect(m.getLedger).toHaveBeenLastCalledWith(HH, PERSON, { limit: 10, cursor: 'share:abc', order: 'asc' });
  });

  it('serves balances and settlements wrapped in { success, data }', async () => {
    m.listBalances.mockResolvedValue([] as never);
    m.listSettlements.mockResolvedValue([] as never);
    m.createSettlement.mockResolvedValue({ id: SETTLEMENT } as never);

    expect((await call('GET', `/people/balances?householdId=${HH}`)).json()).toEqual({ success: true, data: [] });
    expect((await call('GET', `/people/${PERSON}/settlements?householdId=${HH}`)).json()).toEqual({ success: true, data: [] });
    const created = await call('POST', `/people/${PERSON}/settlements`, settlementBody);
    expect(created.statusCode).toBe(201);
    expect(m.createSettlement).toHaveBeenCalledWith(HH, PERSON, settlementBody);
  });
});

describe('validation: every string and list is capped', () => {
  const bad = (name: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown) => ({ name, method, url, body });

  const CASES = [
    bad('not a uuid household', 'GET', '/people?householdId=nope'),
    bad('missing household', 'GET', '/people'),
    bad('name too long', 'POST', '/people', { householdId: HH, name: 'x'.repeat(101) }),
    bad('empty name', 'POST', '/people', { householdId: HH, name: '   ' }),
    bad('too many aliases', 'POST', '/people', { householdId: HH, name: 'Bia', aliases: Array.from({ length: 21 }, (_, i) => `a${i}`) }),
    bad('alias too long', 'POST', '/people', { householdId: HH, name: 'Bia', aliases: ['x'.repeat(101)] }),
    bad('nothing to update', 'PATCH', `/people/${PERSON}?householdId=${HH}`, {}),
    bad('person id not a uuid', 'PATCH', '/people/not-a-uuid?householdId=' + HH, { name: 'x' }),
    bad('ledger limit above the cap', 'GET', `/people/${PERSON}/ledger?householdId=${HH}&limit=201`),
    bad('ledger limit zero', 'GET', `/people/${PERSON}/ledger?householdId=${HH}&limit=0`),
    bad('ledger cursor too long', 'GET', `/people/${PERSON}/ledger?householdId=${HH}&cursor=${'c'.repeat(101)}`),
    bad('ledger bad order', 'GET', `/people/${PERSON}/ledger?householdId=${HH}&order=sideways`),
    bad('shares: too many entries', 'PUT', `/transactions/${TX}/shares?householdId=${HH}`, {
      ...putBody,
      entries: Array.from({ length: 51 }, () => ({ personId: PERSON })),
    }),
    bad('shares: unknown strategy', 'PUT', `/transactions/${TX}/shares?householdId=${HH}`, { ...putBody, strategy: 'random' }),
    bad('shares: unknown direction', 'PUT', `/transactions/${TX}/shares?householdId=${HH}`, { ...putBody, direction: 'SIDEWAYS' }),
    bad('shares: negative amount', 'PUT', `/transactions/${TX}/shares?householdId=${HH}`, { ...putBody, entries: [{ personId: PERSON, amount: -1 }] }),
    bad('shares: percent over 100', 'PUT', `/transactions/${TX}/shares?householdId=${HH}`, { ...putBody, entries: [{ personId: PERSON, percent: 101 }] }),
    bad('shares: fractional shares', 'PUT', `/transactions/${TX}/shares?householdId=${HH}`, { ...putBody, entries: [{ personId: PERSON, shares: 1.5 }] }),
    bad('shares: note too long', 'PUT', `/transactions/${TX}/shares?householdId=${HH}`, { ...putBody, entries: [{ personId: PERSON, note: 'n'.repeat(501) }] }),
    bad('shares: huge myShares', 'POST', `/transactions/${TX}/shares/preview?householdId=${HH}`, { ...putBody, myShares: 1001 }),
    bad('settlement: zero amount', 'POST', `/people/${PERSON}/settlements`, { ...settlementBody, amount: 0 }),
    bad('settlement: amount above the cap', 'POST', `/people/${PERSON}/settlements`, { ...settlementBody, amount: 1_000_000_001 }),
    bad('settlement: impossible date', 'POST', `/people/${PERSON}/settlements`, { ...settlementBody, date: '2026-02-30' }),
    bad('settlement: not a date', 'POST', `/people/${PERSON}/settlements`, { ...settlementBody, date: 'yesterday' }),
    bad('settlement: note too long', 'POST', `/people/${PERSON}/settlements`, { ...settlementBody, note: 'n'.repeat(501) }),
    bad('settlement: both a link and a creation', 'POST', `/people/${PERSON}/settlements`, {
      ...settlementBody,
      transactionId: TX,
      createTransaction: { accountId: ACCOUNT },
    }),
    bad('settlement: bad category', 'POST', `/people/${PERSON}/settlements`, { ...settlementBody, createTransaction: { accountId: ACCOUNT, categoryName: 'nope' } }),
  ];

  it.each(CASES)('$name -> 400 and no service call', async ({ method, url, body }) => {
    const res = await call(method, url, body);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(m.createPerson).not.toHaveBeenCalled();
    expect(m.putShares).not.toHaveBeenCalled();
    expect(m.createSettlement).not.toHaveBeenCalled();
    expect(m.getLedger).not.toHaveBeenCalled();
  });

  it('accepts a split at the cap of 50 people', async () => {
    m.transactionHousehold.mockResolvedValue(HH);
    m.putShares.mockResolvedValue({ transactionId: TX } as never);
    const res = await call('PUT', `/transactions/${TX}/shares`, {
      ...putBody,
      entries: Array.from({ length: 50 }, () => ({ personId: PERSON })),
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('unauthenticated errors keep the standard envelope', () => {
  it('401 has the error shape', async () => {
    const res = await call('GET', `/people?householdId=${HH}`, undefined, {});
    expect(res.json()).toMatchObject({ success: false, error: { code: 'UNAUTHORIZED' } });
    expect(new UnauthorizedError().statusCode).toBe(401);
  });
});
