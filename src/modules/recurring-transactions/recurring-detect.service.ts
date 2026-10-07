import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import {
  DEFAULT_MIN_MONTHS,
  DEFAULT_WINDOW_MONTHS,
  detectRecurring,
  normalizeDescription,
  toPublicCandidate,
  type DetectResult,
  type DetectTransaction,
  type DetectedCandidate,
  type RecurringCandidate,
  type DetectSkipped,
} from './detect.js';
import { addMonthsClamped, daysInMonth, dayString, localDate, startDayFor } from './recurring-dates.js';
import type { DetectApplyInput, DetectRecurringInput } from './recurring-transactions.schema.js';

/** The slice of the Prisma client the detection reads from (the client itself, or a transaction's). */
type DetectClient = Pick<Prisma.TransactionClient, 'account' | 'transaction' | 'recurringTransaction'>;

export interface DetectResponse {
  candidates: RecurringCandidate[];
  skipped: DetectSkipped;
}

/**
 * Something apply did not do as asked, as a code the client translates (the server carries no user-facing text):
 * - `duplicate-in-call`: another item of the same call already created an equal recurrence;
 * - `already-active`: the renamed recurrence would equal an active one on the same account;
 * - `short-month-day`: the day (29-31) does not exist in every month, so the run falls on the last day of short ones.
 */
export interface DetectApplyWarning {
  code: 'duplicate-in-call' | 'already-active' | 'short-month-day';
  description: string;
  dayOfMonth?: number;
}

export interface DetectApplyResult {
  created: number;
  skipped: number;
  linkedTransactions: number;
  warnings: DetectApplyWarning[];
}

/** Local calendar day of `now`. */
function localDay(now: Date): string {
  const y = String(now.getFullYear()).padStart(4, '0');
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Everything the detector needs, read from the household in three queries. */
async function runDetection(
  client: DetectClient,
  householdId: string,
  minMonths: number,
  months: number,
  now: Date,
): Promise<DetectResult> {
  const today = localDay(now);
  const accounts = await client.account.findMany({
    where: { householdId, isActive: true },
    select: { id: true, name: true },
  });
  if (accounts.length === 0) return { candidates: [], skipped: { alreadyRecurring: 0, installments: 0, sparse: 0, consumption: 0 } };
  const nameById = new Map(accounts.map((a) => [a.id, a.name]));

  const startIdx = Number(today.slice(0, 4)) * 12 + Number(today.slice(5, 7)) - months;
  const windowStart = new Date(Date.UTC(Math.floor(startIdx / 12), startIdx % 12, 1));

  const rows = await client.transaction.findMany({
    where: { householdId, type: 'EXPENSE', accountId: { in: [...nameById.keys()] }, date: { gte: windowStart } },
    select: {
      id: true,
      accountId: true,
      type: true,
      paid: true,
      description: true,
      categoryName: true,
      amount: true,
      date: true,
      installmentId: true,
      installmentNumber: true,
      totalInstallments: true,
      attachmentUrl: true,
      recurringTransactionId: true,
    },
  });
  const transactions: DetectTransaction[] = [];
  for (const r of rows) {
    if (!r.accountId || !nameById.has(r.accountId)) continue;
    transactions.push({
      id: r.id,
      accountId: r.accountId,
      accountName: nameById.get(r.accountId)!,
      type: String(r.type),
      paid: r.paid,
      description: r.description,
      categoryName: r.categoryName,
      amount: Math.abs(r.amount.toNumber()),
      date: dayString(r.date),
      installmentId: r.installmentId,
      installmentNumber: r.installmentNumber,
      totalInstallments: r.totalInstallments,
      attachmentUrl: r.attachmentUrl,
      recurringTransactionId: r.recurringTransactionId,
    });
  }

  const activeRecurrences = await client.recurringTransaction.findMany({
    where: { householdId, isActive: true },
    select: { id: true, accountId: true, description: true },
  });
  return detectRecurring(transactions, { minMonths, months, today, activeRecurrences });
}

/** Candidates for the household's recurring expenses (read only). The caller has checked membership. */
export async function detectRecurringTransactions(
  input: DetectRecurringInput,
  now: Date = new Date(),
): Promise<DetectResponse> {
  const result = await runDetection(
    prisma,
    input.householdId,
    input.minMonths ?? DEFAULT_MIN_MONTHS,
    input.months ?? DEFAULT_WINDOW_MONTHS,
    now,
  );
  return { candidates: result.candidates.map(toPublicCandidate), skipped: result.skipped };
}

/** First occurrence: the candidate's next uncovered month, on its day (clamped to the month length). */
function firstRunDay(candidate: DetectedCandidate, dayOfMonth: number): string {
  const year = Number(candidate.nextMonth.slice(0, 4));
  const month = Number(candidate.nextMonth.slice(5, 7));
  return addMonthsClamped(`${candidate.nextMonth}-01`, 0, Math.min(dayOfMonth, daysInMonth(year, month)));
}

/**
 * Create the recurrences for the chosen candidates. The detection runs again inside the database transaction
 * (under a per-household lock), so the server decides what a candidate is, an id that no longer exists counts as
 * skipped, and a second call (or a concurrent one) cannot create the same recurrence twice. The history behind
 * each recurrence is linked to it without touching any balance. The caller has checked EDITOR on the household.
 */
export async function applyDetectedRecurrences(
  input: DetectApplyInput,
  now: Date = new Date(),
): Promise<DetectApplyResult> {
  const { householdId } = input;
  const minMonths = input.minMonths ?? DEFAULT_MIN_MONTHS;
  const months = input.months ?? DEFAULT_WINDOW_MONTHS;

  return prisma.$transaction(
    async (tx: Prisma.TransactionClient) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recurring-detect:${householdId}`}))`;
      const { candidates } = await runDetection(tx, householdId, minMonths, months, now);
      const byId = new Map(candidates.map((c) => [c.id, c]));

      const result: DetectApplyResult = { created: 0, skipped: 0, linkedTransactions: 0, warnings: [] };
      const handled = new Set<string>();
      const createdKeys = new Set<string>();

      for (const item of input.items) {
        const candidate = byId.get(item.id);
        if (!candidate || handled.has(item.id)) {
          result.skipped += 1;
          continue;
        }
        handled.add(item.id);

        const description = (item.description ?? candidate.description).trim().slice(0, 255);
        const equivalence = `${candidate.accountId}|${normalizeDescription(description)}`;
        if (createdKeys.has(equivalence)) {
          result.skipped += 1;
          result.warnings.push({ code: 'duplicate-in-call', description });
          continue;
        }
        if (item.description !== undefined && normalizeDescription(description) !== candidate.key) {
          const clash = await tx.recurringTransaction.findMany({
            where: { householdId, accountId: candidate.accountId, isActive: true },
            select: { description: true },
          });
          if (clash.some((r) => normalizeDescription(r.description) === normalizeDescription(description))) {
            result.skipped += 1;
            result.warnings.push({ code: 'already-active', description });
            continue;
          }
        }

        const dayOfMonth = item.dayOfMonth ?? candidate.dayOfMonth;
        const amount = Math.round((item.amount ?? candidate.amount) * 100) / 100;
        const firstRun = firstRunDay(candidate, dayOfMonth);
        const created = await tx.recurringTransaction.create({
          data: {
            householdId,
            accountId: candidate.accountId,
            categoryName: candidate.categoryName,
            amount: new Prisma.Decimal(amount),
            description,
            frequency: 'MONTHLY',
            // The anchor day must be a real day of startDate (day 31 with a 30-day first month: an earlier month).
            startDate: localDate(startDayFor(firstRun, dayOfMonth)),
            nextRunAt: localDate(firstRun),
            isActive: true,
            followLastAmount: item.followLastAmount ?? candidate.followLastAmount,
          },
          select: { id: true },
        });
        createdKeys.add(equivalence);
        result.created += 1;

        const linked = await tx.transaction.updateMany({
          where: { id: { in: candidate.transactionIds }, householdId, recurringTransactionId: null },
          data: { recurringTransactionId: created.id },
        });
        result.linkedTransactions += linked.count;

        if (dayOfMonth > 28) {
          result.warnings.push({ code: 'short-month-day', description, dayOfMonth });
        }
      }
      return result;
    },
    { timeout: 30_000, maxWait: 10_000 },
  );
}
