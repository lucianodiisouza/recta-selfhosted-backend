import { describe, expect, it } from 'vitest';
import { closingDayFromDue, effectiveClosingDay } from './closing-day.js';

describe('closingDayFromDue', () => {
  it.each([
    [9, 2],
    [8, 1],
    [7, 30],
    [3, 26],
    [1, 24],
    [31, 24],
    [15, 8],
  ])('due day %i closes on day %i', (due, closing) => {
    expect(closingDayFromDue(due)).toBe(closing);
  });

  it('returns null without a valid due day', () => {
    expect(closingDayFromDue(null)).toBeNull();
    expect(closingDayFromDue(undefined)).toBeNull();
    expect(closingDayFromDue(0)).toBeNull();
    expect(closingDayFromDue(32)).toBeNull();
  });
});

describe('effectiveClosingDay', () => {
  it('prefers the explicit closing day', () => {
    expect(effectiveClosingDay({ closingDay: 20, dueDay: 9 })).toBe(20);
  });
  it('derives from the due day when closing is null', () => {
    expect(effectiveClosingDay({ closingDay: null, dueDay: 9 })).toBe(2);
    expect(effectiveClosingDay({ dueDay: 3 })).toBe(26);
  });
  it('is null with neither', () => {
    expect(effectiveClosingDay({ closingDay: null, dueDay: null })).toBeNull();
    expect(effectiveClosingDay(null)).toBeNull();
  });
});
