import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Prisma } from '../../generated/prisma/client.js';
import { AccountType } from '../../shared/enums/index.js';

const db = vi.hoisted(() => ({
  exists: vi.fn(),
  lock: vi.fn(),
  fresh: vi.fn(),
  reload: vi.fn(),
  txCreate: vi.fn(),
  move: vi.fn(),
  recalc: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findFirst: db.exists },
    $transaction: async (cb: (tx: unknown) => Promise<unknown>) =>
      cb({
        $queryRaw: db.lock,
        account: { findFirst: db.fresh, findUniqueOrThrow: db.reload },
        transaction: { create: db.txCreate },
      }),
  },
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  applyTransfer: vi.fn(),
  updateBalanceForNormalTransaction: db.move,
  recalculateCreditCardLimit: db.recalc,
}));

const { adjustBalance } = await import('./accounts.service.js');
const { adjustBalanceSchema } = await import('./accounts.schema.js');

const dec = (n: number | string) => new Prisma.Decimal(n);
const account = (type: string, total: number) => ({ id: 'a1', householdId: 'h1', type, totalBalance: dec(total), balance: dec(total) });
const create = () => db.txCreate.mock.calls[0]![0].data as Record<string, any>;

beforeEach(() => {
  vi.clearAllMocks();
  db.exists.mockResolvedValue({ id: 'a1' });
  db.txCreate.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ id: 't1', ...data }));
  db.reload.mockResolvedValue({ id: 'a1', reloaded: true });
});

describe('adjustBalance', () => {
  it('a higher balance on a bank account is ONE paid INCOME with a positive amount, dated as asked', async () => {
    db.fresh.mockResolvedValue(account(AccountType.CHECKING, 3665.04));
    const date = new Date(2025, 11, 31);
    const result = await adjustBalance('a1', 'h1', { newBalance: 3802.27, date, reason: 'Saldo inicial' });
    expect(db.txCreate).toHaveBeenCalledTimes(1);
    expect(create()).toMatchObject({ type: 'INCOME', categoryName: 'OTHER_INCOME', description: 'Saldo inicial', paid: true, accountId: 'a1', householdId: 'h1' });
    expect(create().amount.toFixed(2)).toBe('137.23');
    expect(create().date).toBe(date);
    expect(db.move).toHaveBeenCalledWith(expect.anything(), 'a1', 137.23);
    expect(db.recalc).not.toHaveBeenCalled();
    expect(result.adjustment).toMatchObject({ id: 't1', amount: 137.23 });
    expect(result.account).toMatchObject({ reloaded: true });
  });

  it('a lower balance on a bank account is an EXPENSE with a POSITIVE amount and a negative balance change', async () => {
    db.fresh.mockResolvedValue(account(AccountType.CHECKING, 100));
    await adjustBalance('a1', 'h1', { newBalance: 40.5 });
    expect(create()).toMatchObject({ type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', description: 'Balance adjustment' });
    expect(create().amount.toFixed(2)).toBe('59.50');
    expect(db.move).toHaveBeenCalledWith(expect.anything(), 'a1', -59.5);
  });

  it('defaults the date to today at local midnight', async () => {
    db.fresh.mockResolvedValue(account(AccountType.CASH, 0));
    await adjustBalance('a1', 'h1', { newBalance: 10 });
    const n = new Date();
    expect(create().date.getTime()).toBe(new Date(n.getFullYear(), n.getMonth(), n.getDate()).getTime());
  });

  it('a credit card balance is debt: more debt is an EXPENSE, less debt an INCOME, and the limit is recalculated', async () => {
    db.fresh.mockResolvedValue(account(AccountType.CREDIT, 200));
    await adjustBalance('a1', 'h1', { newBalance: 250 });
    expect(create()).toMatchObject({ type: 'EXPENSE', categoryName: 'OTHER_EXPENSES' });
    expect(db.move).toHaveBeenLastCalledWith(expect.anything(), 'a1', 50);
    expect(db.recalc).toHaveBeenCalledTimes(1);

    db.txCreate.mockClear();
    await adjustBalance('a1', 'h1', { newBalance: 150 });
    expect(create()).toMatchObject({ type: 'INCOME', categoryName: 'OTHER_INCOME' });
    expect(create().amount.toFixed(2)).toBe('50.00');
    expect(db.move).toHaveBeenLastCalledWith(expect.anything(), 'a1', -50);
  });

  it('difference zero creates no entry and moves nothing', async () => {
    db.fresh.mockResolvedValue(account(AccountType.CHECKING, 3802.27));
    const result = await adjustBalance('a1', 'h1', { newBalance: 3802.27 });
    expect(result.adjustment).toBeNull();
    expect(db.txCreate).not.toHaveBeenCalled();
    expect(db.move).not.toHaveBeenCalled();
  });

  it('locks the account row (FOR UPDATE) before reading it, so a second submit of the same target finds difference zero', async () => {
    const order: string[] = [];
    db.lock.mockImplementation(async () => void order.push('lock'));
    db.fresh.mockImplementation(async () => (order.push('read'), account(AccountType.CHECKING, 3802.27)));
    const result = await adjustBalance('a1', 'h1', { newBalance: 3802.27 });
    expect(order).toEqual(['lock', 'read']);
    // $queryRaw is a tagged template: its first argument is the list of SQL fragments.
    const [fragments] = db.lock.mock.calls[0]! as [string[], ...unknown[]];
    expect(fragments.join('?')).toMatch(/FROM accounts WHERE id = \?::uuid FOR UPDATE/);
    expect(result.adjustment).toBeNull();
  });

  it('throws NotFound for an account of another household', async () => {
    db.exists.mockResolvedValue(null);
    await expect(adjustBalance('a1', 'other', { newBalance: 1 })).rejects.toThrow('Account not found');
    expect(db.lock).not.toHaveBeenCalled();
  });

  it('falls back to the default description when the reason is blank', async () => {
    db.fresh.mockResolvedValue(account(AccountType.CHECKING, 0));
    await adjustBalance('a1', 'h1', { newBalance: 5, reason: '' });
    expect(create().description).toBe('Balance adjustment');
  });
});

describe('adjustBalanceSchema', () => {
  const pad = (n: number) => String(n).padStart(2, '0');
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = (body: unknown) => adjustBalanceSchema.safeParse(body);

  it('accepts a number or a numeric string and keeps the optional fields optional', () => {
    expect(parse({ newBalance: 3802.27 })).toMatchObject({ success: true, data: { newBalance: 3802.27 } });
    expect(parse({ newBalance: '3802.27' })).toMatchObject({ success: true, data: { newBalance: 3802.27 } });
    expect(parse({ newBalance: -10 }).success).toBe(true);
    expect(parse({ newBalance: 0 }).success).toBe(true);
  });

  it('rejects what must not become zero or NaN: empty, null, missing, text, more than two decimals', () => {
    for (const bad of ['', '  ', null, undefined, 'abc', NaN, Infinity, 10.123, '1e999']) {
      expect(parse({ newBalance: bad }).success, String(bad)).toBe(false);
    }
    expect(parse({}).success).toBe(false);
  });

  it('parses the date as a local calendar day (2025-12-31 stays 31/12/2025)', () => {
    const r = parse({ newBalance: 1, date: '2025-12-31' });
    expect(r.success).toBe(true);
    const d = (r as { data: { date: Date } }).data.date;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2025, 11, 31]);
  });

  it('accepts today, rejects tomorrow and impossible days and other formats', () => {
    const now = new Date();
    expect(parse({ newBalance: 1, date: iso(now) }).success).toBe(true);
    expect(parse({ newBalance: 1, date: iso(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)) }).success).toBe(false);
    for (const bad of ['2025-02-30', '2025-13-01', '31/12/2025', '2025-12-31T00:00:00Z', '']) {
      expect(parse({ newBalance: 1, date: bad }).success, bad).toBe(false);
    }
  });

  it('accepts 1900-01-01 and rejects anything earlier', () => {
    expect(parse({ newBalance: 1, date: '1900-01-01' }).success).toBe(true);
    expect(parse({ newBalance: 1, date: '1899-12-31' }).success).toBe(false);
    expect(parse({ newBalance: 1, date: '0025-12-31' }).success).toBe(false);
  });

  it('trims and bounds the reason', () => {
    expect(parse({ newBalance: 1, reason: '  Saldo inicial ' })).toMatchObject({ data: { reason: 'Saldo inicial' } });
    expect(parse({ newBalance: 1, reason: 'x'.repeat(256) }).success).toBe(false);
  });
});
