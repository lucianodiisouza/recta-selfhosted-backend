/**
 * Hints for the card invoice import that need the card's stored transactions: which new lines look like something the
 * user already typed by hand, and which category each merchant had the last time. Read-only; both the preview and the
 * confirm use them, so they agree.
 */
import { prisma } from '../../shared/db/prisma.js';
import { CategoryName } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { merchantFromMemo, type CardOfxStatementLine } from './parsers/ofx-card.parser.js';
import type { CardOfxCategorySuggestion, CardOfxPossibleDuplicate } from './card-ofx-import.types.js';

/** A hand-typed transaction is a possible duplicate of a line when it is dated at most this many days away. */
export const DUPLICATE_WINDOW_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** Bound of the history read for category suggestions. */
const MAX_HISTORY_ROWS = 2000;
/** Merchants looked up in one query. */
const MAX_HISTORY_MERCHANTS = 200;

const toCents = (amount: number) => Math.round(amount * 100);
const utcMs = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/**
 * For each line, the stored transaction of the card that is probably the same purchase, by `ref`.
 *
 * A candidate has no source reference and is not recorded as representing a line (those are already accounted for),
 * has the line's direction and amount in cents, and is dated within DUPLICATE_WINDOW_DAYS. A transaction is offered to
 * one line only: lines are taken in order and each takes the closest date (then the oldest row), so two identical
 * purchases and one hand-typed row flag only the first.
 */
export async function findPossibleDuplicates(
  card: { id: string; householdId: string },
  lines: CardOfxStatementLine[],
): Promise<Map<string, CardOfxPossibleDuplicate>> {
  const found = new Map<string, CardOfxPossibleDuplicate>();
  if (lines.length === 0) return found;

  const times = lines.map((l) => utcMs(l.date));
  const from = new Date(Math.min(...times) - DUPLICATE_WINDOW_DAYS * DAY_MS);
  const to = new Date(Math.max(...times) + DUPLICATE_WINDOW_DAYS * DAY_MS);
  const candidates = await prisma.transaction.findMany({
    where: {
      householdId: card.householdId,
      accountId: card.id,
      sourceRef: null,
      type: { in: ['INCOME', 'EXPENSE'] },
      date: { gte: from, lte: to },
      externalRefs: { none: {} },
    },
    select: { id: true, type: true, amount: true, date: true, description: true, createdAt: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const pool = candidates.map((c) => ({ ...c, cents: toCents(c.amount.toNumber()), time: c.date.getTime() }));

  for (const line of lines) {
    const time = utcMs(line.date);
    const cents = toCents(line.amount);
    let best = -1;
    let bestGap = Infinity;
    for (let i = 0; i < pool.length; i++) {
      const c = pool[i]!;
      if (c.type !== line.type || c.cents !== cents) continue;
      const gap = Math.abs(c.time - time);
      // Strictly closer wins; a tie keeps the earlier row of the pool (oldest first).
      if (gap <= DUPLICATE_WINDOW_DAYS * DAY_MS && gap < bestGap) {
        best = i;
        bestGap = gap;
      }
    }
    if (best >= 0) {
      const [c] = pool.splice(best, 1);
      found.set(line.ref, { transactionId: c!.id, description: c!.description, date: c!.date.toISOString().slice(0, 10) });
    }
  }
  return found;
}

/**
 * The category the household gave each merchant of `lines` the last time (the latest transaction of that direction
 * whose description is the merchant, or a memo that reduces to it, as "Shop - Parcela 2/3" does). "Other" categories say nothing and custom
 * categories that no longer exist are left out.
 */
export async function suggestCategories(householdId: string, lines: CardOfxStatementLine[]): Promise<CardOfxCategorySuggestion[]> {
  const keyOf = (type: string, merchant: string) => `${type}|${merchant}`;
  const wanted = new Map<string, { merchant: string; type: 'INCOME' | 'EXPENSE' }>();
  for (const line of lines) wanted.set(keyOf(line.type, line.merchant), { merchant: line.merchant, type: line.type });
  if (wanted.size === 0) return [];
  // One OR branch per merchant, bounded; the exact comparison is made below on the merchant of each description.
  const merchants = [...new Set([...wanted.values()].map((w) => w.merchant))].slice(0, MAX_HISTORY_MERCHANTS);

  const history = await prisma.transaction.findMany({
    where: {
      householdId,
      type: { in: ['INCOME', 'EXPENSE'] },
      categoryName: { notIn: [CategoryName.OTHER_INCOME, CategoryName.OTHER_EXPENSES] },
      OR: merchants.map((merchant) => ({ description: { startsWith: merchant } })),
    },
    select: { type: true, description: true, categoryName: true },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
    take: MAX_HISTORY_ROWS,
  });

  const latest = new Map<string, string>();
  for (const row of history) {
    if (!row.description || !row.categoryName) continue;
    const key = keyOf(row.type, merchantFromMemo(row.description));
    if (wanted.has(key) && !latest.has(key)) latest.set(key, row.categoryName);
  }

  const customIds = [...latest.values()].map((name) => (isCustomCategoryName(name) ? toCustomCategoryId(name) : null)).filter((id): id is string => !!id);
  const existing = customIds.length
    ? new Set((await prisma.category.findMany({ where: { householdId, id: { in: customIds } }, select: { id: true } })).map((c) => c.id))
    : new Set<string>();

  const out: CardOfxCategorySuggestion[] = [];
  for (const [key, categoryName] of latest) {
    const customId = isCustomCategoryName(categoryName) ? toCustomCategoryId(categoryName) : null;
    if (customId && !existing.has(customId)) continue;
    out.push({ ...wanted.get(key)!, categoryName });
  }
  return out;
}
