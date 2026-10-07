import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  resetStore,
  rowById,
  rowsOf,
  seedAccount,
  seedRecurrence,
  seedTransaction,
} from './__fixtures__/recurring-fake-db.js';
import { executeRecurringTransaction, listRecurringTransactions } from './recurring-transactions.service.js';
import { fakePrisma } from './__fixtures__/recurring-fake-db.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));

// Invented data only.
const HH = 'hh-1';
const ACC = 'acc-bank';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: ACC, householdId: HH, name: 'Conta Teste', balance: 1000 });
});

const occurrences = (recurringId: string) => rowsOf('transaction').filter((t) => t.recurringTransactionId === recurringId);

describe('executeRecurringTransaction idempotency guard (monthly)', () => {
  it('creates the pending occurrence once and moves the recurrence on', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5), paid: false });
    expect(result.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 100, paid: false, date: '2026-10-05' });
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-11-05', lastRunDate: '2026-10-05' });
  });

  it('does not create a second occurrence for a month that already has one (another day of the month)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 90, date: '2026-10-01', paid: true, recurringTransactionId: rec.id });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 20), paid: false });
    expect(result.skipped).toBe(true);
    expect(occurrences(rec.id)).toHaveLength(1);
    expect(occurrences(rec.id)[0]).toMatchObject({ amount: 90 });
    // The recurrence still moves on, so the cron does not retry it every day.
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ nextRunAt: '2026-11-20', lastRunDate: '2026-10-20' });
  });

  it('is safe to run twice (cron re-run, or the recurrence executed by hand after the cron)', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    const second = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 5) });
    expect(second.skipped).toBe(true);
    expect(occurrences(rec.id)).toHaveLength(1);
  });

  it('still creates the occurrence of another month, and ignores transactions of other recurrences', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-11-05' });
    const other = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Agua', amount: 50, nextRunAt: '2026-11-05' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 90, date: '2026-10-05', recurringTransactionId: rec.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Agua', amount: 50, date: '2026-11-02', recurringTransactionId: other.id });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 10, 5) });
    expect(result.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(2);
  });

  it('reads the month of a stored date (UTC midnight) like the one of a local date', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-01' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 90, date: '2026-10-31', recurringTransactionId: rec.id });
    // No input date: the run date is the stored nextRunAt (UTC midnight of the 1st).
    const result = await executeRecurringTransaction(rec.id, HH, {});
    expect(result.skipped).toBe(true);
  });

  it('does not apply to recurrences that legitimately run several times a month', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Market stall', amount: 40, nextRunAt: '2026-10-12', frequency: 'WEEKLY' });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Market stall', amount: 40, date: '2026-10-05', recurringTransactionId: rec.id });
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 12) });
    expect(result.skipped).toBe(false);
    expect(occurrences(rec.id)).toHaveLength(2);
  });

  it('keeps refusing an inactive recurrence', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05', isActive: false });
    await expect(executeRecurringTransaction(rec.id, HH, {})).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe('execute: the guard runs under the recurrence lock, inside the database transaction', () => {
  it('takes the lock before looking for the month occurrence and before creating anything', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    fakePrisma.$executeRaw.mockClear();
    fakePrisma.transaction.findFirst.mockClear();
    fakePrisma.transaction.create.mockClear();
    await executeRecurringTransaction(rec.id, HH, {});
    const lock = fakePrisma.$executeRaw.mock.invocationCallOrder[0]!;
    expect(lock).toBeLessThan(fakePrisma.transaction.findFirst.mock.invocationCallOrder[0]!);
    expect(lock).toBeLessThan(fakePrisma.transaction.create.mock.invocationCallOrder[0]!);
    expect(String(fakePrisma.$executeRaw.mock.calls[0]![1])).toBe(`recurring:${rec.id}`);
  });
});

describe('listRecurringTransactions: lastOccurrenceDate', () => {
  it('is the latest occurrence date up to today + 31 days, per recurrence, household-scoped', async () => {
    const today = new Date();
    const iso = (offset: number) => {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    };
    const a = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Energia', amount: 100, nextRunAt: iso(40) });
    const b = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Agua', amount: 50, nextRunAt: iso(40) });
    const c = seedRecurrence({ householdId: HH, accountId: ACC, description: 'Sem historico', amount: 10, nextRunAt: iso(40) });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(-60), recurringTransactionId: a.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(-5), recurringTransactionId: a.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(25), recurringTransactionId: a.id });
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Energia', amount: 1, date: iso(90), recurringTransactionId: a.id }); // beyond the limit
    seedTransaction({ householdId: HH, accountId: ACC, description: 'Agua', amount: 1, date: iso(-10), recurringTransactionId: b.id });
    seedTransaction({ householdId: 'hh-2', accountId: ACC, description: 'Agua', amount: 1, date: iso(10), recurringTransactionId: b.id });
    const list = await listRecurringTransactions({ householdId: HH } as never);
    const by = Object.fromEntries(list.map((r) => [r.id, r.lastOccurrenceDate]));
    expect(by).toEqual({ [a.id]: iso(25), [b.id]: iso(-10), [c.id]: null });
  });
});
