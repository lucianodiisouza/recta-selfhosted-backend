/**
 * HTTP contract of the card invoice OFX importer:
 *   POST /transactions/import/card-ofx/preview  (multipart: file .ofx, accountId, options JSON optional)
 *   POST /transactions/import/card-ofx/confirm  (JSON: the preview lines echoed back and what to do with each)
 *
 * The frontend builds against these shapes: keep them free of Prisma types and of internal helper types. Anything
 * the client has to word (warnings, skipped lines) is a code, never prose.
 */
import type { CardOfxInstallment, CardOfxKind, CardOfxParseWarning, CardOfxSkipReason } from './parsers/ofx-card.parser.js';

export interface CardOfxOptionsInput {
  /** Invoice month when the one derived from the statement (DTEND and the card's due and closing days) is wrong. */
  monthOverride?: { year: number; month: number };
}

/**
 * new: no transaction holds this line yet; reconciled: a transaction already carries its ref (an earlier import);
 * payment: a "Pagamento recebido" line, reported apart (see CardOfxPayment).
 */
export type CardOfxStatus = 'new' | 'reconciled' | 'payment';

/**
 * A transaction typed by hand (no source reference) on the same card that looks like the same purchase: same
 * direction, same amount in cents, a date within 3 days. Only a hint: the user decides (create anyway, skip, or link).
 */
export interface CardOfxPossibleDuplicate {
  transactionId: string;
  description: string | null;
  /** YYYY-MM-DD */
  date: string;
}

export interface CardOfxLine {
  /** ofx:<FITID>:<8 hex>, see the README "Source references". */
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
  /** Only on `new` lines that are not payments. */
  possibleDuplicate: CardOfxPossibleDuplicate | null;
}

/** The category a merchant's lines got the last time the household booked it (never invented). */
export interface CardOfxCategorySuggestion {
  /** The line's `merchant`. */
  merchant: string;
  type: 'INCOME' | 'EXPENSE';
  /** A system category name or `CUSTOM:<id>`. */
  categoryName: string;
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
  | 'balance-mismatch'
  /** Some new lines look like transactions typed by hand; they come unselected. */
  | 'possible-duplicates';

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
  /** Merchants of the new lines that the household already categorized. */
  categorySuggestions: CardOfxCategorySuggestion[];
  totals: { lines: number; new: number; reconciled: number; payments: number; skipped: number; possibleDuplicates: number };
  warnings: CardOfxWarning[];
}

// ---------------------------------------------------------------------------
// Confirm
// ---------------------------------------------------------------------------

/** A preview line as the client echoes it back (without `status` and `possibleDuplicate`, which the server recomputes). */
export type CardOfxConfirmLine = Omit<CardOfxLine, 'status' | 'possibleDuplicate'>;

export interface CardOfxConfirmRequest {
  accountId: string;
  /** Every line of the preview, in order: identical lines are told apart by their order, so none may be left out. */
  lines: CardOfxConfirmLine[];
  /** Refs of the lines to create as transactions. Payment lines are refused. */
  selectedRefs: string[];
  /** A selected line that still looks like a hand-typed transaction is skipped unless its ref is listed here. */
  createDespiteDuplicate: string[];
  /** Record a line as already represented by an existing transaction instead of creating one. */
  links: Array<{ ref: string; transactionId: string }>;
  /** Category per merchant; a merchant without an entry gets "other expenses" or "other income". */
  categoryMap: Array<{ merchant: string; type: 'INCOME' | 'EXPENSE'; categoryName: string }>;
}

export type CardOfxSkipCause =
  /** A transaction already carries (or represents) the ref: an earlier import, or a parallel one, did it. */
  | 'already-imported'
  /** Selected, looks like a hand-typed transaction and was not listed in `createDespiteDuplicate`. */
  | 'possible-duplicate'
  /** A link whose transaction no longer fits (changed, deleted, already linked, another card). */
  | 'link-refused';

export interface CardOfxConfirmResponse {
  created: number;
  linked: number;
  skipped: Array<{ ref: string; cause: CardOfxSkipCause }>;
  /** Ids of the transactions created, in line order. */
  ids: string[];
  /** Set when a line failed after others were saved: the lines before it are saved, the rest are not. */
  stoppedAt?: { ref: string; message: string };
}
