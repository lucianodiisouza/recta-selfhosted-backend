import { describe, expect, it } from 'vitest';
import { addMonthsClamped, startDayFor } from './recurring-dates.js';

describe('addMonthsClamped', () => {
  it('keeps the day where it exists and clamps to the end of a short month', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2026-10-15', 1)).toBe('2026-11-15');
    expect(addMonthsClamped('2026-11-30', 1, 31)).toBe('2026-12-31');
    expect(addMonthsClamped('2026-01-15', -2)).toBe('2025-11-15');
  });
});

describe('startDayFor', () => {
  it('puts the start date on the latest earlier month that has the anchor day', () => {
    expect(startDayFor('2026-11-30', 31)).toBe('2026-10-31');
    expect(startDayFor('2026-02-28', 30)).toBe('2026-01-30');
    expect(startDayFor('2026-11-30', 30)).toBe('2026-11-30');
    expect(startDayFor('2026-11-12', 12)).toBe('2026-11-12');
  });
});
