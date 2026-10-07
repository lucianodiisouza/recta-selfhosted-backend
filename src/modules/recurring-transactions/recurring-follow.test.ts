import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { transactionRoutes } from '../transactions/transactions.routes.js';
import * as transactionsService from '../transactions/transactions.service.js';
import {
  fakePrisma,
  fakeServices,
  resetStore,
  rowById,
  seedAccount,
  seedRecurrence,
  seedTransaction,
} from './__fixtures__/recurring-fake-db.js';
import { followLastAmountInTx } from './recurring-follow.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
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
vi.mock('../transactions/transactions.service.js', () => ({
  getTransaction: vi.fn(),
  updateTransaction: vi.fn(),
}));

// Invented data only.
const HH = 'hh-1';
const ACC = 'acc-bank';
const NOW = new Date(2026, 9, 5, 12, 0, 0); // 2026-10-05

function before(tx: ReturnType<typeof seedTransaction>) {
  return {
    id: tx.id,
    householdId: HH,
    recurringTransactionId: tx.recurringTransactionId as string | null,
    date: new Date(`${tx.date}T00:00:00.000Z`),
    amount: tx.amount as number,
  };
}

function setup(followLastAmount = true) {
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
  const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-11-05', followLastAmount });
  const occ = (date: string, extra: Partial<Parameters<typeof seedTransaction>[0]> = {}) =>
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, date, paid: false, recurringTransactionId: rec.id, ...extra });
  return { rec, occ };
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  fakeServices.reset();
});

describe('followLastAmountInTx', () => {
  it('updates the recurrence when the edited transaction is its most recent occurrence', async () => {
    const { rec, occ } = setup();
    occ('2026-08-05', { paid: true });
    occ('2026-09-05', { paid: true });
    const latest = occ('2026-10-05');
    const result = await followLastAmountInTx(fakePrisma as never, before(latest), { amount: 132.4 }, NOW);
    expect(result).toEqual({ id: rec.id, amount: 132.4 });
    expect(rowById('recurringTransaction', rec.id).amount).toBe(132.4);
  });

  it('leaves the recurrence alone when an older occurrence is edited', async () => {
    const { rec, occ } = setup();
    const old = occ('2026-09-05', { paid: true });
    occ('2026-10-05');
    expect(await followLastAmountInTx(fakePrisma as never, before(old), { amount: 80 }, NOW)).toBeNull();
    expect(rowById('recurringTransaction', rec.id).amount).toBe(100);
  });

  it('does nothing when the recurrence does not follow, is paused, or the amount is not being changed', async () => {
    const off = setup(false);
    const a = off.occ('2026-10-05');
    expect(await followLastAmountInTx(fakePrisma as never, before(a), { amount: 90 }, NOW)).toBeNull();

    resetStore();
    const paused = setup();
    rowById('recurringTransaction', paused.rec.id).isActive = false;
    const b = paused.occ('2026-10-05');
    expect(await followLastAmountInTx(fakePrisma as never, before(b), { amount: 90 }, NOW)).toBeNull();

    resetStore();
    const same = setup();
    const c = same.occ('2026-10-05');
    expect(await followLastAmountInTx(fakePrisma as never, before(c), {}, NOW)).toBeNull();
    expect(await followLastAmountInTx(fakePrisma as never, before(c), { amount: 100 }, NOW)).toBeNull();
    expect(await followLastAmountInTx(fakePrisma as never, { ...before(c), recurringTransactionId: null }, { amount: 90 }, NOW)).toBeNull();
  });

  it('counts occurrences up to today + 31 days: a farther one neither is eligible nor blocks', async () => {
    const { rec, occ } = setup();
    const current = occ('2026-10-05');
    const nextMonth = occ('2026-11-04'); // within 31 days of 2026-10-05
    occ('2026-12-20'); // beyond the limit: ignored
    expect(await followLastAmountInTx(fakePrisma as never, before(current), { amount: 90 }, NOW)).toBeNull();
    expect(await followLastAmountInTx(fakePrisma as never, before(nextMonth), { amount: 90 }, NOW)).toEqual({ id: rec.id, amount: 90 });
    const far = seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, date: '2026-12-20', recurringTransactionId: rec.id });
    expect(await followLastAmountInTx(fakePrisma as never, before(far), { amount: 70 }, NOW)).toBeNull();
  });

  it('does not overwrite a recurrence edited by hand when the update leaves the occurrence amount as it was', async () => {
    const { rec, occ } = setup();
    const latest = occ('2026-10-05');
    rowById('recurringTransaction', rec.id).amount = 120; // the user raised the recurrence itself
    expect(await followLastAmountInTx(fakePrisma as never, before(latest), { amount: 100 }, NOW)).toBeNull();
    expect(await followLastAmountInTx(fakePrisma as never, before(latest), { amount: 100.004 }, NOW)).toBeNull();
    expect(rowById('recurringTransaction', rec.id).amount).toBe(120);
    // A real change of the occurrence still goes through.
    expect(await followLastAmountInTx(fakePrisma as never, before(latest), { amount: 95 }, NOW)).toEqual({ id: rec.id, amount: 95 });
  });

  it('never follows a non-positive amount (a refund or a mistake is not the next price)', async () => {
    const { rec, occ } = setup();
    const latest = occ('2026-10-05');
    expect(await followLastAmountInTx(fakePrisma as never, before(latest), { amount: -50 }, NOW)).toBeNull();
    expect(await followLastAmountInTx(fakePrisma as never, before(latest), { amount: 0 }, NOW)).toBeNull();
    expect(rowById('recurringTransaction', rec.id).amount).toBe(100);
  });

  it('judges by the date the occurrence will have after the edit', async () => {
    const { rec, occ } = setup();
    const a = occ('2026-09-05');
    occ('2026-10-05');
    expect(await followLastAmountInTx(fakePrisma as never, before(a), { amount: 60, date: new Date(2026, 9, 20) }, NOW)).toEqual({ id: rec.id, amount: 60 });
  });

  it('never touches a recurrence of another household', async () => {
    const { rec, occ } = setup();
    const latest = occ('2026-10-05');
    expect(await followLastAmountInTx(fakePrisma as never, { ...before(latest), householdId: 'hh-2' }, { amount: 90 }, NOW)).toBeNull();
    expect(rowById('recurringTransaction', rec.id).amount).toBe(100);
  });
});

describe('PATCH /transactions/:transactionId with a recurrence that follows the last amount', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(transactionRoutes, { prefix: '/transactions' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  const TX_ID = '11111111-1111-4111-8111-111111111111';

  beforeEach(() => {
    vi.mocked(requireEditor).mockResolvedValue({} as never);
    vi.mocked(transactionsService.getTransaction).mockImplementation((async (id: string) => {
      const row = rowById('transaction', id);
      return { ...row, amount: row.amount, date: new Date(`${row.date}T00:00:00.000Z`) };
    }) as never);
    vi.mocked(transactionsService.updateTransaction).mockImplementation(((id: string, hh: string, input: never, hooks: never) =>
      fakeServices.updateTransaction(id, hh, input, hooks)) as never);
  });

  const patch = (id: string, payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/transactions/${id}`, payload: payload as never, headers: { authorization: 'Bearer t' } });

  it('confirms the latest occurrence with another amount: updates the recurrence and says so', async () => {
    const { rec, occ } = setup();
    const latest = occ(new Date().toISOString().slice(0, 10));
    latest.id = TX_ID;
    const res = await patch(TX_ID, { amount: 143.7, paid: true });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.recurringUpdated).toEqual({ id: rec.id, amount: 143.7 });
    expect(rowById('recurringTransaction', rec.id).amount).toBe(143.7);
    // The transaction itself went through the transactions service: paid, new amount, balance moved once.
    expect(rowById('transaction', TX_ID)).toMatchObject({ amount: 143.7, paid: true });
    expect(rowById('account', ACC).balance).toBe(856.3);
  });

  it('changes nothing in the recurrence for an older occurrence, and the answer carries no notice', async () => {
    const { rec, occ } = setup();
    const today = new Date().toISOString().slice(0, 10);
    const old = occ('2020-01-05', { paid: true });
    old.id = TX_ID;
    occ(today);
    const res = await patch(TX_ID, { amount: 10 });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).not.toHaveProperty('recurringUpdated');
    expect(rowById('recurringTransaction', rec.id).amount).toBe(100);
  });
});
