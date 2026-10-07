import { describe, expect, it } from 'vitest';

import { storedDateString } from './local-date.js';

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
