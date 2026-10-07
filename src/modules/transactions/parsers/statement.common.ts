/**
 * Pieces shared by the OFX and CSV statement parsers: the row shape, why a row can be left out, text decoding and the
 * amount and date rules. Nothing here touches the database.
 */

export interface ParsedRow {
  /** Calendar day at 00:00 UTC. The column is a @db.Date, so the day must not depend on the server's time zone. */
  date: Date;
  description: string;
  /** Always positive and rounded to cents; the direction is in `type`. */
  amount: number;
  type: 'INCOME' | 'EXPENSE';
}

/** Why a line of the file did not become a row. The frontend maps each code to a message. */
export type SkipReason =
  | 'invalid-date'
  | 'invalid-amount'
  | 'ambiguous-amount'
  | 'column-count'
  | 'repeated-id';

export interface SkippedRow {
  /** 1-based line of the CSV, or 1-based position of the entry in the OFX. */
  line: number;
  reason: SkipReason;
}

export type StatementWarning = 'card-statement';

export interface ParseResult {
  rows: ParsedRow[];
  skipped: SkippedRow[];
  warnings: StatementWarning[];
}

export const MAX_DESCRIPTION_LENGTH = 255;
export const DEFAULT_DESCRIPTION = 'Imported transaction';
export const MAX_CENTS = 99_999_999_999_999; // Decimal(15,2)

/**
 * A real calendar day as 00:00 UTC, or null. The time of day of the source is dropped on purpose: a bank printing
 * 23:59:59 in its own clock must not roll the transaction into the next day when the server runs in another zone.
 */
export function buildUtcDate(year: number, month: number, day: number): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date;
}

// A Map, not an object literal: a memo containing `&constructor;` or `&__proto__;` would otherwise resolve to
// Object.prototype members and replace the text with a function's source.
const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
]);

/** OFX 2.x is XML: memos arrive as `AT&amp;T`. */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES.get(body.toLowerCase()) ?? whole;
  });
}

export function cleanDescription(raw: string | null | undefined): string {
  const text = decodeEntities(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_DESCRIPTION_LENGTH).trim();
  return text.length > 0 ? text : DEFAULT_DESCRIPTION;
}

/**
 * Brazilian OFX files often declare `CHARSET:1252` and some banks declare it while writing UTF-8, so the declaration
 * is not trusted: try strict UTF-8 first (invalid bytes throw) and fall back to Windows-1252, which also covers
 * ISO-8859-1 text, instead of producing U+FFFD.
 */
export function decodeStatement(buffer: Buffer): string {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    text = new TextDecoder('windows-1252').decode(buffer);
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export type AmountResult = { cents: number; negative: boolean } | { error: 'invalid-amount' | 'ambiguous-amount' };

const groupsOfThree = (separator: string) => new RegExp(`^\\d{1,3}(\\${separator}\\d{3})+$`);

/**
 * Reads one money cell without guessing. The last separator decides the decimal mark when both `.` and `,` appear
 * (`1.234,56` and `1,234.56`); a single separator followed by one or two digits is the decimal mark; a single
 * separator followed by exactly three digits (`1.234`, `1,234`) could be either, so it is refused rather than read as
 * 1.234 or 1234. More than two decimals are rounded to cents.
 */
export function parseAmountText(raw: string): AmountResult {
  let text = raw.replace(/\s|R\$|US\$|[$€£]/g, '');
  let negative = false;
  if (/^\(.*\)$/.test(text)) {
    negative = true;
    text = text.slice(1, -1);
  }
  if (text.startsWith('-') || text.startsWith('+')) {
    negative = negative || text[0] === '-';
    text = text.slice(1);
  } else if (text.endsWith('-')) {
    negative = true;
    text = text.slice(0, -1);
  }
  if (!/^[\d.,]+$/.test(text) || !/\d/.test(text)) return { error: 'invalid-amount' };

  const lastDot = text.lastIndexOf('.');
  const lastComma = text.lastIndexOf(',');
  let integerPart: string;
  let fraction = '';

  if (lastDot >= 0 && lastComma >= 0) {
    const decimal = lastDot > lastComma ? '.' : ',';
    const grouping = decimal === '.' ? ',' : '.';
    const at = Math.max(lastDot, lastComma);
    const head = text.slice(0, at);
    fraction = text.slice(at + 1);
    if (!groupsOfThree(grouping).test(head) || !/^\d+$/.test(fraction)) return { error: 'invalid-amount' };
    integerPart = head.split(grouping).join('');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const separator = lastDot >= 0 ? '.' : ',';
    const parts = text.split(separator);
    if (parts.length > 2) {
      if (!groupsOfThree(separator).test(text)) return { error: 'invalid-amount' };
      integerPart = parts.join('');
    } else {
      const [head = '', tail = ''] = parts;
      if (!/^\d+$/.test(head) || !/^\d+$/.test(tail)) return { error: 'invalid-amount' };
      if (tail.length === 3 && head !== '0' && head.length <= 3) return { error: 'ambiguous-amount' };
      integerPart = head;
      fraction = tail;
    }
  } else {
    integerPart = text;
  }

  const cents = Math.round(Number(`${integerPart}.${fraction || '0'}`) * 100);
  if (!Number.isFinite(cents) || cents <= 0 || cents > MAX_CENTS) return { error: 'invalid-amount' };
  return { cents, negative };
}

export function toRow(date: Date, description: string, cents: number, negative: boolean): ParsedRow {
  return { date, description, amount: cents / 100, type: negative ? 'EXPENSE' : 'INCOME' };
}
