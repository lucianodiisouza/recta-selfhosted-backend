/**
 * Pure detector of recurring expenses (no prisma, no I/O). It reads the household's expense history and proposes
 * the monthly recurrences worth registering: stable amounts (subscriptions) and monthly bills with a variable
 * amount (energy, water, internet, rent). Consumption (fuel, bakery, rides) stays out.
 */
import { createHash } from 'node:crypto';
import { normalizeLabel } from '../../shared/utils/labels.js';

export const DEFAULT_MIN_MONTHS = 3;
export const DEFAULT_WINDOW_MONTHS = 12;
/** A bill needs at least this many months whatever `minMonths` says. */
export const BILL_MIN_MONTHS = 3;
/** Share of monthly values within the tolerance of the median for the amount to count as stable. */
export const STABLE_SHARE = 0.8;
/** Month coverage between the first and the last month seen below which the history is too sparse. */
export const MIN_COVERAGE = 0.5;
/** More than this share of the covered months with several transactions = consumption, not a monthly charge. */
export const MAX_MULTI_MONTH_SHARE = 1 / 3;
/** A group whose last paid month is older than the previous month has stopped. */
export const MAX_LAG_MONTHS = 1;
export const MAX_CANDIDATES = 300;
export const MAX_EXAMPLES = 6;
/** Categories of the month's bills (system names): a group whose most frequent category is one of them qualifies as `bill`. */
export const BILL_CATEGORIES: ReadonlySet<string> = new Set(['UTILITIES', 'HOUSING']);

export interface DetectTransaction {
  id: string;
  accountId: string;
  accountName: string;
  type: string;
  paid: boolean;
  description: string | null;
  categoryName: string | null;
  /** Absolute amount in reais. */
  amount: number;
  /** YYYY-MM-DD */
  date: string;
  installmentId?: string | null;
  installmentNumber?: number | null;
  totalInstallments?: number | null;
  attachmentUrl?: string | null;
  recurringTransactionId?: string | null;
}

export interface DetectActiveRecurrence {
  id: string;
  accountId: string;
  description: string | null;
}

export interface DetectOptions {
  minMonths?: number;
  months?: number;
  /** Local calendar day of "now" (YYYY-MM-DD). */
  today: string;
  activeRecurrences?: DetectActiveRecurrence[];
}

export interface RecurringCandidate {
  id: string;
  accountId: string;
  accountName: string;
  description: string;
  categoryName: string;
  amount: number;
  medianAmount: number;
  minAmount: number;
  maxAmount: number;
  dayOfMonth: number;
  monthsSeen: number;
  windowMonths: number;
  lastMonth: string;
  kind: 'stable' | 'bill';
  confidence: number;
  defaultSelected: boolean;
  followLastAmount: boolean;
  examples: Array<{ transactionId: string; date: string; amount: number; description: string }>;
}

/** A candidate with what apply needs and the HTTP response does not carry. */
export interface DetectedCandidate extends RecurringCandidate {
  /** First month (YYYY-MM) after the last paid one with no expense of the group at all (paid or not). */
  nextMonth: string;
  /** Every eligible transaction of the group in the window (the ones apply links to the recurrence). */
  transactionIds: string[];
  /** normalizeDescription of the group. */
  key: string;
}

export interface DetectSkipped {
  alreadyRecurring: number;
  installments: number;
  sparse: number;
  consumption: number;
}

export interface DetectResult {
  candidates: DetectedCandidate[];
  skipped: DetectSkipped;
}

/**
 * Description key of a charge: accents, case, `N/M` installment tokens (and `+K`), loose numbers and punctuation
 * are dropped. "Energia 09/2026 - CELESC" and "energia celesc" share a key.
 */
export function normalizeDescription(description: string | null | undefined): string {
  const base = normalizeLabel(description ?? '');
  const stripped = base
    .replace(/\+\s*\d+/g, ' ')
    .replace(/(^|\s)\d{1,3}\s*\/\s*\d{1,4}(?=\s|$)/g, ' ')
    .replace(/(^|[^\p{L}\p{N}])\d+(?:[.,/-]\d+)*(?=[^\p{L}\p{N}]|$)/gu, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (stripped) return stripped;
  return base.replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Deterministic id of a group: the account and the normalized description. */
export function candidateId(accountId: string, key: string): string {
  return `rc_${createHash('sha1').update(`${accountId}\n${key}`).digest('hex').slice(0, 24)}`;
}

export function monthIndex(day: string): number {
  return Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;
}

export function monthKeyOfIndex(index: number): string {
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

const INSTALLMENT_TOKEN = /(^|\s)(\d{1,2})\s*\/\s*(\d{1,2})(?=\s|$|\+)/;

function isInstallment(tx: DetectTransaction): boolean {
  if (tx.installmentId || tx.installmentNumber || tx.totalInstallments) return true;
  const match = INSTALLMENT_TOKEN.exec(normalizeLabel(tx.description ?? ''));
  if (!match) return false;
  const number = Number(match[2]);
  const total = Number(match[3]);
  return total >= 2 && number >= 1 && number <= total;
}

function isEligibleKind(tx: DetectTransaction): boolean {
  return (
    tx.type === 'EXPENSE' &&
    !!tx.accountId &&
    tx.amount > 0 &&
    !(tx.attachmentUrl ?? '').startsWith('invoice_pay:')
  );
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function median(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** `ordered` lists the values newest first: among the most frequent ones the first listed wins. */
function mostFrequent(ordered: string[]): string {
  const counts = new Map<string, number>();
  for (const v of ordered) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = ordered[0]!;
  let bestCount = -1;
  for (const v of ordered) {
    const c = counts.get(v) ?? 0;
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

function newestFirst(a: DetectTransaction, b: DetectTransaction): number {
  if (a.date !== b.date) return a.date < b.date ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

interface Group {
  accountId: string;
  key: string;
  /** Paid, past, in-window transactions: the evidence. */
  paid: DetectTransaction[];
  /** Months with an expense of the group in any status (a pending or future one already covers its month). */
  anyMonths: Set<number>;
}

export function detectRecurring(transactions: readonly DetectTransaction[], options: DetectOptions): DetectResult {
  const minMonths = options.minMonths ?? DEFAULT_MIN_MONTHS;
  const windowMonths = options.months ?? DEFAULT_WINDOW_MONTHS;
  const currentIdx = monthIndex(options.today);
  const windowStart = currentIdx - windowMonths + 1;

  const activeKeys = new Set<string>();
  const activeIds = new Set<string>();
  for (const r of options.activeRecurrences ?? []) {
    activeKeys.add(`${r.accountId}|${normalizeDescription(r.description)}`);
    activeIds.add(r.id);
  }

  const groups = new Map<string, Group>();
  const installmentGroups = new Map<string, Set<number>>();

  for (const tx of transactions) {
    if (!isEligibleKind(tx)) continue;
    const key = normalizeDescription(tx.description);
    if (!key) continue;
    const idx = monthIndex(tx.date);
    if (idx < windowStart) continue;
    const groupId = `${tx.accountId}|${key}`;
    if (isInstallment(tx)) {
      if (tx.paid && tx.date <= options.today) {
        const months = installmentGroups.get(groupId) ?? new Set<number>();
        months.add(idx);
        installmentGroups.set(groupId, months);
      }
      continue;
    }
    let g = groups.get(groupId);
    if (!g) {
      g = { accountId: tx.accountId, key, paid: [], anyMonths: new Set() };
      groups.set(groupId, g);
    }
    g.anyMonths.add(idx);
    if (tx.paid && tx.date <= options.today) g.paid.push(tx);
  }

  const skipped: DetectSkipped = { alreadyRecurring: 0, installments: 0, sparse: 0, consumption: 0 };
  for (const [id, months] of installmentGroups) {
    if (months.size >= minMonths && !groups.has(id)) skipped.installments += 1;
  }

  const candidates: DetectedCandidate[] = [];
  for (const [groupId, g] of groups) {
    // One value per month: the newest transaction of the month.
    const byMonth = new Map<number, DetectTransaction[]>();
    for (const tx of g.paid) {
      const idx = monthIndex(tx.date);
      const list = byMonth.get(idx) ?? [];
      list.push(tx);
      byMonth.set(idx, list);
    }
    const monthsSeen = byMonth.size;
    if (monthsSeen < minMonths) continue;

    const all = [...g.paid].sort(newestFirst);
    const monthly = [...byMonth.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([idx, list]) => ({ idx, tx: [...list].sort(newestFirst)[0]!, count: list.length }));

    if (
      activeKeys.has(groupId) ||
      all.some((tx) => tx.recurringTransactionId && activeIds.has(tx.recurringTransactionId))
    ) {
      skipped.alreadyRecurring += 1;
      continue;
    }

    const firstIdx = monthly[0]!.idx;
    const lastIdx = monthly[monthly.length - 1]!.idx;
    const coverage = monthsSeen / (lastIdx - firstIdx + 1);
    let maxGap = 0;
    for (let i = 1; i < monthly.length; i++) maxGap = Math.max(maxGap, monthly[i]!.idx - monthly[i - 1]!.idx - 1);
    const lag = currentIdx - lastIdx;
    if (coverage < MIN_COVERAGE || lag > MAX_LAG_MONTHS) {
      skipped.sparse += 1;
      continue;
    }

    const categories = all.map((tx) => tx.categoryName ?? '');
    const categoryName = mostFrequent(categories) || 'OTHER_EXPENSES';
    const isBill = monthsSeen >= Math.max(minMonths, BILL_MIN_MONTHS) && BILL_CATEGORIES.has(categoryName);

    const amounts = monthly.map((m) => m.tx.amount).sort((a, b) => a - b);
    const med = median(amounts);
    const tolerance = Math.max(0.5, med * 0.1);
    const stability = amounts.filter((a) => Math.abs(a - med) <= tolerance).length / amounts.length;
    const multiShare = monthly.filter((m) => m.count > 1).length / monthly.length;

    if (!isBill && (stability < STABLE_SHARE || multiShare > MAX_MULTI_MONTH_SHARE)) {
      skipped.consumption += 1;
      continue;
    }

    const days = all.map((tx) => tx.date.slice(8, 10));
    const dayOfMonth = Number(mostFrequent(days));
    const descriptions = all.map((tx) => (tx.description ?? '').trim());
    const latest = monthly[monthly.length - 1]!.tx;
    let nextIdx = lastIdx + 1;
    while (g.anyMonths.has(nextIdx)) nextIdx += 1;

    const confidence = round2(
      Math.min(1, 0.35 * coverage + 0.35 * Math.min(1, monthsSeen / 6) + 0.3 * stability) * (lag === 0 ? 1 : 0.9),
    );

    candidates.push({
      id: candidateId(g.accountId, g.key),
      accountId: g.accountId,
      accountName: latest.accountName,
      description: mostFrequent(descriptions),
      categoryName,
      amount: round2(latest.amount),
      medianAmount: round2(med),
      minAmount: round2(amounts[0]!),
      maxAmount: round2(amounts[amounts.length - 1]!),
      dayOfMonth: dayOfMonth >= 1 && dayOfMonth <= 31 ? dayOfMonth : 1,
      monthsSeen,
      windowMonths,
      lastMonth: monthKeyOfIndex(lastIdx),
      kind: isBill ? 'bill' : 'stable',
      confidence,
      defaultSelected: monthsSeen >= 3 && maxGap <= 1,
      followLastAmount: true,
      examples: all.slice(0, MAX_EXAMPLES).map((tx) => ({
        transactionId: tx.id,
        date: tx.date,
        amount: round2(tx.amount),
        description: (tx.description ?? '').trim(),
      })),
      nextMonth: monthKeyOfIndex(nextIdx),
      transactionIds: all.map((tx) => tx.id),
      key: g.key,
    });
  }

  candidates.sort(
    (a, b) =>
      Number(b.defaultSelected) - Number(a.defaultSelected) ||
      b.confidence - a.confidence ||
      (a.description < b.description ? -1 : a.description > b.description ? 1 : 0) ||
      (a.id < b.id ? -1 : 1),
  );
  return { candidates: candidates.slice(0, MAX_CANDIDATES), skipped };
}

/** The HTTP shape of a candidate (without what only apply uses). */
export function toPublicCandidate(c: DetectedCandidate): RecurringCandidate {
  const { nextMonth: _n, transactionIds: _t, key: _k, ...rest } = c;
  return rest;
}
