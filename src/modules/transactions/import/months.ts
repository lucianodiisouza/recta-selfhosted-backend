/** A calendar month: `month` is 1 to 12. */
export interface YearMonth {
  year: number;
  month: number;
}

/** 'YYYY-MM', the form the API speaks. */
export function monthKey(month: YearMonth): string {
  return `${String(month.year).padStart(4, '0')}-${String(month.month).padStart(2, '0')}`;
}

/** The month `n` months after (or before, when negative) `month`. */
export function addMonths(month: YearMonth, n: number): YearMonth {
  const index = month.year * 12 + (month.month - 1) + n;
  return { year: Math.floor(index / 12), month: ((index % 12) + 12) % 12 + 1 };
}
