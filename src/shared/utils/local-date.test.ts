import { describe, expect, it } from 'vitest';

import { parseLocalDateString, storedDateString } from './local-date.js';

describe('storedDateString', () => {
  it('reads the UTC day of a @db.Date value, whatever the host timezone', () => {
    expect(storedDateString(new Date('2026-03-09T00:00:00.000Z'))).toBe('2026-03-09');
    expect(storedDateString(new Date('2026-12-31T00:00:00.000Z'))).toBe('2026-12-31');
  });

  it('does not shift the day with the local offset', () => {
    // 23:59 UTC is still the same stored day even where local time is already the next day
    expect(storedDateString(new Date('2026-03-09T23:59:59.999Z'))).toBe('2026-03-09');
  });
});

describe('parseLocalDateString', () => {
  it('parses a real calendar day as local midnight', () => {
    const date = parseLocalDateString('2026-10-01');
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([2026, 9, 1, 0]);
  });

  it('rejects roll-overs, impossible days and other formats', () => {
    expect(() => parseLocalDateString('2026-13-45')).toThrow();
    expect(() => parseLocalDateString('2026-02-30')).toThrow();
    expect(() => parseLocalDateString('01/10/2026')).toThrow();
    expect(() => parseLocalDateString('2026-10-01T00:00:00Z')).toThrow();
  });
});
