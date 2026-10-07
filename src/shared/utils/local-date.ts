/**
 * 'YYYY-MM-DD' of a value read from a @db.Date column. Prisma returns those as UTC midnight, so the UTC day is the
 * stored day in any host timezone (the local day would shift it).
 */
export function storedDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * Local-midnight Date from 'YYYY-MM-DD' (the app runs with `TZ=America/Sao_Paulo`, see index.ts, and so does
 * `localDateSchema`; Prisma stores the day of a @db.Date column).
 * @throws Error when the text is not a real calendar day (the Date constructor would roll 2026-13-45 over).
 */
export function parseLocalDateString(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new Error(`Invalid date "${value}" (expected YYYY-MM-DD)`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`Invalid date "${value}"`);
  }
  return date;
}
