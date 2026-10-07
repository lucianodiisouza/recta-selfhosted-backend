import { describe, expect, it } from 'vitest';

import { addMonths, monthKey } from './months.js';

describe('monthKey', () => {
  it('pads the month and the year', () => {
    expect(monthKey({ year: 2026, month: 3 })).toBe('2026-03');
    expect(monthKey({ year: 2026, month: 12 })).toBe('2026-12');
    expect(monthKey({ year: 987, month: 1 })).toBe('0987-01');
  });
});

describe('addMonths', () => {
  it('moves across year boundaries in both directions', () => {
    expect(addMonths({ year: 2026, month: 11 }, 1)).toEqual({ year: 2026, month: 12 });
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 6 }, -18)).toEqual({ year: 2024, month: 12 });
    expect(addMonths({ year: 2026, month: 6 }, 0)).toEqual({ year: 2026, month: 6 });
  });
});
