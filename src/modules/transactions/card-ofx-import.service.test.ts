import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountType } from '../../shared/enums/index.js';

// Invented data only: stores, amounts and ids below are fictitious.

type Where = Record<string, unknown>;
interface TxRow {
  id: string;
  householdId: string;
  sourceRef: string | null;
  attachmentUrl: string | null;
  date: Date;
  amount: number;
}
const db = vi.hoisted(() => ({
  account: null as Record<string, unknown> | null,
  transactions: [] as unknown[],
  calls: [] as Array<{ model: string; where: Where }>,
}));

const decimal = (value: number) => ({ toNumber: () => value });

/** The few `where` shapes the preview uses against the stored rows. */
function matchesTx(row: TxRow, where: Where): boolean {
  if (where.householdId !== undefined && row.householdId !== where.householdId) return false;
  const url = where.attachmentUrl as { startsWith?: string } | undefined;
  if (url?.startsWith && !row.attachmentUrl?.startsWith(url.startsWith)) return false;
  const date = where.date as { lte?: Date } | undefined;
  if (date?.lte && row.date.getTime() > date.lte.getTime()) return false;
  return true;
}

vi.mock('../../shared/db/prisma.js', () => ({
  // No create/update/delete here on purpose: a preview that tried to write would throw.
  prisma: {
    account: { findFirst: vi.fn(async () => db.account) },
    transaction: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        db.calls.push({ model: 'transaction', where });
        return (db.transactions as TxRow[])
          .filter((row) => matchesTx(row, where))
          .map((row) => ({ ...row, amount: decimal(row.amount) }));
      }),
    },
  },
}));

const { buildCardOfxPreview, invoiceMonthFromStatement, resolveCardAccount, MAX_CARD_OFX_LINES, MAX_LISTED_SKIPPED } = await import(
  './card-ofx-import.service.js'
);
const { cardOfxRef } = await import('./parsers/ofx-card.parser.js');

const HOUSEHOLD = 'house-1';
const CARD_ID = 'card-1';
// Due day 9, closing day 2 (the explicit one): the statement closing on 2026-12-02 is due 2026-12-09.
const CARD = { id: CARD_ID, name: 'Card', householdId: HOUSEHOLD, dueDay: 9, closingDay: 2 };

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

interface Trn {
  date: string;
  amount: string;
  fitid: string;
  memo: string;
}

function ofx(trns: Trn[], opts: { start?: string | null; end?: string | null; balance?: string | null } = {}): Buffer {
  const body = trns
    .map((t) => `<STMTTRN>\n<DTPOSTED>${t.date}\n<TRNAMT>${t.amount}\n<FITID>${t.fitid}\n<MEMO>${t.memo}\n</STMTTRN>`)
    .join('\n');
  return Buffer.from(
    [
      '<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>',
      '<BANKTRANLIST>',
      opts.start === null ? '' : `<DTSTART>${opts.start ?? '20261102'}`,
      opts.end === null ? '' : `<DTEND>${opts.end ?? '20261202'}`,
      body,
      '</BANKTRANLIST>',
      opts.balance == null ? '' : `<LEDGERBAL><BALAMT>${opts.balance}</LEDGERBAL>`,
      '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>',
    ].join('\n'),
  );
}

const MARKET: Trn = { date: '20261110', amount: '-60.00', fitid: 'fit-market', memo: 'Corner market' };
const SHOES: Trn = { date: '20261115', amount: '-40.00', fitid: 'fit-shoes', memo: 'Shoe store - Parcela 2/3' };
const REFUND: Trn = { date: '20261120', amount: '10.00', fitid: 'fit-refund', memo: 'Estorno de Corner market' };
const PAYMENT: Trn = { date: '20261103', amount: '85.00', fitid: 'fit-pay', memo: 'Pagamento recebido' };

const account = (extra: { dueDay?: number | null; closingDay?: number | null } = {}) => ({ ...CARD, ...extra });
const preview = (buffer: Buffer, options?: Parameters<typeof buildCardOfxPreview>[0]['options'], card = account()) =>
  buildCardOfxPreview({ account: card, buffer, options });

beforeEach(() => {
  db.account = { ...CARD, type: AccountType.CREDIT };
  db.transactions = [];
  db.calls = [];
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-12-05T12:00:00Z'));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('invoiceMonthFromStatement', () => {
  it.each([
    // closing, dueDay, closingDay, expected due month, guessed
    ['2026-12-02', 9, 2, { year: 2026, month: 12 }, false],
    ['2026-11-26', 3, 26, { year: 2026, month: 12 }, false],
    ['2026-12-30', 9, 30, { year: 2027, month: 1 }, false],
    // Due on the closing day itself: the invoice is due after the next closing, in the next month.
    ['2026-12-09', 9, 9, { year: 2027, month: 1 }, false],
    // The card's closing day wins over the file's closing day...
    ['2026-12-05', 9, 2, { year: 2026, month: 12 }, false],
    // ...and without one the day DTEND prints stands in for it.
    ['2026-12-20', 9, null, { year: 2027, month: 1 }, false],
    ['2026-12-02', 9, null, { year: 2026, month: 12 }, false],
    ['2026-12-02', null, null, { year: 2026, month: 12 }, true],
  ] as const)('closing %s, due day %s, closing day %s -> %o (guessed %s)', (closing, dueDay, closingDay, month, guessed) => {
    expect(invoiceMonthFromStatement(closing, { dueDay, closingDay })).toEqual({ month, guessed });
  });
});

describe('resolveCardAccount', () => {
  it('derives the closing day from the due day when the card has none', async () => {
    db.account = { ...CARD, type: AccountType.CREDIT, closingDay: null };

    await expect(resolveCardAccount(CARD_ID)).resolves.toMatchObject({ dueDay: 9, closingDay: 2 });
  });

  it('answers 404 when the account does not exist or is inactive', async () => {
    db.account = null;

    await expect(resolveCardAccount(CARD_ID)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('authorizes the household before saying that the account is not a card', async () => {
    db.account = { ...CARD, type: AccountType.CHECKING };
    const authorize = vi.fn().mockRejectedValue(Object.assign(new Error('forbidden'), { statusCode: 403 }));

    await expect(resolveCardAccount(CARD_ID, authorize)).rejects.toMatchObject({ statusCode: 403 });
    expect(authorize).toHaveBeenCalledWith(HOUSEHOLD);

    authorize.mockResolvedValue(undefined);
    await expect(resolveCardAccount(CARD_ID, authorize)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('buildCardOfxPreview', () => {
  it('reads the statement: month, period, totals without payments, and the balance as debt-positive', async () => {
    const result = await preview(ofx([MARKET, SHOES, REFUND, PAYMENT], { balance: '-90.00' }));

    expect(result).toMatchObject({
      accountId: CARD_ID,
      month: { year: 2026, month: 12 },
      monthKey: '2026-12',
      monthSource: 'statement',
      period: { start: '2026-11-02', end: '2026-12-02' },
      ofxTotal: 90,
      ledgerBalance: 90,
      totals: { lines: 4, new: 3, payments: 1, skipped: 0 },
      warnings: [],
    });
    expect(result.lines.map((l) => [l.kind, l.status, l.amount])).toEqual([
      ['purchase', 'new', 60],
      ['purchase', 'new', 40],
      ['refund', 'new', 10],
      ['payment', 'payment', 85],
    ]);
    expect(result.lines[1]).toMatchObject({ merchant: 'Shoe store', installment: { number: 2, total: 3 } });
  });

  it('reads no transaction but the invoice payments of the card, within its household', async () => {
    db.transactions = [
      { id: 't1', householdId: HOUSEHOLD, sourceRef: null, attachmentUrl: null, date: day('2026-11-10'), amount: 60 },
    ];

    const result = await preview(ofx([MARKET, SHOES, REFUND, PAYMENT]));

    expect(result.lines.map((l) => l.status)).toEqual(['new', 'new', 'new', 'payment']);
    expect(db.calls.length).toBeGreaterThan(0);
    expect(db.calls.every((c) => c.where.householdId === HOUSEHOLD && JSON.stringify(c.where.attachmentUrl).includes('invoice_pay:'))).toBe(true);
  });

  it('uses the month the caller overrides, and says so', async () => {
    const result = await preview(ofx([MARKET]), { monthOverride: { year: 2027, month: 2 } });

    expect(result).toMatchObject({ month: { year: 2027, month: 2 }, monthKey: '2027-02', monthSource: 'override' });
  });

  it('warns about what the file or the card leaves out', async () => {
    const noEnd = await preview(ofx([MARKET, SHOES], { end: null }));
    expect(noEnd.period).toEqual({ start: '2026-11-02', end: '2026-11-15' });
    expect(noEnd.ledgerBalance).toBeNull();
    expect(noEnd.warnings).toEqual(['period-end-missing']);

    const noDueDay = await preview(ofx([MARKET]), undefined, account({ dueDay: null }));
    expect(noDueDay.month).toEqual({ year: 2026, month: 12 });
    expect(noDueDay.warnings).toContain('card-without-due-day');
    expect(noDueDay.warnings).not.toContain('card-without-closing-day');

    const bare = await preview(ofx([MARKET]), undefined, account({ dueDay: null, closingDay: null }));
    expect(bare.warnings).toEqual(['card-without-due-day', 'card-without-closing-day']);
  });

  it('warns when LEDGERBAL differs from the lines by more than five cents, and only then', async () => {
    const lines = [MARKET, SHOES]; // 100.00
    expect((await preview(ofx(lines, { balance: '-100.05' }))).warnings).toEqual([]);
    expect((await preview(ofx(lines, { balance: '-99.95' }))).warnings).toEqual([]);
    expect((await preview(ofx(lines, { balance: '-100.06' }))).warnings).toEqual(['balance-mismatch']);
    expect((await preview(ofx(lines, { balance: '-90.00' }))).warnings).toEqual(['balance-mismatch']);
  });

  it('reports the lines it could not read and the parser warnings by code', async () => {
    const buffer = Buffer.from(
      ofx([MARKET]).toString('utf8').replace('</BANKTRANLIST>', '<STMTTRN><DTPOSTED>20261111<TRNAMT>abc<FITID>x1<MEMO>Broken</STMTTRN></BANKTRANLIST>') +
        ofx([SHOES]).toString('utf8'),
    );

    const result = await preview(buffer);

    expect(result.skipped).toEqual([{ position: 2, reason: 'invalid-amount' }]);
    expect(result.totals).toMatchObject({ lines: 1, skipped: 1 });
    expect(result.warnings).toEqual(['multiple-statements']);
  });

  it('lists at most 100 unreadable transactions, with the full count in the totals (580 thousand empty ones do not blow up)', async () => {
    const empty = '<STMTTRN>'.repeat(580_000);
    const buffer = Buffer.from(ofx([MARKET]).toString('utf8').replace('</BANKTRANLIST>', `${empty}</BANKTRANLIST>`));
    expect(buffer.length).toBeLessThan(5 * 1024 * 1024);

    const result = await preview(buffer);

    expect(result.skipped).toHaveLength(MAX_LISTED_SKIPPED);
    expect(result.skipped[0]).toMatchObject({ position: 2 });
    expect(result.totals).toMatchObject({ lines: 1, skipped: 580_000 });
  });

  it('refuses a file without lines, and one with more lines than the importer takes', async () => {
    await expect(preview(ofx([]))).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('No readable') });

    const many = Array.from({ length: MAX_CARD_OFX_LINES + 1 }, (_, i) => ({
      date: '20261110',
      amount: '-1.00',
      fitid: `fit-${i}`,
      memo: `Shop ${i}`,
    }));
    await expect(preview(ofx(many))).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining('at most 1000') });
    await expect(preview(ofx(many.slice(0, MAX_CARD_OFX_LINES)))).resolves.toMatchObject({ totals: { lines: MAX_CARD_OFX_LINES } });
  });

  it('rejects a bank account statement', async () => {
    const bank = Buffer.from('<OFX><BANKMSGSRSV1><STMTRS><BANKTRANLIST></BANKTRANLIST></STMTRS></BANKMSGSRSV1></OFX>');

    await expect(preview(bank)).rejects.toMatchObject({ statusCode: 400 });
  });
});

describe('buildCardOfxPreview: the previous invoice payment', () => {
  // The statement closing 2026-12-02 is the December invoice; "Pagamento recebido" pays November, tagged `2026-10`.
  const tag = (month0: number, card = CARD_ID) => `invoice_pay:${card}:2026-${month0}`;
  const paid = (id: string, amount: number, date: string, attachmentUrl: string): TxRow => ({
    id,
    householdId: HOUSEHOLD,
    sourceRef: null,
    attachmentUrl,
    date: day(date),
    amount,
  });

  it('has no payment section when the file has no payment line', async () => {
    db.transactions = [paid('p1', 85, '2026-11-03', tag(10))];

    expect((await preview(ofx([MARKET]))).payment).toBeNull();
  });

  it('matches the payment recorded for that invoice, counted by its tag and not by its date', async () => {
    // Dated 3 Nov, i.e. in the December window; tagged for the November invoice.
    db.transactions = [paid('p1', 85, '2026-11-03', tag(10))];

    const result = await preview(ofx([MARKET, PAYMENT]));

    expect(result.payment).toEqual({
      invoiceMonthKey: '2026-11',
      statementTotal: 85,
      recorded: [{ transactionId: 'p1', amount: 85, date: '2026-11-03' }],
      recordedTotal: 85,
      state: 'matches',
    });
  });

  it('says differs when the recorded amount is not the bank amount, and sums split payments', async () => {
    db.transactions = [paid('p1', 80, '2026-11-03', tag(10))];
    expect((await preview(ofx([PAYMENT]))).payment).toMatchObject({ state: 'differs', recordedTotal: 80 });

    db.transactions = [paid('p1', 50, '2026-11-03', tag(10)), paid('p2', 35, '2026-11-04', tag(10))];
    expect((await preview(ofx([PAYMENT]))).payment).toMatchObject({ state: 'matches', recordedTotal: 85 });
  });

  it('says missing when nothing was recorded for that invoice', async () => {
    // Payments of other invoices (the one before, the one after) and of other cards do not count.
    db.transactions = [
      paid('p0', 85, '2026-10-03', tag(9)),
      paid('p2', 85, '2026-11-03', tag(11)),
      paid('p3', 85, '2026-11-03', tag(10, 'card-2')),
    ];

    expect((await preview(ofx([PAYMENT]))).payment).toMatchObject({ state: 'missing', recorded: [], recordedTotal: 0 });
  });

  it('does not count a payment dated after today as recorded', async () => {
    db.transactions = [paid('p1', 85, '2026-12-09', tag(10))];

    expect((await preview(ofx([PAYMENT]))).payment).toMatchObject({ state: 'missing' });
  });

  it('does not claim a match when the file has several payment lines (some may be advances)', async () => {
    const advance: Trn = { date: '20261125', amount: '20.00', fitid: 'fit-adv', memo: 'Pagamento recebido' };
    db.transactions = [paid('p1', 85, '2026-11-03', tag(10))];

    const result = await preview(ofx([PAYMENT, advance]));

    expect(result.payment).toMatchObject({ state: 'undetermined', statementTotal: 105, recordedTotal: 85 });
    expect(result.totals.payments).toBe(2);
  });

  it('follows the overridden month: the invoice paid is the month before it', async () => {
    db.transactions = [paid('p1', 85, '2026-12-03', tag(11))];

    const result = await preview(ofx([PAYMENT]), { monthOverride: { year: 2027, month: 1 } });

    expect(result.payment).toMatchObject({ invoiceMonthKey: '2026-12', state: 'matches' });
  });
});
