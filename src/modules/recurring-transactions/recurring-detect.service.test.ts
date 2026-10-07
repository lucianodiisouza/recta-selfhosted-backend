import { beforeEach, describe, expect, it, vi } from 'vitest';

import { applyDetectedRecurrences, detectRecurringTransactions } from './recurring-detect.service.js';
import {
  fakePrisma,
  resetStore,
  rowById,
  rowsOf,
  seedAccount,
  seedRecurrence,
  seedTransaction,
} from './__fixtures__/recurring-fake-db.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/recurring-fake-db.js')).fakePrisma,
}));

// Invented data only.
const HH = 'hh-1';
const OTHER_HH = 'hh-2';
const CARD = 'acc-card';
const BANK = 'acc-bank';
const NOW = new Date(2026, 9, 5, 12, 0, 0); // 2026-10-05

const day = (month: number, d = 1) => `2026-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function seedSeries(
  description: string,
  months: number[],
  amount: number | ((m: number) => number),
  extra: Partial<Parameters<typeof seedTransaction>[0]> = {},
  d = 3,
) {
  return months.map((m) =>
    seedTransaction({
      householdId: HH,
      accountId: CARD,
      description,
      amount: typeof amount === 'function' ? amount(m) : amount,
      date: day(m, d),
      categoryName: 'SUBSCRIPTIONS',
      ...extra,
    }),
  );
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', balance: 100 });
  seedAccount({ id: BANK, householdId: HH, name: 'Conta Teste', balance: 500 });
});

describe('detectRecurringTransactions', () => {
  it('detects from the household history, with the contract shape and nothing internal', async () => {
    seedSeries('Streaming Alfa', [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 21.9);
    const response = await detectRecurringTransactions({ householdId: HH }, NOW);
    expect(response.skipped).toEqual({ alreadyRecurring: 0, installments: 0, sparse: 0, consumption: 0 });
    expect(response.candidates).toHaveLength(1);
    expect(response.candidates[0]).toMatchObject({ description: 'Streaming Alfa', accountName: 'Cartao Teste', kind: 'stable', amount: 21.9, followLastAmount: true });
    expect(Object.keys(response.candidates[0]!).sort()).toEqual(
      [
        'accountId', 'accountName', 'amount', 'categoryName', 'confidence', 'dayOfMonth', 'defaultSelected', 'description',
        'examples', 'followLastAmount', 'id', 'kind', 'lastMonth', 'maxAmount', 'medianAmount', 'minAmount', 'monthsSeen', 'windowMonths',
      ].sort(),
    );
  });

  it('never reads another household', async () => {
    seedAccount({ id: 'acc-other', householdId: OTHER_HH, name: 'Outra', balance: 0 });
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, { householdId: OTHER_HH, accountId: 'acc-other' });
    expect((await detectRecurringTransactions({ householdId: HH }, NOW)).candidates).toEqual([]);
    expect((await detectRecurringTransactions({ householdId: OTHER_HH }, NOW)).candidates).toHaveLength(1);
  });

  it('ignores accounts that are no longer active and an empty household', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    rowById('account', CARD).isActive = false;
    expect((await detectRecurringTransactions({ householdId: HH }, NOW)).candidates).toEqual([]);
    expect((await detectRecurringTransactions({ householdId: 'hh-empty' }, NOW)).candidates).toEqual([]);
  });

  it('leaves out what an active recurrence covers but not a paused one', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    const paused = seedRecurrence({ householdId: HH, accountId: CARD, description: 'Streaming Alfa', amount: 21.9, nextRunAt: day(11), isActive: false });
    expect((await detectRecurringTransactions({ householdId: HH }, NOW)).candidates).toHaveLength(1);
    rowById('recurringTransaction', paused.id).isActive = true;
    const response = await detectRecurringTransactions({ householdId: HH }, NOW);
    expect(response.candidates).toEqual([]);
    expect(response.skipped.alreadyRecurring).toBe(1);
  });
});

describe('applyDetectedRecurrences', () => {
  async function candidateId(description: string) {
    const response = await detectRecurringTransactions({ householdId: HH }, NOW);
    return response.candidates.find((c) => c.description === description)!.id;
  }

  it('creates a MONTHLY recurrence from the candidate, starting at the next uncovered month on its day', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, {}, 3);
    const id = await candidateId('Streaming Alfa');
    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    expect(result).toEqual({ created: 1, skipped: 0, linkedTransactions: 5, warnings: [] });
    const [recurrence] = rowsOf('recurringTransaction');
    expect(recurrence).toMatchObject({
      householdId: HH,
      accountId: CARD,
      categoryName: 'SUBSCRIPTIONS',
      amount: 21.9,
      description: 'Streaming Alfa',
      frequency: 'MONTHLY',
      startDate: '2026-11-03',
      nextRunAt: '2026-11-03',
      isActive: true,
      followLastAmount: true,
    });
  });

  it('starts in the current month when it is not covered yet', async () => {
    seedSeries('Agua', [5, 6, 7, 8, 9], (m) => 40 + m, { categoryName: 'UTILITIES' }, 4);
    const id = await candidateId('Agua');
    await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    expect(rowsOf('recurringTransaction')[0]).toMatchObject({ nextRunAt: '2026-10-04', startDate: '2026-10-04', categoryName: 'UTILITIES' });
  });

  it('clamps the day to the length of the first month and warns about days after the 28th', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, {}, 3);
    const id = await candidateId('Streaming Alfa');
    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id, dayOfMonth: 31 }] }, NOW);
    // Day 31 with a 30-day first month: the first run clamps, the start date keeps the true anchor day.
    expect(rowsOf('recurringTransaction')[0]).toMatchObject({ nextRunAt: '2026-11-30', startDate: '2026-10-31' });
    expect(result.warnings).toEqual([{ code: 'short-month-day', description: expect.any(String), dayOfMonth: 31 }]);
  });

  it('skips a month that already has a pending occurrence', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9], 21.9, {}, 3);
    seedTransaction({ householdId: HH, accountId: CARD, description: 'Streaming Alfa', amount: 21.9, date: day(10, 3), paid: false });
    const id = await candidateId('Streaming Alfa');
    await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    expect(rowsOf('recurringTransaction')[0]).toMatchObject({ nextRunAt: '2026-11-03' });
  });

  it('links the historical transactions to the recurrence without touching any balance or other field', async () => {
    const history = seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    const unrelated = seedTransaction({ householdId: HH, accountId: CARD, description: 'Bakery', amount: 5, date: day(9, 2) });
    const alreadyLinked = seedTransaction({ householdId: HH, accountId: CARD, description: 'Streaming Alfa', amount: 21.9, date: day(5, 3), recurringTransactionId: 'old-recurrence' });
    const balancesBefore = rowsOf('account').map((a) => a.balance);
    const id = await candidateId('Streaming Alfa');
    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    const recurrenceId = rowsOf('recurringTransaction')[0]!.id;
    expect(result.linkedTransactions).toBe(5);
    for (const t of history) expect(rowById('transaction', t.id).recurringTransactionId).toBe(recurrenceId);
    expect(rowById('transaction', unrelated.id).recurringTransactionId).toBeNull();
    expect(rowById('transaction', alreadyLinked.id).recurringTransactionId).toBe('old-recurrence');
    expect(rowsOf('account').map((a) => a.balance)).toEqual(balancesBefore);
    expect(history.every((t) => rowById('transaction', t.id).amount === 21.9 && rowById('transaction', t.id).paid === true)).toBe(true);
  });

  it('is idempotent: the second call creates nothing and counts the ids as skipped', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    const id = await candidateId('Streaming Alfa');
    await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    const again = await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    expect(again).toEqual({ created: 0, skipped: 1, linkedTransactions: 0, warnings: [] });
    expect(rowsOf('recurringTransaction')).toHaveLength(1);
  });

  it('recomputes on the server: an unknown id and a repeated id are skipped, the rest is created', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    seedSeries('Revista Rho', [6, 7, 8, 9, 10], 30);
    const a = await candidateId('Streaming Alfa');
    const b = await candidateId('Revista Rho');
    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id: a }, { id: 'rc_forged' }, { id: a }, { id: b }] }, NOW);
    expect(result).toMatchObject({ created: 2, skipped: 2 });
    expect(rowsOf('recurringTransaction')).toHaveLength(2);
  });

  it('uses the history as it is now: a candidate whose charge stopped is gone', async () => {
    const history = seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    const id = await candidateId('Streaming Alfa');
    for (const t of history) t.paid = false;
    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    expect(result).toMatchObject({ created: 0, skipped: 1 });
  });

  it('applies the user adjustments (amount, day, description, followLastAmount)', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, {}, 3);
    const id = await candidateId('Streaming Alfa');
    await applyDetectedRecurrences(
      { householdId: HH, items: [{ id, amount: 25.555, dayOfMonth: 12, description: '  Streaming Alfa Plus ', followLastAmount: false }] },
      NOW,
    );
    expect(rowsOf('recurringTransaction')[0]).toMatchObject({
      amount: 25.56,
      nextRunAt: '2026-11-12',
      startDate: '2026-11-12',
      description: 'Streaming Alfa Plus',
      followLastAmount: false,
    });
  });

  it('skips an adjusted description that clashes with an active recurrence or a sibling in the same call', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    seedSeries('Revista Rho', [6, 7, 8, 9, 10], 30);
    seedRecurrence({ householdId: HH, accountId: CARD, description: 'Clube Fixo', amount: 10, nextRunAt: day(11) });
    const a = await candidateId('Streaming Alfa');
    const b = await candidateId('Revista Rho');
    const result = await applyDetectedRecurrences(
      { householdId: HH, items: [{ id: a, description: 'clube fixo' }, { id: b, description: 'Combo' }] },
      NOW,
    );
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    expect(result.warnings).toEqual([{ code: 'already-active', description: expect.any(String) }]);
    const second = await applyDetectedRecurrences({ householdId: HH, items: [{ id: a, description: 'Combo' }] }, NOW);
    expect(second.created).toBe(0);
  });

  it('does not offer the same group again after an adjusted description (the history stays linked)', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    const id = await candidateId('Streaming Alfa');
    await applyDetectedRecurrences({ householdId: HH, items: [{ id, description: 'Assinatura renomeada' }] }, NOW);
    const after = await detectRecurringTransactions({ householdId: HH }, NOW);
    expect(after.candidates).toEqual([]);
    expect(after.skipped.alreadyRecurring).toBe(1);
  });

  it('takes the household lock and is all-or-nothing', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    seedSeries('Revista Rho', [6, 7, 8, 9, 10], 30);
    const a = await candidateId('Streaming Alfa');
    const b = await candidateId('Revista Rho');
    fakePrisma.transaction.updateMany.mockImplementationOnce(async () => ({ count: 5 }));
    fakePrisma.transaction.updateMany.mockImplementationOnce(async () => {
      throw new Error('boom');
    });
    await expect(applyDetectedRecurrences({ householdId: HH, items: [{ id: a }, { id: b }] }, NOW)).rejects.toThrow('boom');
    expect(rowsOf('recurringTransaction')).toEqual([]);
    expect(fakePrisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('never creates a recurrence in another household', async () => {
    seedAccount({ id: 'acc-other', householdId: OTHER_HH, name: 'Outra', balance: 0 });
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, { householdId: OTHER_HH, accountId: 'acc-other' });
    const theirs = (await detectRecurringTransactions({ householdId: OTHER_HH }, NOW)).candidates[0]!.id;
    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id: theirs }] }, NOW);
    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(rowsOf('recurringTransaction')).toEqual([]);
  });
});

// Two households side by side. Every query of the detection is scoped by householdId on its own, so each test plants rows that
// only a query that forgot the household would pick up (rows that point across households are inconsistent data, which is
// exactly what a missing filter would otherwise trust).
describe('household isolation of every query', () => {
  it('accounts: a series on an account of another household is not detected', async () => {
    seedAccount({ id: 'acc-other', householdId: OTHER_HH, name: 'Outra', balance: 0 });
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, { accountId: 'acc-other' });
    expect((await detectRecurringTransactions({ householdId: HH }, NOW)).candidates).toEqual([]);
  });

  it('transactions: rows of another household on an account of this one are not read', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, { householdId: OTHER_HH });
    expect((await detectRecurringTransactions({ householdId: HH }, NOW)).candidates).toEqual([]);
  });

  it('active recurrences: one of another household does not hide a candidate as "already recurring"', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    seedRecurrence({ householdId: OTHER_HH, accountId: CARD, description: 'Streaming Alfa', amount: 21.9, nextRunAt: day(11) });
    const response = await detectRecurringTransactions({ householdId: HH }, NOW);
    expect(response.candidates).toHaveLength(1);
    expect(response.skipped.alreadyRecurring).toBe(0);
  });

  it('apply, renamed item: a recurrence of another household with that description is not a clash', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    seedRecurrence({ householdId: OTHER_HH, accountId: CARD, description: 'Streaming Plus', amount: 5, nextRunAt: day(11) });
    const id = (await detectRecurringTransactions({ householdId: HH }, NOW)).candidates[0]!.id;
    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id, description: 'Streaming Plus' }] }, NOW);
    expect(result).toMatchObject({ created: 1, skipped: 0, warnings: [] });
  });

  it('apply: ids of another household are skipped and nothing of theirs is linked', async () => {
    seedAccount({ id: 'acc-other', householdId: OTHER_HH, name: 'Outra', balance: 0 });
    const theirsRows = seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9, { householdId: OTHER_HH, accountId: 'acc-other' });
    const ours = seedSeries('Gym Beta', [6, 7, 8, 9, 10], 90, { accountId: BANK });
    const theirs = (await detectRecurringTransactions({ householdId: OTHER_HH }, NOW)).candidates[0]!.id;
    const mine = (await detectRecurringTransactions({ householdId: HH }, NOW)).candidates[0]!.id;

    const result = await applyDetectedRecurrences({ householdId: HH, items: [{ id: theirs }, { id: mine }] }, NOW);

    expect(result).toMatchObject({ created: 1, skipped: 1, linkedTransactions: 5 });
    expect(theirsRows.every((t) => rowById('transaction', t.id).recurringTransactionId === null)).toBe(true);
    expect(ours.every((t) => rowById('transaction', t.id).recurringTransactionId !== null)).toBe(true);
  });

  it('apply: the update that links the history is scoped to the household', async () => {
    seedSeries('Streaming Alfa', [6, 7, 8, 9, 10], 21.9);
    const id = (await detectRecurringTransactions({ householdId: HH }, NOW)).candidates[0]!.id;
    await applyDetectedRecurrences({ householdId: HH, items: [{ id }] }, NOW);
    const calls = fakePrisma.transaction.updateMany.mock.calls as unknown as Array<[{ where: { householdId?: string } }]>;
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].where.householdId).toBe(HH);
  });
});
