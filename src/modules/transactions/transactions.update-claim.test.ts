import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType } from '../../shared/enums/index.js';

// updateTransaction locks the row and reads it again before it touches any balance. The real-Postgres test
// (transactions.hooks.integration.test.ts) covers the transaction boundaries; this one pins the decisions.
const db = vi.hoisted(() => ({
  transactionFindFirst: vi.fn(),
  transactionUpdate: vi.fn(),
  accountFindFirst: vi.fn(),
  accountFindUnique: vi.fn(),
  queryRaw: vi.fn(),
  updateBalance: vi.fn(),
  recalculateLimit: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => {
  const client = {
    transaction: { findFirst: db.transactionFindFirst, update: db.transactionUpdate },
    account: { findFirst: db.accountFindFirst, findUnique: db.accountFindUnique },
    $queryRaw: db.queryRaw,
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(client),
  };
  return { prisma: client };
});
vi.mock('../../shared/services/balance.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../shared/services/balance.service.js')>()),
  updateBalanceForNormalTransaction: db.updateBalance,
  recalculateCreditCardLimit: db.recalculateLimit,
}));

const { isDeadlock, updateTransaction } = await import('./transactions.service.js');

const decimal = (value: number) => ({ toNumber: () => value, toString: () => String(value), equals: (other: { toNumber(): number }) => other.toNumber() === value });
const CARD = 'card-1';
const CASH = 'cash-1';
const ROW = {
  id: 'tx-1',
  householdId: 'hh-1',
  accountId: CARD,
  type: 'EXPENSE',
  paid: true,
  amount: decimal(100),
  description: 'Compra',
  categoryName: 'OTHER_EXPENSES',
  date: new Date('2026-01-01T00:00:00Z'),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  db.transactionFindFirst.mockResolvedValue(ROW);
  db.queryRaw.mockResolvedValue([]);
  db.accountFindFirst.mockResolvedValue({ id: CASH, type: AccountType.CHECKING });
  db.accountFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) => ({ type: where.id === CARD ? AccountType.CREDIT : AccountType.CHECKING }));
  db.transactionUpdate.mockImplementation(async ({ data }: { data: { accountId?: string } }) => ({
    ...ROW,
    ...data,
    amount: decimal(100),
    account: { id: data.accountId ?? CARD, name: 'x', type: (data.accountId ?? CARD) === CARD ? AccountType.CREDIT : AccountType.CHECKING },
  }));
});

describe('updateTransaction: lock, re-read and conflicts', () => {
  it('locks the row and reads it again before any balance is touched', async () => {
    await updateTransaction(ROW.id, ROW.householdId, { accountId: CASH });

    // The row, then both accounts (by id, so crossing moves cannot deadlock).
    expect(db.queryRaw).toHaveBeenCalledTimes(2);
    expect(db.queryRaw.mock.invocationCallOrder[1]!).toBeLessThan(db.updateBalance.mock.invocationCallOrder[0]!);
    // One read before the transaction, one under the lock.
    expect(db.transactionFindFirst).toHaveBeenCalledTimes(2);
  });

  it('answers 409 and changes no balance when the account the caller moves from is no longer the row account', async () => {
    db.transactionFindFirst.mockResolvedValueOnce(ROW).mockResolvedValueOnce({ ...ROW, accountId: CASH });

    await expect(updateTransaction(ROW.id, ROW.householdId, { accountId: CASH })).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });

    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(db.transactionUpdate).not.toHaveBeenCalled();
  });

  it('answers 409 when the amount the caller changes was changed by someone else', async () => {
    db.transactionFindFirst.mockResolvedValueOnce(ROW).mockResolvedValueOnce({ ...ROW, amount: decimal(150) });

    await expect(updateTransaction(ROW.id, ROW.householdId, { amount: 120 })).rejects.toMatchObject({ statusCode: 409 });

    expect(db.updateBalance).not.toHaveBeenCalled();
  });

  it('applies a description PATCH on top of a concurrent amount change (independent PATCHes both succeed)', async () => {
    const moved = { ...ROW, amount: decimal(150) };
    db.transactionFindFirst.mockResolvedValueOnce(ROW).mockResolvedValueOnce(moved).mockResolvedValue(moved);

    await updateTransaction(ROW.id, ROW.householdId, { description: 'Outra' });

    // It read the row again (the retry) and wrote its description; no balance moved for a description.
    expect(db.transactionUpdate).toHaveBeenCalledTimes(1);
    expect(db.updateBalance).not.toHaveBeenCalled();
  });

  it('applies "paid" once: the loser of two concurrent PATCH {paid:true} finds it already paid and moves nothing', async () => {
    const unpaid = { ...ROW, paid: false };
    db.transactionFindFirst.mockResolvedValueOnce(unpaid).mockResolvedValueOnce(ROW).mockResolvedValue(ROW);

    await updateTransaction(ROW.id, ROW.householdId, { paid: true });

    expect(db.updateBalance).not.toHaveBeenCalled();
    expect(db.transactionUpdate).toHaveBeenCalledTimes(1);
  });

  it('gives up with 409 when the row keeps changing under it', async () => {
    let flip = 0;
    db.transactionFindFirst.mockImplementation(async () => ({ ...ROW, categoryName: flip++ % 2 === 0 ? 'OTHER_EXPENSES' : 'GROCERIES' }));

    await expect(updateTransaction(ROW.id, ROW.householdId, { description: 'x' })).rejects.toMatchObject({ statusCode: 409 });
  });

  it('runs the caller hook after the lock and before any balance change, and aborts when it throws', async () => {
    const order: string[] = [];
    db.queryRaw.mockImplementation(async () => {
      order.push('lock');
      return [];
    });
    db.updateBalance.mockImplementation(async () => {
      order.push('balance');
    });

    await updateTransaction(ROW.id, ROW.householdId, { accountId: CASH }, { beforeWrite: async () => void order.push('hook') });
    expect(order.slice(0, 4)).toEqual(['lock', 'lock', 'hook', 'balance']);

    db.updateBalance.mockClear();
    await expect(
      updateTransaction(ROW.id, ROW.householdId, { accountId: CASH }, { beforeWrite: async () => Promise.reject(new Error('refused')) }),
    ).rejects.toThrow('refused');
    expect(db.updateBalance).not.toHaveBeenCalled();
  });

  it('retries when Postgres rolls it back as a deadlock victim (40P01), and gives up with a 409 after 3 tries', async () => {
    let calls = 0;
    db.transactionUpdate.mockImplementation(async ({ data }: { data: { accountId?: string } }) => {
      calls += 1;
      // The shape the pg driver adapter really gives (see the Postgres test that provokes a real deadlock).
      if (calls === 1) throw Object.assign(new Error('deadlock detected'), { name: 'DriverAdapterError', cause: { originalCode: '40P01', kind: 'postgres' } });
      return { ...ROW, ...data, amount: decimal(100), account: { id: CASH, name: 'x', type: AccountType.CHECKING } };
    });
    await updateTransaction(ROW.id, ROW.householdId, { accountId: CASH });
    expect(calls).toBe(2);

    db.transactionUpdate.mockImplementation(async () => {
      throw Object.assign(new Error('could not serialize: 40P01'), { code: 'P2010' });
    });
    await expect(updateTransaction(ROW.id, ROW.householdId, { accountId: CASH })).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining('being changed'),
    });
  });
  it('runs inTransaction after the write', async () => {
    const order: string[] = [];
    db.transactionUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
      order.push('write');
      return { ...ROW, ...data, amount: decimal(100), account: { id: CARD, name: 'x', type: AccountType.CREDIT } };
    });

    await updateTransaction(ROW.id, ROW.householdId, { description: 'x' }, { inTransaction: async () => void order.push('hook') });

    expect(order).toEqual(['write', 'hook']);
  });


  it('recognizes a deadlock by the code in any place the layers put it, and nothing else', () => {
    expect(isDeadlock(Object.assign(new Error('deadlock detected'), { cause: { originalCode: '40P01' } }))).toBe(true);
    expect(isDeadlock({ cause: { code: '40P01' } })).toBe(true);
    expect(isDeadlock({ code: 'P2010', meta: { code: '40P01' } })).toBe(true);
    expect(isDeadlock(new Error('ERROR: deadlock detected'))).toBe(true);
    expect(isDeadlock(new Error('could not serialize: 40P01'))).toBe(true);
    expect(isDeadlock(new Error('duplicate key'))).toBe(false);
    expect(isDeadlock({ code: 'P2002' })).toBe(false);
    expect(isDeadlock(null)).toBe(false);
  });

  it('writes the source ref the importer sets, clears it with null, and leaves it alone otherwise', async () => {
    db.transactionUpdate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...ROW,
      ...data,
      amount: decimal(100),
      account: { id: CARD, name: 'x', type: AccountType.CREDIT },
    }));

    await updateTransaction(ROW.id, ROW.householdId, { sourceRef: 'ofx:a:00000001' });
    expect(db.transactionUpdate.mock.calls[0]![0].data).toMatchObject({ sourceRef: 'ofx:a:00000001' });

    await updateTransaction(ROW.id, ROW.householdId, { sourceRef: null });
    expect(db.transactionUpdate.mock.calls[1]![0].data).toMatchObject({ sourceRef: null });

    await updateTransaction(ROW.id, ROW.householdId, { description: 'x' });
    expect(db.transactionUpdate.mock.calls[2]![0].data).not.toHaveProperty('sourceRef');
  });
});
