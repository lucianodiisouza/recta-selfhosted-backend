import { describe, expect, it } from 'vitest';

import {
  buildUtcDate,
  cleanDescription,
  decodeEntities,
  decodeStatement,
  parseAmountText,
} from './statement.common.js';

const cents = (raw: string) => {
  const result = parseAmountText(raw);
  return 'error' in result ? result.error : `${result.negative ? '-' : ''}${result.cents}`;
};

describe('test environment', () => {
  it('runs in a non-UTC zone so day-shifting bugs cannot hide', () => {
    expect(new Date(2026, 10, 5).getTimezoneOffset()).toBe(180);
  });
});

describe('parseAmountText', () => {
  it('reads Brazilian and English grouping when both separators are present', () => {
    expect(cents('1.234,56')).toBe('123456');
    expect(cents('-1,234.50')).toBe('-123450');
    expect(cents('1.234.567,89')).toBe('123456789');
  });

  it('reads one or two decimals after a single separator', () => {
    expect(cents('12,5')).toBe('1250');
    expect(cents('100.25')).toBe('10025');
    expect(cents('0,500')).toBe('50');
  });

  it('refuses a single separator followed by three digits instead of guessing', () => {
    expect(cents('1.234')).toBe('ambiguous-amount');
    expect(cents('1,234')).toBe('ambiguous-amount');
  });

  it('reads repeated separators as thousands only in groups of three', () => {
    expect(cents('1.234.567')).toBe('123456700');
    expect(cents('1.23.4')).toBe('invalid-amount');
  });

  it('rounds to cents when there are more than two decimals', () => {
    expect(cents('10.4567')).toBe('1046');
    expect(cents('10.456')).toBe('ambiguous-amount');
    expect(cents('1.234,5678')).toBe('123457');
  });

  it('handles signs, currency symbols and parentheses', () => {
    expect(cents('R$ -10,00')).toBe('-1000');
    expect(cents('(25,00)')).toBe('-2500');
    expect(cents('15,00-')).toBe('-1500');
    expect(cents('+7,50')).toBe('750');
  });

  it('rejects text, zero and empty cells', () => {
    expect(cents('abc')).toBe('invalid-amount');
    expect(cents('')).toBe('invalid-amount');
    expect(cents('0,00')).toBe('invalid-amount');
    expect(cents('1,2,3,4')).toBe('invalid-amount');
  });
});

describe('buildUtcDate', () => {
  it('returns midnight UTC regardless of the server zone', () => {
    expect(buildUtcDate(2026, 11, 5)?.toISOString()).toBe('2026-11-05T00:00:00.000Z');
  });

  it('rejects days that do not exist', () => {
    expect(buildUtcDate(2026, 2, 30)).toBeNull();
    expect(buildUtcDate(2026, 13, 1)).toBeNull();
  });
});

describe('text helpers', () => {
  it('decodes XML entities in memos', () => {
    expect(decodeEntities('AT&amp;T &lt;x&gt; &#65; &#x42;')).toBe('AT&T <x> A B');
    expect(cleanDescription('  Caf&eacute;   &amp;  Cia ')).toBe('Caf&eacute; & Cia');
  });

  it('leaves names that exist on Object.prototype literal', () => {
    for (const name of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      expect(decodeEntities(`a &${name}; b`)).toBe(`a &${name}; b`);
    }
  });

  it('truncates long descriptions and falls back for empty ones', () => {
    expect(cleanDescription('x'.repeat(400))).toHaveLength(255);
    expect(cleanDescription('   ')).toBe('Imported transaction');
    expect(cleanDescription(null)).toBe('Imported transaction');
  });

  it('decodes a CHARSET:1252 file as Windows-1252', () => {
    const buffer = Buffer.concat([Buffer.from('CHARSET:1252\n<MEMO>Caf', 'latin1'), Buffer.from([0xe9])]);

    expect(decodeStatement(buffer)).toContain('Café');
  });

  it('reads UTF-8 even when the file declares CHARSET:1252', () => {
    const buffer = Buffer.from('CHARSET:1252\n<MEMO>Café', 'utf-8');

    expect(decodeStatement(buffer)).toContain('Café');
  });

  it('falls back to Windows-1252 for undeclared non-UTF-8 bytes and keeps valid UTF-8', () => {
    expect(decodeStatement(Buffer.from([0x43, 0x61, 0x66, 0xe9]))).toBe('Café');
    expect(decodeStatement(Buffer.from('Café', 'utf-8'))).toBe('Café');
  });

  it('drops a UTF-8 byte order mark', () => {
    expect(decodeStatement(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('abc')]))).toBe('abc');
  });
});
