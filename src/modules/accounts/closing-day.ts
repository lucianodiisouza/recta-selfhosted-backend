/**
 * Closing day of a credit card statement.
 *
 * Rule of the product: a card normally closes 7 days BEFORE its due day (due day 9 -> closing day 2), counted from the
 * DUE day, and the closing day is also the best day to buy. So a card needs only its due day; the closing day is
 * derived from it unless the user set one explicitly.
 */
const DAYS_BETWEEN_CLOSING_AND_DUE = 7;

/** Days in a wrapped month used when the due day is early in the month (due 3 -> closing 26). */
const WRAP_DAYS = 30;

/** Closing day suggested for a due day: due - 7, plus 30 when that is <= 0 (due 9 -> 2, due 3 -> 26, due 7 -> 30). */
export function closingDayFromDue(dueDay: number | null | undefined): number | null {
  if (dueDay == null || !Number.isInteger(dueDay) || dueDay < 1 || dueDay > 31) return null;
  const closing = dueDay - DAYS_BETWEEN_CLOSING_AND_DUE;
  return closing <= 0 ? closing + WRAP_DAYS : closing;
}

/** Effective closing day: the explicit one when set, otherwise derived from the due day, otherwise null. */
export function effectiveClosingDay(
  account: { closingDay?: number | null; dueDay?: number | null } | null | undefined,
): number | null {
  if (!account) return null;
  if (account.closingDay) return account.closingDay;
  return closingDayFromDue(account.dueDay);
}
