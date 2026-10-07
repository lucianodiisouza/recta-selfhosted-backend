/**
 * 'YYYY-MM-DD' of a value read from a @db.Date column. Prisma returns those as UTC midnight, so the UTC day is the
 * stored day in any host timezone (the local day would shift it).
 */
export function storedDateString(date: Date): string {
  return date.toISOString().slice(0, 10);
}
