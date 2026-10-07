import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType, CategoryName, TransactionType } from '../../shared/enums/index.js';

// Payments are tagged `invoice_pay:<cardId>:<YYYY>-<zero-based month>` and dated on/after the closing day of the
// invoice they pay, i.e. in the NEXT window. They must be counted by tag, and only once their date has come.
type Row = {
  id: string;
  accountId: string | null;
  householdId: string;
  date: Date;
  amount: { toNumber: () => number };
  categoryName: string | null;
  type: string;
  attachmentUrl: string | null;
  paid: boolean;
};

const store = vi.hoisted(() => ({ rows: [] as unknown[] }));
const updates = vi.hoisted(() => ({ updateMany: vi.fn(), create: vi.fn(), accountUpdate: vi.fn() }));

function matches(row: Row, where: Record<string, any>): boolean {
  const { OR, ...rest } = where;
  if (OR && !(OR as Record<string, any>[]).some((w) => matches(row, w))) return false;
  for (const [key, cond] of Object.entries(rest)) {
    const value = (row as any)[key];
    if (key === 'date') {
      const t = row.date.getTime();
      if (cond.gte && t < cond.gte.getTime()) return false;
      if (cond.gt && t <= cond.gt.getTime()) return false;
      if (cond.lte && t > cond.lte.getTime()) return false;
      if (cond.lt && t >= cond.lt.getTime()) return false;
    } else if (cond !== null && typeof cond === 'object') {
      if ('equals' in cond && value !== cond.equals) return false;
      if ('startsWith' in cond && !(typeof value === 'string' && value.startsWith(cond.startsWith))) return false;
      if ('not' in cond) {
        const not = cond.not;
        // `not: { startsWith }` is SQL NOT LIKE: a NULL column does not satisfy it.
        if (not !== null && typeof not === 'object' && 'startsWith' in not) {
          if (typeof value !== 'string' || value.startsWith(not.startsWith)) return false;
        } else if (value === not) return false;
      }
    } else if (value !== cond) return false;
  }
  return true;
}

const accounts = vi.hoisted(() => ({ byId: {} as Record<string, unknown> }));

const transactionApi = {
  findMany: vi.fn(async (args: { where: Record<string, any>; take?: number }) => {
    const found = (store.rows as Row[]).filter((r) => matches(r, args.where));
    return args.take ? found.slice(0, args.take) : found;
  }),
  findFirst: vi.fn(async (args: { where: Record<string, any> }) => (store.rows as Row[]).find((r) => matches(r, args.where)) ?? null),
  count: vi.fn(async (args: { where: Record<string, any> }) => (store.rows as Row[]).filter((r) => matches(r, args.where)).length),
  create: vi.fn(async (args: { data: Record<string, any> }) => {
    updates.create(args);
    return { id: 'new-payment', ...args.data };
  }),
  updateMany: vi.fn(async (args: unknown) => {
    updates.updateMany(args);
    return { count: 0 };
  }),
};
const accountApi = {
  findFirst: vi.fn(async (args: { where: { id: string } }) => accounts.byId[args.where.id] ?? null),
  findUnique: vi.fn(async (args: { where: { id: string } }) => accounts.byId[args.where.id] ?? null),
  update: vi.fn(async (args: unknown) => {
    updates.accountUpdate(args);
    return {};
  }),
};

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: accountApi,
    transaction: transactionApi,
    $transaction: async (cb: (tx: unknown) => unknown) => cb({ account: accountApi, transaction: transactionApi }),
  },
}));
vi.mock('../../shared/services/balance.service.js', () => ({
  recalculateCreditCardLimit: vi.fn(),
  applyTransfer: vi.fn(),
  applyAllocation: vi.fn(),
  applyDeallocation: vi.fn(),
  updateBalanceForNormalTransaction: vi.fn(),
}));

const {
  calculateCreditCardInvoice,
  payCreditCardInvoice,
  parseInvoicePaymentOrdinal,
  utcToday,
} = await import('./transactions.service.js');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const decimal = (value: number) => ({ toNumber: () => value });
const CARD = { id: 'card-1', householdId: 'house-1', type: AccountType.CREDIT, isActive: true, closingDay: 2, dueDay: 9, balance: decimal(0) };
const SOURCE = { id: 'bank-1', householdId: 'house-1', type: AccountType.CHECKING, isActive: true, balance: decimal(10000) };
const TODAY = day('2026-10-06');

let seq = 0;
const purchase = (date: string, amount: number): Row => ({
  id: `p${++seq}`,
  accountId: CARD.id,
  householdId: CARD.householdId,
  date: day(date),
  amount: decimal(amount),
  categoryName: CategoryName.OTHER_EXPENSES,
  type: TransactionType.EXPENSE,
  attachmentUrl: null,
  paid: false,
});
/** `invoiceMonth` is 1-based (YYYY-MM) as the API speaks; the tag is zero-based. */
const payment = (date: string, amount: number, invoiceMonth: string): Row => {
  const [y, m] = invoiceMonth.split('-').map(Number);
  return {
    id: `pay${++seq}`,
    accountId: SOURCE.id,
    householdId: CARD.householdId,
    date: day(date),
    amount: decimal(amount),
    categoryName: CategoryName.OTHER_EXPENSES,
    type: TransactionType.EXPENSE,
    attachmentUrl: `invoice_pay:${CARD.id}:${y}-${m - 1}`,
    paid: true,
  };
};

const invoice = async (month: string, today: Date = TODAY) =>
  (await calculateCreditCardInvoice(CARD.id, month, CARD.householdId, { limit: 5 }, { today })).data;

beforeEach(() => {
  vi.clearAllMocks();
  seq = 0;
  store.rows = [];
  accounts.byId = { [CARD.id]: CARD, [SOURCE.id]: SOURCE };
});

describe('parseInvoicePaymentOrdinal', () => {
  it('reads the zero-based tag month of this card only', () => {
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-1:2026-9', 'card-1')).toBe(2026 * 12 + 9);
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-1:2026-09', 'card-1')).toBe(2026 * 12 + 9);
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-2:2026-9', 'card-1')).toBeNull();
    expect(parseInvoicePaymentOrdinal('invoice_pay:card-1:garbage', 'card-1')).toBeNull();
    expect(parseInvoicePaymentOrdinal(null, 'card-1')).toBeNull();
  });
});

describe('utcToday', () => {
  it('is the UTC date, whatever the local time zone offset of the instant', () => {
    expect(utcToday(new Date('2026-10-06T23:30:00-03:00'))).toEqual(day('2026-10-07'));
    expect(utcToday(new Date('2026-10-06T00:30:00+05:00'))).toEqual(day('2026-10-05'));
    expect(utcToday(new Date('2026-10-06T00:00:00.000Z'))).toEqual(day('2026-10-06'));
  });
});

describe('calculateCreditCardInvoice payments by invoice tag', () => {
  // Sep invoice (window 2026-08-02..2026-09-01) = 4793.57, paid 2026-09-02 (first day of the Oct window);
  // Oct invoice (window 2026-09-02..2026-10-01) = 5384.98, due 2026-10-09.
  const seedSepAndOct = () => {
    store.rows = [purchase('2026-08-20', 4793.57), purchase('2026-09-15', 5384.98)];
  };

  it('subtracts a payment dated after the closing day of its own invoice from the next previousBalance', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'));

    const oct = await invoice('2026-10');

    expect(oct.previousBalance).toBeCloseTo(0, 2);
    expect(oct.currentExpenses).toBeCloseTo(5384.98, 2);
    expect(oct.total).toBeCloseTo(5384.98, 2);
    expect(oct.isPaid).toBe(false);
  });

  it('does not count a payment dated in the future (unpaid until its date), neither as previous nor as current', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'), payment('2026-10-09', 5384.98, '2026-10'));

    const oct = await invoice('2026-10');
    expect(oct.currentPayments).toBe(0);
    expect(oct.total).toBeCloseTo(5384.98, 2);
    expect(oct.isPaid).toBe(false);

    // The same payment, once its date has come, is the invoice's own current payment
    const afterDue = await invoice('2026-10', day('2026-10-09'));
    expect(afterDue.currentPayments).toBeCloseTo(5384.98, 2);
    expect(afterDue.total).toBe(0);
    expect(afterDue.isPaid).toBe(true);

    // ...and a future payment for the invoice itself never leaks into the following invoice's carry
    const nov = await invoice('2026-11');
    expect(nov.previousBalance).toBeCloseTo(5384.98, 2);
  });

  it('lists only the payments already made, so the list agrees with the total', async () => {
    seedSepAndOct();
    const future = payment('2026-10-09', 5384.98, '2026-10');
    store.rows.push(future);
    const listed = async (today?: Date) =>
      (await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 50 }, { today: today ?? TODAY })).data.invoiceTransactions.map((t: { id: string }) => t.id);

    expect(await listed()).not.toContain(future.id);
    expect(await listed(day('2026-10-09'))).toContain(future.id);
  });

  it('counts a payment tagged for the same invoice as currentPayments even when dated after its closing', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'));

    const sep = await invoice('2026-09');

    expect(sep.currentPayments).toBeCloseTo(4793.57, 2);
    expect(sep.total).toBeCloseTo(0, 2);
    expect(sep.isPaid).toBe(true);
    expect(sep.paymentTransactions).toHaveLength(1);
  });

  it('keeps counting legacy payments dated inside the invoice window', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-20', 1000, '2026-10'));

    const oct = await invoice('2026-10');

    expect(oct.currentPayments).toBe(1000);
    expect(oct.total).toBeCloseTo(4384.98 + 4793.57, 2);
    expect(oct.isPaid).toBe(false);
  });

  it('does not subtract a payment tagged for a later invoice from an earlier one (advance payments)', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-08-25', 300, '2026-10'));

    const sep = await invoice('2026-09');
    expect(sep.previousBalance).toBe(0);
    expect(sep.currentPayments).toBe(0);

    const oct = await invoice('2026-10');
    expect(oct.currentPayments).toBe(300);
  });

  it('ignores payments of other cards', async () => {
    seedSepAndOct();
    const other = payment('2026-09-02', 4793.57, '2026-09');
    other.attachmentUrl = 'invoice_pay:card-2:2026-8';
    store.rows.push(other);

    expect((await invoice('2026-10')).previousBalance).toBeCloseTo(4793.57, 2);
  });

  it('counts a payment dated today and, by default, uses the UTC date of now', async () => {
    seedSepAndOct();
    store.rows.push(payment('2026-09-02', 4793.57, '2026-09'), payment('2026-10-06', 100, '2026-10'));
    vi.useFakeTimers();
    try {
      // 2026-10-06 22:00 in UTC-3 is already 2026-10-07 01:00 UTC: payment of the 6th is in the past either way
      vi.setSystemTime(new Date('2026-10-06T22:00:00-03:00'));
      const oct = (await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 })).data;
      expect(oct.currentPayments).toBe(100);

      // 2026-10-05 21:00 in UTC-3 is 2026-10-06 00:00 UTC: the payment dated the 6th (UTC date-only) counts
      vi.setSystemTime(new Date('2026-10-05T21:00:00-03:00'));
      const early = (await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 })).data;
      expect(early.currentPayments).toBe(100);

      vi.setSystemTime(new Date('2026-10-05T20:59:00-03:00'));
      const before = (await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 })).data;
      expect(before.currentPayments).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a card with no purchases before the invoice window', () => {
  // Initial debt 300 (no purchases for it), one purchase of 1000 in the Oct window (2026-09-02..2026-10-01) and a
  // payment of 300 for the Sep invoice made on 2026-10-02: after the window, so a date window never sees it.
  // The account balance already holds all of it: 300 + 1000 - 300.
  const seed = () => {
    accounts.byId = { [CARD.id]: { ...CARD, balance: decimal(1000) }, [SOURCE.id]: SOURCE };
    store.rows = [purchase('2026-09-15', 1000), payment('2026-10-02', 300, '2026-09')];
  };

  it('takes the initial debt from the balance less the period purchases: a payment of the previous invoice made after the window leaves nothing owed from before', async () => {
    seed();

    const oct = await invoice('2026-10');

    // 300 owed, 1000 bought, the 300 paid on 2 Oct: the balance is 1000, all of it this invoice.
    expect(oct.previousBalance).toBeCloseTo(0, 2);
    expect(oct.total).toBeCloseTo(1000, 2);
  });

  it('does not take out again a payment made before the window, which the balance already holds', async () => {
    // Initial debt 1000, a payment of 400 in July for an old invoice, a purchase of 100 in the window: balance 700.
    accounts.byId = { [CARD.id]: { ...CARD, balance: decimal(700) }, [SOURCE.id]: SOURCE };
    store.rows = [purchase('2026-09-15', 100), payment('2026-07-10', 400, '2026-06')];

    const oct = await invoice('2026-10');

    expect(oct.previousBalance).toBeCloseTo(600, 2);
    expect(oct.total).toBeCloseTo(700, 2);
  });

  it('does not count a payment still dated in the future, as the rest of the invoice does', async () => {
    seed();

    const early = await invoice('2026-10', day('2026-10-01'));

    // Not paid yet at that date, and the balance (which already holds it) is not adjusted for it either.
    expect(early.previousBalance).toBeCloseTo(0, 2);
  });
});

describe('payCreditCardInvoice', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-06T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates the payment dated today, tagged with the invoice month, for the invoice remaining after earlier payments', async () => {
    store.rows = [purchase('2026-08-20', 4793.57), purchase('2026-09-15', 5384.98), payment('2026-09-02', 4793.57, '2026-09')];

    const result = await payCreditCardInvoice({
      householdId: CARD.householdId,
      accountId: CARD.id,
      sourceAccountId: SOURCE.id,
      month: '2026-10',
    } as never);

    expect(result.invoiceTotal).toBeCloseTo(5384.98, 2);
    expect(result.previousBalance).toBeCloseTo(0, 2);
    expect(updates.create).toHaveBeenCalledTimes(1);
    const data = updates.create.mock.calls[0][0].data;
    expect(data.attachmentUrl).toBe('invoice_pay:card-1:2026-9');
    expect(data.date).toEqual(new Date('2026-10-06T12:00:00Z'));
    expect(data.amount.toNumber()).toBeCloseTo(5384.98, 2);
  });

  it('takes the initial debt of a card with no earlier purchases from the balance, a payment of the previous invoice after the window included', async () => {
    accounts.byId = { [CARD.id]: { ...CARD, balance: decimal(1000) }, [SOURCE.id]: SOURCE };
    store.rows = [purchase('2026-09-15', 1000), payment('2026-10-02', 300, '2026-09')];

    const result = await payCreditCardInvoice({ householdId: CARD.householdId, accountId: CARD.id, sourceAccountId: SOURCE.id, month: '2026-10' } as never);

    expect(result.previousBalance).toBeCloseTo(0, 2);
    expect(result.invoiceTotal).toBeCloseTo(1000, 2);
  });

  it('does not take out again a payment made before the window when it works out the initial debt', async () => {
    accounts.byId = { [CARD.id]: { ...CARD, balance: decimal(700) }, [SOURCE.id]: SOURCE };
    store.rows = [purchase('2026-09-15', 100), payment('2026-07-10', 400, '2026-06')];

    const result = await payCreditCardInvoice({ householdId: CARD.householdId, accountId: CARD.id, sourceAccountId: SOURCE.id, month: '2026-10' } as never);

    expect(result.previousBalance).toBeCloseTo(600, 2);
    expect(result.invoiceTotal).toBeCloseTo(700, 2);
  });

  it('finds a payment made today for the current statement when computing what is still owed', async () => {
    // Paid today (after the 2026-10-01 end of the window) for invoice 2026-10: nothing remains
    store.rows = [purchase('2026-09-15', 1000), payment('2026-10-06', 1000, '2026-10')];

    await expect(
      payCreditCardInvoice({ householdId: CARD.householdId, accountId: CARD.id, sourceAccountId: SOURCE.id, month: '2026-10' } as never)
    ).rejects.toThrow(/greater than zero/);
  });
});

describe('a card with no purchases before the window: every combination of payments', () => {
  // Window of the October invoice: 2026-09-02..2026-10-01; today 2026-10-06. The balance is the initial debt plus the
  // purchase of 1000 in the window less every payment made (also one dated in the future, applied when it was made).
  // What each payment means for the invoice is decided by its tag, wherever it is dated:
  //   tag for this invoice  -> counts as paid for it (taken out of the total), if its date has come;
  //   tag for an earlier one -> reduces what was owed before;
  //   tag for a later one    -> an advance: it reduces nothing of this invoice (the balance holds it, so it is added back).
  // A payment dated in the future is not paid yet: it counts for nothing, while the balance already holds it.
  const DATES = { before: '2026-08-10', inside: '2026-09-20', after: '2026-10-03', future: '2026-10-20' } as const
  const TAGS = { current: '2026-10', previous: '2026-09', old: '2026-07', later: '2026-11' } as const
  type When = keyof typeof DATES
  type Tag = keyof typeof TAGS
  type Pay = { when: When; tag: Tag; amount: number }

  const singles: Pay[] = []
  for (const when of Object.keys(DATES) as When[]) for (const tag of Object.keys(TAGS) as Tag[]) singles.push({ when, tag, amount: 150 })
  const sets: Pay[][] = [[], ...singles.map((p) => [p])]
  for (let a = 0; a < singles.length; a++) for (let b = a + 1; b < singles.length; b++) sets.push([singles[a]!, { ...singles[b]!, amount: 90 }])

  const expected = (debt: number, pays: Pay[]) => {
    const made = pays.filter((p) => p.when !== 'future')
    const sum = (list: Pay[]) => list.reduce((total, p) => total + p.amount, 0)
    const previousPaid = sum(made.filter((p) => p.tag === 'previous' || p.tag === 'old'))
    const currentPaid = sum(made.filter((p) => p.tag === 'current'))
    const futureApplied = sum(pays.filter((p) => p.when === 'future'))
    const previousBalance = Math.max(0, debt - previousPaid - futureApplied)
    return { previousBalance, total: previousBalance + 1000 - currentPaid }
  }

  const arrange = (debt: number, pays: Pay[]) => {
    store.rows = [purchase('2026-09-15', 1000), ...pays.map((p) => payment(DATES[p.when], p.amount, TAGS[p.tag]))]
    const balance = debt + 1000 - pays.reduce((total, p) => total + p.amount, 0)
    accounts.byId = { [CARD.id]: { ...CARD, balance: decimal(balance) }, [SOURCE.id]: SOURCE }
  }
  const label = (debt: number, pays: Pay[]) => `debt ${debt}, ${pays.map((p) => `${p.when}/${p.tag}/${p.amount}`).join(' + ') || 'no payments'}`

  it('the invoice shows what the model says, for 2 initial debts and 137 sets of payments', async () => {
    const wrong: string[] = []
    for (const debt of [0, 300]) {
      for (const pays of sets) {
        arrange(debt, pays)
        const got = await invoice('2026-10')
        const want = expected(debt, pays)
        if (Math.abs(got.previousBalance - want.previousBalance) > 0.005 || Math.abs(got.total - want.total) > 0.005) {
          wrong.push(`${label(debt, pays)}: got ${got.previousBalance}/${got.total}, want ${want.previousBalance}/${want.total}`)
        }
      }
    }
    expect(wrong).toEqual([])
  })

  describe('paying the invoice', () => {
    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(new Date('2026-10-06T12:00:00Z'))
    })
    afterEach(() => {
      vi.useRealTimers()
    })

    it('works out the same previous balance and total as the invoice view, for every set', async () => {
      const wrong: string[] = []
      for (const debt of [0, 300]) {
        for (const pays of sets) {
          arrange(debt, pays)
          const want = expected(debt, pays)
          const result = await payCreditCardInvoice({ householdId: CARD.householdId, accountId: CARD.id, sourceAccountId: SOURCE.id, month: '2026-10', amount: 1 } as never).catch(
            () => ({ previousBalance: NaN, invoiceTotal: NaN }),
          )
          // A set that pays the invoice off completely is refused ("greater than zero"): nothing to compare there.
          if (want.total <= 0.005) continue
          if (Math.abs(result.previousBalance - want.previousBalance) > 0.005 || Math.abs(result.invoiceTotal - want.total) > 0.005) {
            wrong.push(`${label(debt, pays)}: got ${result.previousBalance}/${result.invoiceTotal}, want ${want.previousBalance}/${want.total}`)
          }
        }
      }
      expect(wrong).toEqual([])
    })
  })
})
