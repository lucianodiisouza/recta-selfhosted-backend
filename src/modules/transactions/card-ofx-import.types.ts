/**
 * HTTP contract of the card invoice OFX importer:
 *   POST /transactions/import/card-ofx/preview  (multipart: file .ofx, accountId, options JSON optional)
 *
 * The frontend builds against these shapes: keep them free of Prisma types and of internal helper types. Anything
 * the client has to word (warnings, skipped lines) is a code, never prose.
 */
import type { CardOfxInstallment, CardOfxKind, CardOfxParseWarning, CardOfxSkipReason } from './parsers/ofx-card.parser.js';

export interface CardOfxOptionsInput {
  /** Invoice month when the one derived from the statement (DTEND and the card's due and closing days) is wrong. */
  monthOverride?: { year: number; month: number };
}

/** new: a line to import; payment: a "Pagamento recebido" line, reported apart (see CardOfxPayment). */
export type CardOfxStatus = 'new' | 'payment';

export interface CardOfxLine {
  /** ofx:<FITID>:<8 hex>: the stable identity of the line, the same on every parse of the same statement. */
  ref: string;
  fitid: string;
  /** YYYY-MM-DD */
  date: string;
  /** > 0 */
  amount: number;
  /** purchase = EXPENSE; refund, discount and payment = INCOME. */
  type: 'INCOME' | 'EXPENSE';
  kind: CardOfxKind;
  memo: string;
  /** The memo without " - Parcela N/M" and " - NuPay". */
  merchant: string;
  installment: CardOfxInstallment | null;
  status: CardOfxStatus;
}

/**
 * What the app already counts as paid for the previous invoice (the one a "Pagamento recebido" pays), set against the
 * statement's payment lines. 'undetermined' when the file holds several payment lines: some may be advance
 * payments, and telling them apart is not part of the preview.
 */
export interface CardOfxPayment {
  /** Invoice the payment lines pay (the month before the statement's), YYYY-MM. */
  invoiceMonthKey: string;
  /** Sum of the payment lines. */
  statementTotal: number;
  /** Payments tagged for that invoice and dated up to today (the ones the invoice view subtracts). */
  recorded: Array<{ transactionId: string; amount: number; date: string }>;
  recordedTotal: number;
  state: 'matches' | 'differs' | 'missing' | 'undetermined';
}

export type CardOfxWarning =
  | CardOfxParseWarning
  /** The OFX has no DTEND: the last line's date stood in for the closing date. */
  | 'period-end-missing'
  /** The card has no due day, so the invoice month is the closing month; check it. */
  | 'card-without-due-day'
  /** The card has neither closing nor due day: invoices follow the calendar month. */
  | 'card-without-closing-day'
  /** LEDGERBAL differs from the sum of the lines by more than a few cents. */
  | 'balance-mismatch';

export interface CardOfxPreviewResponse {
  accountId: string;
  /** The invoice's due month. */
  month: { year: number; month: number };
  monthKey: string;
  monthSource: 'statement' | 'override';
  /** DTSTART..DTEND (the first and last line's date for a bound the file lacks). */
  period: { start: string; end: string };
  /** Purchases minus refunds and discounts (payments left out). */
  ofxTotal: number;
  /** The statement's closing balance owed (LEDGERBAL, positive = debt); null when the file has none. */
  ledgerBalance: number | null;
  lines: CardOfxLine[];
  /** The first 100 transactions of the file that could not be read (1-based position and why); `totals.skipped` has the count. */
  skipped: Array<{ position: number; reason: CardOfxSkipReason }>;
  payment: CardOfxPayment | null;
  totals: { lines: number; new: number; payments: number; skipped: number };
  warnings: CardOfxWarning[];
}
