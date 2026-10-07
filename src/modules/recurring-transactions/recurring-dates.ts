/**
 * Day arithmetic for recurrences. Prisma returns @db.Date columns as UTC midnight while the code (and the
 * localDateSchema) writes local-midnight Dates; a Date is read here by whichever midnight it is on.
 */

/** 'YYYY-MM-DD' of a date that is either local midnight (code-made) or UTC midnight (read from a @db.Date column). */
export function dayString(date: Date): string {
  const localMidnight = date.getHours() === 0 && date.getMinutes() === 0 && date.getSeconds() === 0;
  const y = localMidnight ? date.getFullYear() : date.getUTCFullYear();
  const m = (localMidnight ? date.getMonth() : date.getUTCMonth()) + 1;
  const d = localMidnight ? date.getDate() : date.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Local midnight of 'YYYY-MM-DD' (what the services write). */
export function localDate(day: string): Date {
  return new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)));
}

/** UTC-midnight bounds of the month of `day`: [start, nextStart), for @db.Date range filters. */
export function monthBoundsUtc(day: string): { start: Date; end: Date } {
  const y = Number(day.slice(0, 4));
  const m = Number(day.slice(5, 7));
  return { start: new Date(Date.UTC(y, m - 1, 1)), end: new Date(Date.UTC(y, m, 1)) };
}

export function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

/** 'YYYY-MM-DD' of `day` moved by n months, keeping the day of month where it exists (clamped to the month end). */
export function addMonthsClamped(day: string, n: number, anchorDay?: number): string {
  const idx = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1 + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  const d = Math.min(anchorDay ?? Number(day.slice(8, 10)), daysInMonth(y, m));
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Start date to store for a recurrence whose first run is `firstRunDay`: the anchor day must be a real day of the
 * startDate month, so when the first run month is shorter than the anchor (day 31 in November) the startDate goes to
 * the latest earlier month that has the day.
 */
export function startDayFor(firstRunDay: string, anchor: number): string {
  let back = 0;
  while (daysInMonth(Number(addMonthsClamped(firstRunDay, -back, 1).slice(0, 4)), Number(addMonthsClamped(firstRunDay, -back, 1).slice(5, 7))) < anchor) back += 1;
  return addMonthsClamped(firstRunDay, -back, anchor);
}
