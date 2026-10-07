import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakePrisma,
  resetStore,
  rowById,
  seedAccount,
  seedRecurrence,
  seedTransaction,
} from '../recurring-transactions/__fixtures__/recurring-fake-db.js';
import { followLastAmountInTx } from '../recurring-transactions/recurring-follow.js';
import { updateTransaction } from './transactions.service.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('../recurring-transactions/__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  updateBalanceForNormalTransaction: vi.fn(async () => undefined),
  recalculateCreditCardLimit: vi.fn(async () => undefined),
}));
vi.mock('../notifications/budget-notifications.service.js', () => ({ checkBudgetThresholds: vi.fn(async () => undefined) }));

// Invented data only.
const HH = 'hh-1';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: 'acc-bank', householdId: HH, name: 'Conta Teste', balance: 1000 });
});

function occurrence() {
  const rec = seedRecurrence({ householdId: HH, accountId: 'acc-bank', description: 'Energia', amount: 100, nextRunAt: '2026-11-05', followLastAmount: true });
  const tx = seedTransaction({
    householdId: HH,
    accountId: 'acc-bank',
    description: 'Energia',
    amount: 100,
    date: '2026-10-05',
    paid: false,
    recurringTransactionId: rec.id,
  });
  return { rec, tx };
}

describe('updateTransaction hooks', () => {
  it('runs the hook inside the same database transaction as the update', async () => {
    const { rec, tx } = occurrence();
    let insideTransaction = false;
    let hookRanInside = false;
    fakePrisma.$transaction.mockImplementationOnce(async (callback: (t: unknown) => Promise<unknown>) => {
      insideTransaction = true;
      try {
        return await callback(fakePrisma);
      } finally {
        insideTransaction = false;
      }
    });
    await updateTransaction(
      tx.id,
      HH,
      { amount: 120, paid: true },
      {
        inTransaction: async (t) => {
          hookRanInside = insideTransaction;
          await followLastAmountInTx(t, { id: tx.id, householdId: HH, recurringTransactionId: rec.id, date: new Date('2026-10-05T00:00:00Z'), amount: 100 }, { amount: 120 }, new Date(2026, 9, 5));
        },
      },
    );
    expect(hookRanInside).toBe(true);
    expect(rowById('recurringTransaction', rec.id).amount).toBe(120);
    expect(rowById('transaction', tx.id)).toMatchObject({ amount: 120, paid: true });
  });

  it('reverts the update when the hook fails (and the other way around)', async () => {
    const { rec, tx } = occurrence();
    await expect(
      updateTransaction(tx.id, HH, { amount: 120 }, {
        inTransaction: async (t) => {
          await t.recurringTransaction.update({ where: { id: rec.id }, data: { amount: 120 } });
          throw new Error('boom');
        },
      }),
    ).rejects.toThrow('boom');
    expect(rowById('transaction', tx.id).amount).toBe(100);
    expect(rowById('recurringTransaction', rec.id).amount).toBe(100);
  });
});
