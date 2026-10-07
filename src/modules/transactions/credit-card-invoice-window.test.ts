import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountType } from '../../shared/enums/index.js';

const db = vi.hoisted(() => ({
  accountFindFirst: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionCount: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findFirst: db.accountFindFirst },
    transaction: { findMany: db.transactionFindMany, count: db.transactionCount },
    recurringTransaction: { findMany: async () => [] },
  },
}));

const { calculateCreditCardInvoice, creditCardInvoiceWindow } = await import('./transactions.service.js');

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const decimal = (value: number) => ({ toNumber: () => value });
const CARD = { id: 'card-1', householdId: 'hh-1', type: AccountType.CREDIT, isActive: true, closingDay: 2, dueDay: 9, balance: decimal(0) };

describe('creditCardInvoiceWindow', () => {
  it('runs from the closing day of the previous month to the day before the closing day, in UTC dates', () => {
    const w = creditCardInvoiceWindow(2026, 10, 2);

    expect(w.start).toEqual(day('2026-09-02'));
    expect(w.end).toEqual(day('2026-10-01'));
    expect(w.previousStart).toEqual(day('2026-08-02'));
  });

  it('crosses the year and keeps a closing day of 1 inside the month before', () => {
    expect(creditCardInvoiceWindow(2026, 1, 2)).toMatchObject({ start: day('2025-12-02'), end: day('2026-01-01') });
    expect(creditCardInvoiceWindow(2026, 3, 1)).toMatchObject({ start: day('2026-02-01'), end: day('2026-02-28') });
  });

  it('closes on the last day of a short month when the closing day does not exist in it', () => {
    // Closing day 30: February closes on the 28th, so the March window starts where the February one ended
    expect(creditCardInvoiceWindow(2026, 3, 30)).toMatchObject({ start: day('2026-02-28'), end: day('2026-03-29'), previousStart: day('2026-01-30') });
    expect(creditCardInvoiceWindow(2026, 2, 30)).toMatchObject({ start: day('2026-01-30'), end: day('2026-02-27') });
  });

  it('is the calendar month without a closing day', () => {
    expect(creditCardInvoiceWindow(2026, 2, null)).toEqual({
      start: day('2026-02-01'),
      end: day('2026-02-28'),
      previousStart: day('2026-01-01'),
    });
  });
});

describe('calculateCreditCardInvoice window', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.accountFindFirst.mockResolvedValue(CARD);
    db.transactionFindMany.mockResolvedValue([]);
    db.transactionCount.mockResolvedValue(0);
  });

  it('queries the invoice purchases with date-only UTC bounds, so the closing day is in one invoice only', async () => {
    await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 });

    const dateFilters = db.transactionFindMany.mock.calls
      .map(([args]) => JSON.stringify(args.where))
      .filter((text) => text.includes('"gte"'));
    expect(dateFilters.length).toBeGreaterThan(0);
    for (const text of dateFilters) {
      expect(text).toContain('"gte":"2026-09-02T00:00:00.000Z"');
      expect(text).toContain('"lte":"2026-10-01T00:00:00.000Z"');
    }
    const before = db.transactionFindMany.mock.calls.map(([args]) => JSON.stringify(args.where)).filter((t) => t.includes('"lt"'));
    for (const text of before) expect(text).toContain('"lt":"2026-09-02T00:00:00.000Z"');
  });

  it('uses the closing day derived from the due day (due 9 -> closing 2) when the card has none stored', async () => {
    db.accountFindFirst.mockResolvedValue({ ...CARD, closingDay: null, dueDay: 9 });

    await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 });

    const inWindow = db.transactionFindMany.mock.calls.map(([args]) => JSON.stringify(args.where)).filter((t) => t.includes('"gte"'));
    expect(inWindow.length).toBeGreaterThan(0);
    for (const text of inWindow) {
      expect(text).toContain('"gte":"2026-09-02T00:00:00.000Z"');
      expect(text).toContain('"lte":"2026-10-01T00:00:00.000Z"');
    }
  });

  it('keeps the calendar month when the card has neither closing nor due day', async () => {
    db.accountFindFirst.mockResolvedValue({ ...CARD, closingDay: null, dueDay: null });

    await calculateCreditCardInvoice(CARD.id, '2026-10', CARD.householdId, { limit: 5 });

    const inWindow = db.transactionFindMany.mock.calls.map(([args]) => JSON.stringify(args.where)).filter((t) => t.includes('"gte"'));
    for (const text of inWindow) {
      expect(text).toContain('"gte":"2026-10-01T00:00:00.000Z"');
      expect(text).toContain('"lte":"2026-10-31T00:00:00.000Z"');
    }
  });
});
