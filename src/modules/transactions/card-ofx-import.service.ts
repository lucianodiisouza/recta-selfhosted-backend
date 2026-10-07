/**
 * Card invoice OFX importer: preview. Reads the invoice, works out which month it is, lists its lines and sets its
 * payment lines against the payments the app already counts for the previous invoice. Nothing is written, and the
 * only stored data it reads are the card and its invoice payments.
 */
import { prisma } from '../../shared/db/prisma.js';
import { AccountType } from '../../shared/enums/index.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/app-error.js';
import { effectiveClosingDay } from '../accounts/closing-day.js';
import { addMonths, monthKey, type YearMonth } from './import/months.js';
import { parseCardOfx, type CardOfxStatementLine } from './parsers/ofx-card.parser.js';
import { loadInvoicePayments, utcToday } from './transactions.service.js';
import type {
  CardOfxOptionsInput,
  CardOfxPayment,
  CardOfxPreviewResponse,
  CardOfxWarning,
} from './card-ofx-import.types.js';

/** Skipped transactions listed in the answer; `totals.skipped` has the full count. */
export const MAX_LISTED_SKIPPED = 100;
/** Lines one invoice may hold. */
export const MAX_CARD_OFX_LINES = 1000;
/** LEDGERBAL and the lines may differ by the bank's rounding; beyond this the preview says so. */
const BALANCE_WARNING_CENTS = 5;

export type AuthorizeHousehold = (householdId: string) => Promise<unknown>;

export interface ResolvedCardAccount {
  id: string;
  name: string;
  householdId: string;
  dueDay: number | null;
  /** Explicit closing day, or due day - 7 when the card has none. */
  closingDay: number | null;
}

/**
 * Load the card, authorize its household and only then check that it is a credit card, so a caller outside the
 * household learns that the account exists (404 against 403) but not what kind it is.
 * @throws NotFoundError (404) when the account does not exist or is inactive; BadRequestError (400) when it is not
 * a credit card.
 */
export async function resolveCardAccount(accountId: string, authorize?: AuthorizeHousehold): Promise<ResolvedCardAccount> {
  const account = await prisma.account.findFirst({
    where: { id: accountId, isActive: true },
    select: { id: true, name: true, type: true, householdId: true, dueDay: true, closingDay: true },
  });
  if (!account) throw new NotFoundError('Account');
  if (authorize) await authorize(account.householdId);
  if (account.type !== AccountType.CREDIT) {
    throw new BadRequestError(`Account "${account.name}" is not a credit card: the card invoice import needs a CREDIT account.`);
  }
  return {
    id: account.id,
    name: account.name,
    householdId: account.householdId,
    dueDay: account.dueDay ?? null,
    closingDay: effectiveClosingDay(account),
  };
}

/**
 * Invoice month = due month. The statement closes on DTEND; it is due in the same month when the card's due day
 * comes after its closing day (DTEND's day when the card has none), otherwise in the next month. Without a due
 * day the closing month is used (`guessed`).
 */
export function invoiceMonthFromStatement(
  closing: string,
  card: Pick<ResolvedCardAccount, 'dueDay' | 'closingDay'>,
): { month: YearMonth; guessed: boolean } {
  const closingMonth: YearMonth = { year: Number(closing.slice(0, 4)), month: Number(closing.slice(5, 7)) };
  if (card.dueDay == null) return { month: closingMonth, guessed: true };
  const closingDay = card.closingDay ?? Number(closing.slice(8, 10));
  return { month: card.dueDay > closingDay ? closingMonth : addMonths(closingMonth, 1), guessed: false };
}

const toCents = (amount: number) => Math.round(amount * 100);

/** Net of lines in cents: purchases count up, credits (refunds, discounts) down. */
function netCents(lines: Array<Pick<CardOfxStatementLine, 'type' | 'amount'>>): number {
  return lines.reduce((total, l) => total + (l.type === 'EXPENSE' ? toCents(l.amount) : -toCents(l.amount)), 0);
}

async function describePayment(
  account: ResolvedCardAccount,
  month: YearMonth,
  paymentLines: CardOfxStatementLine[],
): Promise<CardOfxPayment | null> {
  if (paymentLines.length === 0) return null;
  const previous = addMonths(month, -1);
  const paid = await loadInvoicePayments(
    prisma,
    account.householdId,
    account.id,
    { year: previous.year, monthNum: previous.month },
    utcToday(),
  );
  const recorded = paid.currentRows.map((row) => ({
    transactionId: row.id,
    amount: row.amount.toNumber(),
    date: row.date.toISOString().slice(0, 10),
  }));
  const statementCents = paymentLines.reduce((total, l) => total + toCents(l.amount), 0);
  const recordedCents = recorded.reduce((total, p) => total + toCents(p.amount), 0);
  let state: CardOfxPayment['state'];
  if (paymentLines.length > 1) state = 'undetermined';
  else if (recorded.length === 0) state = 'missing';
  else state = recordedCents === statementCents ? 'matches' : 'differs';
  return {
    invoiceMonthKey: monthKey(previous),
    statementTotal: statementCents / 100,
    recorded,
    recordedTotal: recordedCents / 100,
    state,
  };
}

export interface BuildCardOfxPreviewParams {
  /** Resolved (and authorized) by the route. */
  account: ResolvedCardAccount;
  buffer: Buffer;
  options?: CardOfxOptionsInput;
}

export async function buildCardOfxPreview(params: BuildCardOfxPreviewParams): Promise<CardOfxPreviewResponse> {
  const { account } = params;
  const statement = parseCardOfx(params.buffer);
  if (statement.lines.length === 0) {
    throw new BadRequestError('No readable transactions found in the card invoice.');
  }
  if (statement.lines.length > MAX_CARD_OFX_LINES) {
    throw new BadRequestError(
      `The invoice holds ${statement.lines.length} transactions; at most ${MAX_CARD_OFX_LINES} are imported at once.`,
    );
  }
  const warnings: CardOfxWarning[] = [...statement.warnings];

  const days = statement.lines.map((l) => l.date).sort();
  const period = { start: statement.period.start ?? days[0]!, end: statement.period.end ?? days[days.length - 1]! };
  if (!statement.period.end) warnings.push('period-end-missing');

  let month: YearMonth;
  let monthSource: CardOfxPreviewResponse['monthSource'];
  if (params.options?.monthOverride) {
    month = params.options.monthOverride;
    monthSource = 'override';
  } else {
    const derived = invoiceMonthFromStatement(period.end, account);
    month = derived.month;
    monthSource = 'statement';
    if (derived.guessed) warnings.push('card-without-due-day');
  }
  if (!account.closingDay) warnings.push('card-without-closing-day');

  const ofxTotalCents = netCents(statement.lines.filter((l) => l.kind !== 'payment'));
  // LEDGERBAL is signed as the bank wrote it (a debt is negative); the response speaks debt-positive.
  const ledgerBalance = statement.balance === null ? null : -statement.balance;
  if (ledgerBalance !== null && Math.abs(toCents(ledgerBalance) - ofxTotalCents) > BALANCE_WARNING_CENTS) {
    warnings.push('balance-mismatch');
  }

  const lines = statement.lines.map((l) => ({ ...l, status: l.kind === 'payment' ? ('payment' as const) : ('new' as const) }));
  const count = (status: (typeof lines)[number]['status']) => lines.filter((l) => l.status === status).length;

  return {
    accountId: account.id,
    month,
    monthKey: monthKey(month),
    monthSource,
    period,
    ofxTotal: ofxTotalCents / 100,
    ledgerBalance,
    lines,
    // Capped: a file of empty transactions would otherwise answer with hundreds of thousands of entries.
    skipped: statement.skipped.slice(0, MAX_LISTED_SKIPPED),
    payment: await describePayment(account, month, statement.lines.filter((l) => l.kind === 'payment')),
    totals: {
      lines: lines.length,
      new: count('new'),
      payments: count('payment'),
      skipped: statement.skipped.length,
    },
    warnings,
  };
}
