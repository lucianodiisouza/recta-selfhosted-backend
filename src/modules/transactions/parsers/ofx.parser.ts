import {
  buildUtcDate,
  cleanDescription,
  decodeEntities,
  MAX_CENTS,
  parseAmountText,
  toRow,
  type AmountResult,
  type ParseResult,
  type SkippedRow,
} from './statement.common.js';

const tag = (name: string) => new RegExp(`<${name}>([^\\r\\n<]*)`, 'i');
const TRNAMT = tag('TRNAMT');
const DTPOSTED = tag('DTPOSTED');
const FITID = tag('FITID');
const MEMO = tag('MEMO');
const NAME = tag('NAME');

function extract(regex: RegExp, block: string): string | null {
  const value = regex.exec(block)?.[1]?.trim();
  return value ? value : null;
}

/** `YYYYMMDD[HHMMSS[.XXX]][offset]`: only the calendar day the bank printed is kept. */
function parseOfxDate(raw: string): Date | null {
  const match = /^(\d{4})(\d{2})(\d{2})/.exec(raw.trim());
  return match ? buildUtcDate(Number(match[1]), Number(match[2]), Number(match[3])) : null;
}

/**
 * OFX amounts use `.` as the decimal mark by the spec, so a plain `-1.234` is 1.234 here (unlike in a CSV, where it
 * is ambiguous). Anything else, such as a bank that prints `,`, goes through the strict amount rules.
 */
function parseOfxAmount(raw: string): AmountResult {
  const plain = /^([+-]?)(\d+(?:\.\d+)?)$/.exec(raw);
  if (!plain) return parseAmountText(raw);
  const cents = Math.round(Number(plain[2]) * 100);
  return cents > 0 && cents <= MAX_CENTS ? { cents, negative: plain[1] === '-' } : { error: 'invalid-amount' };
}

export function parseOfx(text: string): ParseResult {
  const result: ParseResult = { rows: [], skipped: [], warnings: [] };
  if (/<CCSTMTRS>|<CREDITCARDMSGSRSV1>/i.test(text)) result.warnings.push('card-statement');

  const seenIds = new Set<string>();
  const blocks = text.split(/<STMTTRN>/i);

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i] as string;
    const skip = (reason: SkippedRow['reason']) => result.skipped.push({ line: i, reason });

    // A FITID is unique per entry by the OFX spec, so a repeat inside one file is the same entry exported twice. Two
    // different ids with identical content are two real entries and both stay.
    const fitId = extract(FITID, block);
    if (fitId !== null) {
      const id = decodeEntities(fitId);
      if (seenIds.has(id)) {
        skip('repeated-id');
        continue;
      }
      seenIds.add(id);
    }

    const date = parseOfxDate(extract(DTPOSTED, block) ?? '');
    if (date === null) {
      skip('invalid-date');
      continue;
    }
    const amount = parseOfxAmount(extract(TRNAMT, block) ?? '');
    if ('error' in amount) {
      skip(amount.error);
      continue;
    }
    result.rows.push(
      toRow(date, cleanDescription(extract(MEMO, block) ?? extract(NAME, block)), amount.cents, amount.negative),
    );
  }

  return result;
}
