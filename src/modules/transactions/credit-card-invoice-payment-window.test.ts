import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType } from '../../shared/enums/index.js';

const db = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  accountUpdate: vi.fn(),
  accountFindUnique: vi.fn(),
  transactionFindFirst: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionUpdateMany: vi.fn(),
  transactionDelete: vi.fn(),
}));

vi.mock('../../shared/services/balance.service.js', () => ({
  recalculateCreditCardLimit: vi.fn(),
  applyTransfer: vi.fn(),
  applyAllocation: vi.fn(),
  applyDeallocation: vi.fn(),
  updateBalanceForNormalTransaction: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => {
  const tx = {
    account: { findFirst: db.accountFindFirst, update: db.accountUpdate, findUnique: db.accountFindUnique },
    transaction: {
      findFirst: db.transactionFindFirst,
      findMany: db.transactionFindMany,
      updateMany: db.transactionUpdateMany,
      delete: db.transactionDelete,
    },
  };
  return { prisma: { $transaction: async (fn: (client: typeof tx) => unknown) => fn(tx) } };
});

const { payCreditCardInvoice, undoCreditCardPayment } = await import('./transactions.service.js');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const decimal = (value: number) => ({ toNumber: () => value });
// Card with a due day and NO closing day stored: the derived one (9 - 7 = 2) must drive every window.
const CARD = { id: 'card-1', householdId: 'hh-1', type: AccountType.CREDIT, isActive: true, closingDay: null, dueDay: 9, balance: decimal(0) };
const SOURCE = { id: 'bank-1', householdId: 'hh-1', type: AccountType.CHECKING, isActive: true };
const STOP = new Error('stop after the invoice window queries');

beforeEach(() => {
  vi.clearAllMocks();
  db.accountFindFirst.mockImplementation(async ({ where }: { where: { id: string } }) => (where.id === CARD.id ? CARD : SOURCE));
});

describe('payCreditCardInvoice window', () => {
  it('reads the purchases before the invoice from the closing day derived from the due day, not the calendar month', async () => {
    db.transactionFindMany.mockRejectedValue(STOP);

    await expect(
      payCreditCardInvoice({ householdId: 'hh-1', accountId: CARD.id, sourceAccountId: SOURCE.id, amount: 10, month: '2026-10', description: 'x' } as never)
    ).rejects.toBe(STOP);

    expect(db.transactionFindMany.mock.calls[0]![0].where.date).toEqual({ lt: day('2026-09-02') });
  });
});

describe('undoCreditCardPayment window', () => {
  const payment = (date: string) => ({
    id: 'pay-1',
    householdId: 'hh-1',
    accountId: SOURCE.id,
    // Tag of the October invoice (zero-based month 9)
    attachmentUrl: `invoice_pay:${CARD.id}:2026-9`,
    amount: decimal(50),
    date: day(date),
  });

  async function undo(date: string) {
    db.transactionFindFirst.mockResolvedValue(payment(date));
    await undoCreditCardPayment({ accountId: CARD.id, transactionId: 'pay-1' } as never, 'hh-1');
    return db.transactionUpdateMany.mock.calls[0]![0].where.date as { gte: Date; lte: Date };
  }

  it('unpays purchases from the derived closing day of the previous month, not the first of the month', async () => {
    const range = await undo('2026-10-01');

    expect(range.gte).toEqual(day('2026-09-02'));
  });

  it('caps the unpaid range at the end of the invoice window when the payment is dated later', async () => {
    const range = await undo('2026-10-08');

    expect(range.lte).toEqual(day('2026-10-01'));
  });

  it('keeps the payment date as the cap when it is inside the window', async () => {
    const range = await undo('2026-09-20');

    expect(range.lte).toEqual(day('2026-09-20'));
  });
});
