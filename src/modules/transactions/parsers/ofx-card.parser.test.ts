import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { parseOfx } from './ofx.parser.js';
import {
  cardOfxRef,
  classifyCardOfxLine,
  fitidToken,
  installmentFromMemo,
  merchantFromMemo,
  parseCardOfx,
  type CardOfxStatementLine,
} from './ofx-card.parser.js';

// Invented data only: stores, amounts and ids below are fictitious.

interface Trn {
  type?: string;
  date: string;
  amount: string;
  fitid?: string | null;
  memo?: string | null;
  name?: string;
}

const FIT_A = '0a1b2c3d-0000-4000-8000-00000000000a';
const FIT_B = '0a1b2c3d-0000-4000-8000-00000000000b';
const FIT_C = '0a1b2c3d-0000-4000-8000-00000000000c';
const FIT_D = '0a1b2c3d-0000-4000-8000-00000000000d';
const FIT_E = '0a1b2c3d-0000-4000-8000-00000000000e';

/** Nubank-like SGML: elements closed on the same line, CHARSET declared as 1252. */
function sgml(trns: Trn[], opts: { start?: string; end?: string; balance?: string | null; closeElements?: boolean } = {}) {
  const close = opts.closeElements ?? true;
  const el = (tag: string, value: string) => (close ? `<${tag}>${value}</${tag}>` : `<${tag}>${value}`);
  const body = trns
    .map((t) =>
      [
        '<STMTTRN>',
        el('TRNTYPE', t.type ?? (t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT')),
        el('DTPOSTED', t.date),
        el('TRNAMT', t.amount),
        ...(t.fitid === null ? [] : [el('FITID', t.fitid ?? FIT_A)]),
        ...(t.memo === null || t.memo === undefined ? [] : [el('MEMO', t.memo)]),
        ...(t.name ? [el('NAME', t.name)] : []),
        '</STMTTRN>',
      ].join('\n'),
    )
    .join('\n');
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'ENCODING:USASCII',
    'CHARSET:1252',
    '',
    '<OFX>',
    '<CREDITCARDMSGSRSV1>',
    '<CCSTMTTRNRS>',
    '<CCSTMTRS>',
    el('CURDEF', 'BRL'),
    '<BANKTRANLIST>',
    el('DTSTART', opts.start ?? '20261102000000[-3:BRT]'),
    el('DTEND', opts.end ?? '20261202000000[-3:BRT]'),
    body,
    '</BANKTRANLIST>',
    ...(opts.balance === null ? [] : ['<LEDGERBAL>', el('BALAMT', opts.balance ?? '-1.00'), el('DTASOF', '20261202'), '</LEDGERBAL>']),
    '</CCSTMTRS>',
    '</CCSTMTTRNRS>',
    '</CREDITCARDMSGSRSV1>',
    '</OFX>',
    '',
  ].join('\n');
}

/** OFX 2.x: XML declaration, processing instruction, everything on one line. */
function xml(trns: Trn[]) {
  const body = trns
    .map(
      (t) =>
        `<STMTTRN><TRNTYPE>${t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}</TRNTYPE><DTPOSTED>${t.date}</DTPOSTED>` +
        `<TRNAMT>${t.amount}</TRNAMT><FITID>${t.fitid ?? FIT_A}</FITID><MEMO>${t.memo ?? ''}</MEMO></STMTTRN>`,
    )
    .join('');
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="no"?><?OFX OFXHEADER="200" VERSION="220" SECURITY="NONE" ' +
    'OLDFILEUID="NONE" NEWFILEUID="NONE"?><OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><TRNUID>1</TRNUID><CCSTMTRS>' +
    '<CURDEF>BRL</CURDEF><CCACCTFROM><ACCTID>card-1</ACCTID></CCACCTFROM><BANKTRANLIST><DTSTART>20261102</DTSTART>' +
    `<DTEND>20261202</DTEND>${body}</BANKTRANLIST><LEDGERBAL><BALAMT>-150.25</BALAMT><DTASOF>20261202</DTASOF>` +
    '</LEDGERBAL></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>'
  );
}

/** A bank account statement (STMTRS), not a card invoice. */
const BANK_STATEMENT = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105<TRNAMT>-10.00<FITID>x1<MEMO>Bakery Example
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;

const NOVEMBER: Trn[] = [
  { date: '20261130000000[-3:BRT]', amount: '-89.90', fitid: FIT_A, memo: 'Mercado Beta' },
  { date: '20261128000000[-3:BRT]', amount: '-120.00', fitid: FIT_B, memo: 'Loja Alfa - Parcela 3/10' },
  { date: '20261127000000[-3:BRT]', amount: '-45.50', fitid: FIT_C, memo: 'Curso Gama - NuPay - Parcela 10/18' },
  { date: '20261127000000[-3:BRT]', amount: '33.10', fitid: FIT_C, memo: 'Desconto Antecipação Curso Gama' },
  { date: '20261125000000[-3:BRT]', amount: '59.99', fitid: FIT_D, memo: 'Estorno de "Loja Ômega" (Loja Ômega)' },
  { date: '20261103000000[-3:BRT]', amount: '1520.37', fitid: FIT_E, memo: 'Pagamento recebido' },
];

function byMemo(lines: CardOfxStatementLine[], memo: string): CardOfxStatementLine {
  const line = lines.find((l) => l.memo === memo);
  if (!line) throw new Error(`no line with memo ${memo}`);
  return line;
}

describe('parseCardOfx (SGML 1.x)', () => {
  it('reads every transaction with its kind, type, sign-free amount, local day and memo', () => {
    const result = parseCardOfx(Buffer.from(sgml(NOVEMBER, { balance: '-1185.38' }), 'utf8'));

    expect(result.lines).toHaveLength(6);
    expect(result.skipped).toEqual([]);
    expect(result.lines.map((l) => [l.kind, l.type, l.amount, l.date])).toEqual([
      ['purchase', 'EXPENSE', 89.9, '2026-11-30'],
      ['purchase', 'EXPENSE', 120, '2026-11-28'],
      ['purchase', 'EXPENSE', 45.5, '2026-11-27'],
      ['discount', 'INCOME', 33.1, '2026-11-27'],
      ['refund', 'INCOME', 59.99, '2026-11-25'],
      ['payment', 'INCOME', 1520.37, '2026-11-03'],
    ]);
    expect(result.lines.every((l) => l.amount > 0)).toBe(true);
  });

  it('reads the period (DTSTART/DTEND) as local days and the ledger balance', () => {
    const result = parseCardOfx(sgml(NOVEMBER, { balance: '-1185.38' }));

    expect(result.period).toEqual({ start: '2026-11-02', end: '2026-12-02' });
    expect(result.balance).toBe(-1185.38);
  });

  it('takes the installment from "Parcela N/M" and strips it, and " - NuPay", from the merchant', () => {
    const lines = parseCardOfx(sgml(NOVEMBER)).lines;

    expect(byMemo(lines, 'Loja Alfa - Parcela 3/10')).toMatchObject({
      installment: { number: 3, total: 10 },
      merchant: 'Loja Alfa',
    });
    expect(byMemo(lines, 'Curso Gama - NuPay - Parcela 10/18')).toMatchObject({
      installment: { number: 10, total: 18 },
      merchant: 'Curso Gama',
    });
    expect(byMemo(lines, 'Mercado Beta')).toMatchObject({ installment: null, merchant: 'Mercado Beta' });
  });

  it('builds the ref from the FITID and the first 8 hex of sha1(memo|signed amount|date)', () => {
    const line = byMemo(parseCardOfx(sgml(NOVEMBER)).lines, 'Loja Alfa - Parcela 3/10');
    const hash = createHash('sha1').update('Loja Alfa - Parcela 3/10|-120.00|2026-11-28').digest('hex').slice(0, 8);

    expect(line.ref).toBe(`ofx:${FIT_B}:${hash}`);
    expect(line.fitid).toBe(FIT_B);
  });

  it('gives lines of one purchase (same FITID) different refs, and the same refs on every parse', () => {
    const first = parseCardOfx(sgml(NOVEMBER)).lines;
    const second = parseCardOfx(sgml([...NOVEMBER].reverse())).lines;

    const plan = first.filter((l) => l.fitid === FIT_C);
    expect(plan).toHaveLength(2);
    expect(plan[0]!.ref).not.toBe(plan[1]!.ref);
    expect(new Set(second.map((l) => l.ref))).toEqual(new Set(first.map((l) => l.ref)));
  });

  it('numbers identical lines in file order so their refs stay unique and stable', () => {
    const twin: Trn = { date: '20261110', amount: '-15.00', fitid: FIT_A, memo: 'Estacionamento Zeta' };
    const lines = parseCardOfx(sgml([twin, twin, twin])).lines;

    expect(new Set(lines.map((l) => l.ref)).size).toBe(3);
    expect(lines[0]!.ref).toBe(cardOfxRef(FIT_A, 'Estacionamento Zeta', -15, '2026-11-10'));
    expect(lines[1]!.ref).toBe(cardOfxRef(FIT_A, 'Estacionamento Zeta', -15, '2026-11-10', 2));
    expect(lines[2]!.ref).toBe(cardOfxRef(FIT_A, 'Estacionamento Zeta', -15, '2026-11-10', 3));
  });

  it('reads SGML whose elements have no closing tags', () => {
    const lines = parseCardOfx(sgml(NOVEMBER.slice(0, 2), { closeElements: false })).lines;

    expect(lines.map((l) => [l.memo, l.amount, l.date])).toEqual([
      ['Mercado Beta', 89.9, '2026-11-30'],
      ['Loja Alfa - Parcela 3/10', 120, '2026-11-28'],
    ]);
  });

  it('decodes UTF-8 even though the header declares CHARSET:1252', () => {
    const lines = parseCardOfx(Buffer.from(sgml(NOVEMBER), 'utf8')).lines;

    expect(byMemo(lines, 'Desconto Antecipação Curso Gama').kind).toBe('discount');
    expect(lines.some((l) => l.memo === 'Estorno de "Loja Ômega" (Loja Ômega)')).toBe(true);
  });

  it('falls back to windows-1252 when the bytes are not valid UTF-8', () => {
    const trns: Trn[] = [
      { date: '20261112', amount: '-18.00', fitid: FIT_A, memo: 'Açaí Café' },
      { date: '20261127', amount: '7.30', fitid: FIT_B, memo: 'Desconto Antecipação Curso Gama' },
    ];
    const bytes = Buffer.from(sgml(trns), 'latin1'); // one byte per accented letter, as a cp1252 export writes

    const lines = parseCardOfx(bytes).lines;

    expect(lines.map((l) => l.memo)).toEqual(['Açaí Café', 'Desconto Antecipação Curso Gama']);
    expect(lines[1]!.kind).toBe('discount');
  });

  it('decodes character references in memos', () => {
    const lines = parseCardOfx(sgml([{ date: '20261112', amount: '-30.00', memo: 'Pão &amp; Cia &#8211; Centro' }])).lines;

    expect(lines[0]!.memo).toBe('Pão & Cia – Centro');
  });

  it('falls back to NAME, then to the default description, when MEMO is missing', () => {
    const lines = parseCardOfx(
      sgml([
        { date: '20261112', amount: '-30.00', memo: null, name: 'Livraria Teta' },
        { date: '20261113', amount: '-31.00', memo: null },
      ]),
    ).lines;

    expect(lines.map((l) => l.memo)).toEqual(['Livraria Teta', 'Imported transaction']);
  });

  it('skips transactions without amount, valid date or FITID, and zero amounts, saying why', () => {
    const result = parseCardOfx(
      sgml([
        { date: '20261112', amount: 'abc', memo: 'Sem valor' },
        { date: '20261332', amount: '-10.00', memo: 'Data impossível' },
        { date: '20261112', amount: '-10.00', fitid: null, memo: 'Sem FITID' },
        { date: '20261112', amount: '0.00', memo: 'Zerada' },
        { date: '20261112', amount: '-10,50', memo: 'Vírgula decimal' },
      ]),
    );

    expect(result.lines.map((l) => [l.memo, l.amount])).toEqual([['Vírgula decimal', 10.5]]);
    expect(result.skipped.map((s) => s.position)).toEqual([1, 2, 3, 4]);
    expect(result.skipped.map((s) => s.reason)).toEqual(['invalid-amount', 'invalid-date', 'missing-id', 'zero-amount']);
  });

  it('returns null period and balance when the statement does not carry them', () => {
    const text = sgml(NOVEMBER.slice(0, 1), { balance: null }).replace(/<DTSTART>[^\n]*\n/, '').replace(/<DTEND>[^\n]*\n/, '');

    const result = parseCardOfx(text);

    expect(result.period).toEqual({ start: null, end: null });
    expect(result.balance).toBeNull();
    expect(result.lines).toHaveLength(1);
  });

  it('rejects a bank account statement with a 400 that points to the generic importer', () => {
    expect(() => parseCardOfx(BANK_STATEMENT)).toThrow(
      expect.objectContaining({ statusCode: 400, message: expect.stringContaining('CCSTMTRS') }),
    );
  });

  it('rejects malformed content (no OFX at all) with a 400', () => {
    for (const text of ['', 'not an ofx file', '<OFX><SIGNONMSGSRSV1></SIGNONMSGSRSV1></OFX>']) {
      expect(() => parseCardOfx(Buffer.from(text)), text).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
  });

  it('reads only the first card statement of a file with two, with a warning', () => {
    const one = sgml(NOVEMBER.slice(0, 1));
    const second = sgml(NOVEMBER.slice(1, 2)).slice(one.indexOf('<OFX>'));

    const result = parseCardOfx(one + second);

    expect(result.lines.map((l) => l.memo)).toEqual(['Mercado Beta']);
    expect(result.warnings).toEqual(['multiple-statements']);
  });

  it('is what the statement parser cannot do: it drops the second line of a FITID the card repeats across installments', () => {
    const bank = parseOfx(sgml(NOVEMBER));

    expect(bank.warnings).toEqual(['card-statement']);
    expect(bank.rows).toHaveLength(5);
    expect(bank.skipped).toEqual([{ line: 4, reason: 'repeated-id' }]);
    expect(parseCardOfx(sgml(NOVEMBER)).lines).toHaveLength(6);
  });
});

describe('parseCardOfx: CDATA and UTF-16', () => {
  const cdata = (memo: string, fitid: string) =>
    `<OFX><CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS><BANKTRANLIST><STMTTRN><TRNTYPE>DEBIT</TRNTYPE><DTPOSTED>20261112</DTPOSTED><TRNAMT>-30.00</TRNAMT><FITID><![CDATA[${fitid}]]></FITID><MEMO><![CDATA[${memo}]]></MEMO></STMTTRN></BANKTRANLIST></CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1></OFX>`;

  it('reads memos and ids written as CDATA, literally (no entity decoding inside it)', () => {
    const [line] = parseCardOfx(cdata('Shop & Co - Parcela 1/2 &amp; more', 'fit-<x>')).lines;

    expect(line).toMatchObject({ memo: 'Shop & Co - Parcela 1/2 &amp; more', fitid: 'fit-<x>', installment: { number: 1, total: 2 } });
    expect(line!.ref.startsWith('ofx:h')).toBe(true); // the id has separators, so it is hashed
  });

  it('reads a CDATA memo that spans lines as one blank-normalized memo', () => {
    const [line] = parseCardOfx(cdata(['Shop', '  Two'].join(String.fromCharCode(10)), 'fit-a')).lines;

    expect(line!.memo).toBe('Shop Two');
  });

  it.each<[string, (text: string) => Buffer]>([
    ['UTF-16 little endian', (t) => Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(t, 'utf16le')])],
    ['UTF-16 big endian', (t) => Buffer.concat([Buffer.from([0xfe, 0xff]), Buffer.from(t, 'utf16le').swap16()])],
  ])('reads %s with a byte order mark, accents included', (_name, encode) => {
    const lines = parseCardOfx(encode(sgml([{ date: '20261112', amount: '-18.00', fitid: FIT_A, memo: 'Açaí Café' }]))).lines;

    expect(lines.map((l) => [l.memo, l.amount])).toEqual([['Açaí Café', 18]]);
  });
});

describe('parseCardOfx: values the confirm would reject', () => {
  it('skips amounts in scientific notation and amounts above the import cap, saying why', () => {
    const result = parseCardOfx(
      sgml([
        { date: '20261112', amount: '-1e307', fitid: FIT_A, memo: 'Notação científica' },
        { date: '20261112', amount: '-5000000000.00', fitid: FIT_B, memo: 'Acima do limite' },
        { date: '20261112', amount: '1000000000.01', fitid: FIT_C, memo: 'Um centavo acima' },
        { date: '20261112', amount: '-1000000000.00', fitid: FIT_D, memo: 'No limite' },
      ]),
    );

    expect(result.lines.map((l) => [l.memo, l.amount])).toEqual([['No limite', 1_000_000_000]]);
    expect(result.skipped).toEqual([
      { position: 1, reason: 'invalid-amount' },
      { position: 2, reason: 'amount-too-large' },
      { position: 3, reason: 'amount-too-large' },
    ]);
  });

  it('skips a FITID over 255 characters and keeps one of exactly 255', () => {
    const result = parseCardOfx(
      sgml([
        { date: '20261112', amount: '-1.00', fitid: 'a'.repeat(300), memo: 'Longo demais' },
        { date: '20261112', amount: '-2.00', fitid: 'b'.repeat(255), memo: 'No limite' },
      ]),
    );

    expect(result.lines.map((l) => [l.memo, l.fitid.length])).toEqual([['No limite', 255]]);
    expect(result.lines[0]!.ref.length).toBeLessThanOrEqual(120);
    expect(result.skipped).toEqual([{ position: 1, reason: 'id-too-long' }]);
  });

  it('measures the FITID after decoding its character references', () => {
    const encoded = '&amp;'.repeat(60); // 300 characters in the file, 60 once decoded
    const result = parseCardOfx(sgml([{ date: '20261112', amount: '-1.00', fitid: encoded, memo: 'Entidades' }]));

    expect(result.lines).toHaveLength(1);
    expect(result.lines[0]!.fitid).toBe('&'.repeat(60));
  });
});

describe('parseCardOfx: character references', () => {
  it('decodes only the known named entities, never names that exist on Object.prototype', () => {
    const memo = 'Loja &constructor; &toString; &__proto__; &hasOwnProperty; &amp; &LT;';
    const [line] = parseCardOfx(sgml([{ date: '20261112', amount: '-1.00', memo }])).lines;

    expect(line!.memo).toBe('Loja &constructor; &toString; &__proto__; &hasOwnProperty; & <');
  });
});

describe('parseCardOfx (XML 2.x)', () => {
  it('reads one-line XML with closing tags like the SGML flavour', () => {
    const result = parseCardOfx(
      xml([
        { date: '20261130120000', amount: '-100.25', fitid: FIT_A, memo: 'Fuel Delta' },
        { date: '20261129', amount: '-50.00', fitid: FIT_B, memo: 'Loja Alfa - Parcela 1/2' },
      ]),
    );

    expect(result.period).toEqual({ start: '2026-11-02', end: '2026-12-02' });
    expect(result.balance).toBe(-150.25);
    expect(result.lines.map((l) => [l.kind, l.amount, l.date, l.merchant, l.installment])).toEqual([
      ['purchase', 100.25, '2026-11-30', 'Fuel Delta', null],
      ['purchase', 50, '2026-11-29', 'Loja Alfa', { number: 1, total: 2 }],
    ]);
  });
});

describe('card OFX helpers', () => {
  it('classifies by sign and Nubank texts, ignoring accents and case', () => {
    expect(classifyCardOfxLine('Qualquer compra', -10)).toBe('purchase');
    expect(classifyCardOfxLine('Pagamento recebido', 10)).toBe('payment');
    expect(classifyCardOfxLine('PAGAMENTO RECEBIDO', 10)).toBe('payment');
    expect(classifyCardOfxLine('Desconto Antecipação Loja', 10)).toBe('discount');
    expect(classifyCardOfxLine('desconto antecipacao loja', 10)).toBe('discount');
    expect(classifyCardOfxLine('Estorno de "Loja"', 10)).toBe('refund');
    // A negative line is a charge whatever its text says.
    expect(classifyCardOfxLine('Pagamento recebido', -10)).toBe('purchase');
  });

  it('accepts only real installment plans (1 <= N <= M <= 99)', () => {
    expect(installmentFromMemo('Loja - Parcela 3/10')).toEqual({ number: 3, total: 10 });
    expect(installmentFromMemo('Loja - parcela 3 / 10')).toEqual({ number: 3, total: 10 });
    expect(installmentFromMemo('Loja - Parcela 11/10')).toBeNull();
    expect(installmentFromMemo('Loja - Parcela 0/10')).toBeNull();
    expect(installmentFromMemo('Loja - Parcela 3/100')).toBeNull();
    expect(installmentFromMemo('Loja 3/10')).toBeNull();
  });

  it('strips installment and NuPay suffixes from the merchant in any order', () => {
    expect(merchantFromMemo('Loja X - NuPay - Parcela 3/10')).toBe('Loja X');
    expect(merchantFromMemo('Loja X - Parcela 3/10 - NuPay')).toBe('Loja X');
    expect(merchantFromMemo('Loja X')).toBe('Loja X');
  });

  it('hashes FITIDs that are long or carry separators, so refs stay short and parseable', () => {
    expect(fitidToken(FIT_A)).toBe(FIT_A);
    const long = fitidToken('x'.repeat(200));
    expect(long).toMatch(/^h[0-9a-f]{32}$/);
    expect(fitidToken('a:b|c,d')).toMatch(/^h[0-9a-f]{32}$/);
    expect(cardOfxRef('y'.repeat(255), 'memo', -1, '2026-11-01').length).toBeLessThanOrEqual(120);
  });
});
