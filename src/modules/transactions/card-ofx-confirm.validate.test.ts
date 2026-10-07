import { describe, expect, it, vi } from 'vitest';

vi.mock('../../shared/db/prisma.js', () => ({ prisma: {} }));
vi.mock('./transactions.service.js', () => ({ createTransaction: vi.fn() }));

const { validateConfirmLines } = await import('./card-ofx-confirm.service.js');
const { cardOfxRef, parseCardOfx } = await import('./parsers/ofx-card.parser.js');

// Invented data only.
const trn = (date: string, amount: string, fitid: string, memo: string) =>
  `<STMTTRN><DTPOSTED>${date}<TRNAMT>${amount}<FITID>${fitid}<MEMO>${memo}</STMTTRN>`;
const file = (...trns: string[]) =>
  `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST>${trns.join('')}</BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

const parsed = () =>
  parseCardOfx(
    file(
      trn('20251110', '-60.00', 'fit-a', 'Corner market'),
      trn('20251110', '-15.00', 'fit-b', 'Garage'),
      trn('20251110', '-15.00', 'fit-b', 'Garage'),
      trn('20251115', '-40.00', 'fit-c', 'Shoe store - Parcela 2/3'),
      trn('20251120', '10.00', 'fit-d', 'Estorno de Corner market'),
      trn('20251103', '85.00', 'fit-e', 'Pagamento recebido'),
    ),
  ).lines;

describe('validateConfirmLines', () => {
  it('accepts exactly what the parser produced, identical lines included', () => {
    expect(() => validateConfirmLines(parsed())).not.toThrow();
  });

  it('refuses a line whose content no longer fits its ref, naming the line', () => {
    const tamper: Array<[string, (l: ReturnType<typeof parsed>) => void]> = [
      ['amount', (l) => void (l[0]!.amount = 61)],
      ['memo', (l) => void (l[0]!.memo = 'Other market')],
      ['date', (l) => void (l[0]!.date = '2025-11-11')],
      ['fitid', (l) => void (l[0]!.fitid = 'fit-z')],
    ];
    for (const [what, change] of tamper) {
      const lines = parsed();
      change(lines);
      expect(() => validateConfirmLines(lines), what).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('Line 1') }));
    }
  });

  it('refuses a ref taken from another line, and identical lines out of order', () => {
    const lines = parsed();
    lines[0]!.ref = lines[3]!.ref;
    expect(() => validateConfirmLines(lines)).toThrow(expect.objectContaining({ statusCode: 400 }));

    const twins = parsed();
    [twins[1]!.ref, twins[2]!.ref] = [twins[2]!.ref, twins[1]!.ref];
    expect(() => validateConfirmLines(twins)).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('Line 2') }));
  });

  it('refuses a kind, type, merchant or installment that the memo does not give', () => {
    const cases: Array<[string, (l: ReturnType<typeof parsed>) => void]> = [
      ['kind', (l) => void (l[4]!.kind = 'payment')],
      ['purchase as income', (l) => void (l[0]!.type = 'INCOME')],
      ['merchant', (l) => void (l[3]!.merchant = 'Somewhere else')],
      ['installment', (l) => void (l[3]!.installment = { number: 1, total: 3 })],
      ['installment on a plain line', (l) => void (l[0]!.installment = { number: 1, total: 2 })],
    ];
    for (const [what, change] of cases) {
      const lines = parsed();
      change(lines);
      expect(() => validateConfirmLines(lines), what).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('refuses amounts and dates the importer cannot store', () => {
    for (const change of [
      (l: ReturnType<typeof parsed>) => void (l[0]!.amount = 60.001),
      (l: ReturnType<typeof parsed>) => void (l[0]!.amount = 0),
      (l: ReturnType<typeof parsed>) => void (l[0]!.date = '2025-02-30'),
      (l: ReturnType<typeof parsed>) => void (l[0]!.date = '10/11/2025'),
    ]) {
      const lines = parsed();
      change(lines);
      expect(() => validateConfirmLines(lines)).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('refuses a NUL in the text of a line even when its ref is consistent with it', () => {
    for (const field of ['memo', 'fitid'] as const) {
      const lines = parsed();
      const line = lines[0]!;
      line[field] = `${line[field]}\u0000`;
      if (field === 'memo') line.merchant = line.memo;
      line.ref = cardOfxRef(line.fitid, line.memo, -line.amount, line.date);
      expect(() => validateConfirmLines(lines), field).toThrow(expect.objectContaining({ statusCode: 400, message: expect.stringContaining('text') }));
    }
  });
});
