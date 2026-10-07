import { describe, expect, it } from 'vitest';

import { parseOfx } from './ofx.parser.js';

const wrap = (entries: string, body = 'BANKMSGSRSV1><STMTTRNRS><STMTRS') =>
  `OFXHEADER:100\nDATA:OFXSGML\n<OFX><${body}><BANKTRANLIST>\n${entries}</BANKTRANLIST></OFX>\n`;

const entry = (fields: string) => `<STMTTRN>\n${fields}</STMTTRN>\n`;

describe('parseOfx', () => {
  it('parses entries, falling back to NAME and then to a default description', () => {
    const { rows } = parseOfx(
      wrap(
        entry('<DTPOSTED>20240115120000\n<TRNAMT>2500.00\n<MEMO>Monthly salary\n') +
          entry('<DTPOSTED>20240116\n<TRNAMT>-89.90\n<NAME>Corner shop\n') +
          entry('<DTPOSTED>20240117\n<TRNAMT>-5.00\n'),
      ),
    );

    expect(rows.map((r) => [r.description, r.amount, r.type])).toEqual([
      ['Monthly salary', 2500, 'INCOME'],
      ['Corner shop', 89.9, 'EXPENSE'],
      ['Imported transaction', 5, 'EXPENSE'],
    ]);
  });

  it('keeps the printed calendar day at 00:00 UTC and drops the time (23:59:59 must not become the next day)', () => {
    const { rows } = parseOfx(wrap(entry('<DTPOSTED>20261105235959[-3:BRT]\n<TRNAMT>-1.00\n<MEMO>Late\n')));

    expect(rows[0]?.date.toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('keeps two identical entries that have different FITIDs', () => {
    const { rows, skipped } = parseOfx(
      wrap(
        entry('<DTPOSTED>20261105\n<TRNAMT>-10.00\n<FITID>a1\n<MEMO>Coffee\n') +
          entry('<DTPOSTED>20261105\n<TRNAMT>-10.00\n<FITID>a2\n<MEMO>Coffee\n'),
      ),
    );

    expect(rows).toHaveLength(2);
    expect(skipped).toEqual([]);
  });

  it('skips an entry that repeats a FITID of the same file and says why', () => {
    const { rows, skipped } = parseOfx(
      wrap(
        entry('<DTPOSTED>20261105\n<TRNAMT>-10.00\n<FITID>a1\n<MEMO>Coffee\n') +
          entry('<DTPOSTED>20261105\n<TRNAMT>-10.00\n<FITID>a1\n<MEMO>Coffee\n'),
      ),
    );

    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([{ line: 2, reason: 'repeated-id' }]);
  });

  it('reports entries with a bad date or amount instead of dropping them silently', () => {
    const { rows, skipped } = parseOfx(
      wrap(
        entry('<DTPOSTED>20261305\n<TRNAMT>-10.00\n') +
          entry('<DTPOSTED>20261105\n<TRNAMT>abc\n') +
          entry('<DTPOSTED>20261105\n<TRNAMT>-3.50\n<MEMO>ok\n'),
      ),
    );

    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([
      { line: 1, reason: 'invalid-date' },
      { line: 2, reason: 'invalid-amount' },
    ]);
  });

  it('decodes XML entities in memos and rounds long decimals to cents', () => {
    const { rows } = parseOfx(wrap(entry('<DTPOSTED>20261105\n<TRNAMT>-10.456\n<MEMO>AT&amp;T\n')));

    expect(rows[0]?.description).toBe('AT&T');
    expect(rows[0]?.amount).toBe(10.46);
  });

  it('warns when the file is a credit card invoice', () => {
    expect(parseOfx(wrap('', 'CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS')).warnings).toEqual(['card-statement']);
    expect(parseOfx(wrap('')).warnings).toEqual([]);
  });

  it('returns nothing for text without entries', () => {
    expect(parseOfx('not an ofx').rows).toEqual([]);
  });
});
