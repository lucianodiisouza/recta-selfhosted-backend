/**
 * Parser for credit card invoices in OFX (the `CREDITCARDMSGSRSV1/CCSTMTRS` statement): OFX 1.x (SGML, with or
 * without closing tags on the elements) and 2.x (XML). Pure: no I/O, no database.
 *
 * Each `STMTTRN` becomes a line with a stable reference, its kind and the installment written in the memo. The
 * special memos ("Parcela N/M", "NuPay", "Desconto Antecipação", "Pagamento recebido") are Nubank's; any other
 * bank's card statement still parses, its lines being plain purchases (negative) and credits (positive).
 *
 * Whatever the parser cannot read is reported by code (`skipped[].reason`, `warnings`), never as prose: the client
 * words the message.
 */
import { createHash } from 'node:crypto';

import { BadRequestError } from '../../../shared/errors/app-error.js';
import {
  DEFAULT_DESCRIPTION,
  MAX_DESCRIPTION_LENGTH,
  buildUtcDate,
  decodeEntities,
  decodeStatement,
} from './statement.common.js';

/** purchase: negative amount; refund: positive credit; discount: "Desconto Antecipação"; payment: "Pagamento recebido". */
export type CardOfxKind = 'purchase' | 'refund' | 'discount' | 'payment';

export interface CardOfxInstallment {
  number: number;
  total: number;
}

export interface CardOfxStatementLine {
  /** `ofx:<FITID>:<first 8 hex of sha1(memo|signed amount|date)>`, see cardOfxRef. */
  ref: string;
  fitid: string;
  /** YYYY-MM-DD: the day DTPOSTED prints, in the statement's own clock. */
  date: string;
  /** Absolute value, > 0. */
  amount: number;
  /** purchase = EXPENSE; refund, discount and payment = INCOME. */
  type: 'INCOME' | 'EXPENSE';
  kind: CardOfxKind;
  memo: string;
  /** The memo without " - Parcela N/M" and " - NuPay". */
  merchant: string;
  installment: CardOfxInstallment | null;
}

/** Why a transaction of the file did not become a line. The frontend maps each code to a message. */
export type CardOfxSkipReason =
  | 'invalid-amount'
  | 'zero-amount'
  | 'amount-too-large'
  | 'invalid-date'
  | 'missing-id'
  | 'id-too-long';

export type CardOfxParseWarning = 'multiple-statements';

export interface CardOfxStatement {
  /** DTSTART / DTEND of the transaction list (YYYY-MM-DD), null when absent. */
  period: { start: string | null; end: string | null };
  /** LEDGERBAL/BALAMT (signed, as the bank wrote it), null when absent. */
  balance: number | null;
  lines: CardOfxStatementLine[];
  /** Transactions that could not be read (1-based position in the list and why). */
  skipped: Array<{ position: number; reason: CardOfxSkipReason }>;
  warnings: CardOfxParseWarning[];
}

/** Installment plans longer than this are not installments. */
export const MAX_CARD_INSTALLMENTS = 99;
/** A FITID longer than this (or with characters outside [A-Za-z0-9._-]) is hashed in refs. */
const MAX_FITID_TOKEN = 64;
/** Largest amount of one line, and longest FITID: what the importer accepts (a line over them is skipped). */
export const MAX_CARD_OFX_AMOUNT = 1_000_000_000;
export const MAX_CARD_OFX_FITID_LENGTH = 255;

const INSTALLMENT_IN_MEMO = /\bparcela\s+(\d{1,3})\s*\/\s*(\d{1,3})\b/i;

function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * The FITID as it goes into refs: as is when it is short and made of [A-Za-z0-9._-] (Nubank uses UUIDs), otherwise
 * `h` + 32 hex of its sha1, so a ref never holds a separator and never passes 120 characters.
 */
export function fitidToken(fitid: string): string {
  const trimmed = fitid.trim();
  if (trimmed.length > 0 && trimmed.length <= MAX_FITID_TOKEN && /^[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  return `h${sha1Hex(trimmed).slice(0, 32)}`;
}

/** Signed amount with two decimals, the way it enters the ref hash ("-100.00"). */
function signedAmountText(signedAmount: number): string {
  const cents = Math.round(signedAmount * 100);
  return (cents / 100).toFixed(2);
}

/**
 * Stable reference of a line: `ofx:<FITID>:<8 hex>`, the hex being the start of sha1("memo|signed amount|date").
 * The FITID repeats across the installments of one purchase (and its discount), the hash tells them apart. Two
 * lines identical in all four fields get `|#2`, `|#3`... appended to the hashed text, in file order.
 *
 * The `ofx:` prefix and this layout are a public contract: refs are stored in `transactions.source_ref` and
 * `transaction_external_refs.ref`, so changing how a ref is built would make every earlier import look new.
 */
export function cardOfxRef(fitid: string, memo: string, signedAmount: number, date: string, occurrence = 1): string {
  const suffix = occurrence > 1 ? `|#${occurrence}` : '';
  const hash = sha1Hex(`${memo}|${signedAmountText(signedAmount)}|${date}${suffix}`).slice(0, 8);
  return `ofx:${fitidToken(fitid)}:${hash}`;
}

/** Key of the lines that share one ref sequence (the occurrence counter of cardOfxRef). */
export function cardOfxContentKey(fitid: string, memo: string, signedAmount: number, date: string): string {
  return `${fitid}|${memo}|${signedAmountText(signedAmount)}|${date}`;
}

/** Kind of a line from its memo and signed amount (Nubank's texts, accents and case ignored). */
export function classifyCardOfxLine(memo: string, signedAmount: number): CardOfxKind {
  if (signedAmount < 0) return 'purchase';
  const text = stripAccents(memo).toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.startsWith('pagamento recebido')) return 'payment';
  if (text.startsWith('desconto antecipa')) return 'discount';
  return 'refund';
}

/** "Loja - Parcela 3/10" -> { number: 3, total: 10 }; null when absent or not a real plan (N > M, M > 99). */
export function installmentFromMemo(memo: string): CardOfxInstallment | null {
  const match = INSTALLMENT_IN_MEMO.exec(memo);
  if (!match) return null;
  const number = Number(match[1]);
  const total = Number(match[2]);
  if (number < 1 || number > total || total > MAX_CARD_INSTALLMENTS) return null;
  return { number, total };
}

/** The memo without " - Parcela N/M" and " - NuPay" (the memo itself when nothing else is left). */
export function merchantFromMemo(memo: string): string {
  const stripped = memo
    .replace(/\s*-\s*parcela\s+\d+\s*\/\s*\d+/gi, '')
    .replace(/\s*-\s*nupay\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : memo.trim();
}

/**
 * Value of the first `<TAG>` in the text: up to the next tag or line break, so it reads SGML elements without
 * closing tags as well as XML ones, or the content of a CDATA section (`<MEMO><![CDATA[Shop & Co]]>`). Null when
 * absent or blank.
 */
function tagValue(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>[ \\t]*(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([^<\\r\\n]+))`, 'i').exec(text);
  // CDATA is literal text: escape its ampersands so the entity decoding every value goes through leaves it alone.
  const value = (match?.[1] !== undefined ? match[1].replace(/&/g, '&amp;') : match?.[2])?.trim();
  return value ? value : null;
}

/** 'YYYY-MM-DD' of an OFX date-time (`YYYYMMDD[HHMMSS...]`), null when it is not a real day. The time is dropped. */
function ofxDay(raw: string | null): string | null {
  const match = raw === null ? null : /^(\d{4})(\d{2})(\d{2})/.exec(raw);
  if (!match) return null;
  return buildUtcDate(Number(match[1]), Number(match[2]), Number(match[3]))?.toISOString().slice(0, 10) ?? null;
}

/** OFX amounts use '.' or ',' as the decimal mark and no grouping. */
function parseOfxAmount(raw: string | null): number | null {
  if (raw === null) return null;
  const text = raw.replace(/\s+/g, '');
  return /^[+-]?\d+(?:[.,]\d+)?$/.test(text) ? Number(text.replace(',', '.')) : null;
}

/** Text between `<TAG>` and `</TAG>` (or the end when the closing tag is missing); null when the tag is absent. */
function section(text: string, tag: string): string | null {
  const open = new RegExp(`<${tag}>`, 'i').exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = new RegExp(`</${tag}>`, 'i').exec(text.slice(start));
  return close ? text.slice(start, start + close.index) : text.slice(start);
}

function cutMemo(memo: string): string {
  if (memo.length <= MAX_DESCRIPTION_LENGTH) return memo;
  const cut = memo.slice(0, MAX_DESCRIPTION_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** UTF-16 files (BOM FF FE or FE FF) are read as such; everything else as UTF-8, falling back to windows-1252. */
function decodeOfx(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  return decodeStatement(buffer);
}

/**
 * Parse a credit card invoice in OFX. The buffer is read as UTF-8 and, when it is not valid UTF-8, as windows-1252
 * (the CHARSET header is not trusted: Nubank declares 1252 and writes UTF-8).
 * @throws BadRequestError (400) when the file holds no credit card statement (`CCSTMTRS`).
 */
export function parseCardOfx(input: Buffer | string): CardOfxStatement {
  const text = typeof input === 'string' ? input : decodeOfx(input);
  const statement = section(text, 'CCSTMTRS');
  if (statement === null) {
    throw new BadRequestError(
      'Not a credit card invoice: the OFX has no credit card statement (CCSTMTRS). Bank account statements go to POST /transactions/import/preview.',
    );
  }

  const warnings: CardOfxParseWarning[] = [];
  if ((text.match(/<CCSTMTRS>/gi) ?? []).length > 1) warnings.push('multiple-statements');

  const list = section(statement, 'BANKTRANLIST') ?? '';
  const blocks = list.split(/<STMTTRN>/i);
  const header = blocks[0] ?? '';
  const period = { start: ofxDay(tagValue(header, 'DTSTART')), end: ofxDay(tagValue(header, 'DTEND')) };
  const ledger = section(statement, 'LEDGERBAL');
  const balance = ledger === null ? null : parseOfxAmount(tagValue(ledger, 'BALAMT'));

  const lines: CardOfxStatementLine[] = [];
  const skipped: CardOfxStatement['skipped'] = [];
  const occurrences = new Map<string, number>();

  for (let i = 1; i < blocks.length; i++) {
    const raw = blocks[i] as string;
    const end = /<\/STMTTRN>/i.exec(raw);
    const block = end ? raw.slice(0, end.index) : raw;
    const skip = (reason: CardOfxSkipReason) => skipped.push({ position: i, reason });

    const signed = parseOfxAmount(tagValue(block, 'TRNAMT'));
    const date = ofxDay(tagValue(block, 'DTPOSTED'));
    const fitid = tagValue(block, 'FITID');
    if (signed === null) {
      skip('invalid-amount');
      continue;
    }
    if (date === null) {
      skip('invalid-date');
      continue;
    }
    if (fitid === null) {
      skip('missing-id');
      continue;
    }
    const cents = Math.round(signed * 100);
    if (cents === 0) {
      skip('zero-amount');
      continue;
    }
    if (!Number.isFinite(cents) || Math.abs(cents) > MAX_CARD_OFX_AMOUNT * 100) {
      skip('amount-too-large');
      continue;
    }
    const fitidValue = decodeEntities(fitid);
    if (fitidValue.length > MAX_CARD_OFX_FITID_LENGTH) {
      skip('id-too-long');
      continue;
    }

    const memoRaw = tagValue(block, 'MEMO') ?? tagValue(block, 'NAME');
    const memoText = memoRaw === null ? '' : cutMemo(decodeEntities(memoRaw).replace(/\s+/g, ' ').trim());
    const memo = memoText.length > 0 ? memoText : DEFAULT_DESCRIPTION;
    const signedAmount = cents / 100;
    const kind = classifyCardOfxLine(memo, signedAmount);

    const contentKey = cardOfxContentKey(fitidValue, memo, signedAmount, date);
    const occurrence = (occurrences.get(contentKey) ?? 0) + 1;
    occurrences.set(contentKey, occurrence);

    lines.push({
      ref: cardOfxRef(fitidValue, memo, signedAmount, date, occurrence),
      fitid: fitidValue,
      date,
      amount: Math.abs(signedAmount),
      type: kind === 'purchase' ? 'EXPENSE' : 'INCOME',
      kind,
      memo,
      merchant: merchantFromMemo(memo),
      installment: installmentFromMemo(memo),
    });
  }

  return { period, balance, lines, skipped, warnings };
}
