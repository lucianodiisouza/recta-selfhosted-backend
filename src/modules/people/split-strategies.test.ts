import { describe, expect, it } from 'vitest';

import { MAX_SPLIT_ENTRIES, computeSplit, type SplitEntry, type SplitStrategy } from './split-strategies.js';

// Invented amounts and ids only.

const A = 'person-a';
const B = 'person-b';
const C = 'person-c';

function parts(result: ReturnType<typeof computeSplit>): number[] {
  return result.parts.map((p) => p.amountCents);
}

describe('computeSplit: exact', () => {
  it('stores the amounts as typed and leaves the rest to me', () => {
    const result = computeSplit({
      totalCents: 10000,
      strategy: 'exact',
      entries: [
        { personId: A, amount: 25.5 },
        { personId: B, amount: 10 },
      ],
    });
    expect(parts(result)).toEqual([2550, 1000]);
    expect(result.myPartCents).toBe(6450);
  });

  it('accepts parts that add up to exactly the total', () => {
    const result = computeSplit({
      totalCents: 3000,
      strategy: 'exact',
      entries: [{ personId: A, amount: 10 }, { personId: B, amount: 20 }],
    });
    expect(result.myPartCents).toBe(0);
  });

  it('rejects parts that exceed the total by a cent', () => {
    expect(() =>
      computeSplit({ totalCents: 3000, strategy: 'exact', entries: [{ personId: A, amount: 10 }, { personId: B, amount: 20.01 }] }),
    ).toThrow(/more than the transaction amount/);
  });

  it('requires an amount, positive, with at most 2 decimals', () => {
    expect(() => computeSplit({ totalCents: 1000, strategy: 'exact', entries: [{ personId: A }] })).toThrow(/"amount" is required/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'exact', entries: [{ personId: A, amount: 0 }] })).toThrow(/at least 0.01/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'exact', entries: [{ personId: A, amount: -1 }] })).toThrow(/at least 0.01/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'exact', entries: [{ personId: A, amount: 1.005 }] })).toThrow(/2 decimal/);
  });

  it('reads float noise as the cents it means (0.1 + 0.2 style inputs)', () => {
    const result = computeSplit({ totalCents: 1000, strategy: 'exact', entries: [{ personId: A, amount: 0.1 + 0.2 }] });
    expect(parts(result)).toEqual([30]);
  });
});

describe('computeSplit: percent', () => {
  it('takes the percent of the total and keeps the rest for me', () => {
    const result = computeSplit({
      totalCents: 20000,
      strategy: 'percent',
      entries: [{ personId: A, percent: 25 }, { personId: B, percent: 10 }],
    });
    expect(parts(result)).toEqual([5000, 2000]);
    expect(result.myPartCents).toBe(13000);
  });

  it('rounds each part down and leaves the dust to me when the percents do not cover 100', () => {
    const result = computeSplit({ totalCents: 1000, strategy: 'percent', entries: [{ personId: A, percent: 33.33 }] });
    expect(parts(result)).toEqual([333]);
    expect(result.myPartCents).toBe(667);
  });

  it('hands the rounding dust to the first person when the percents cover 100', () => {
    const result = computeSplit({
      totalCents: 1000,
      strategy: 'percent',
      entries: [{ personId: A, percent: 33.33 }, { personId: B, percent: 33.33 }, { personId: C, percent: 33.34 }],
    });
    expect(parts(result).reduce((a, b) => a + b, 0)).toBe(1000);
    expect(result.myPartCents).toBe(0);
    expect(parts(result)[0]).toBe(334);
  });

  it('allows 100% to one person', () => {
    const result = computeSplit({ totalCents: 4599, strategy: 'percent', entries: [{ personId: A, percent: 100 }] });
    expect(parts(result)).toEqual([4599]);
    expect(result.myPartCents).toBe(0);
  });

  it('rejects percents over 100 in total, out of range or with too many decimals', () => {
    expect(() =>
      computeSplit({ totalCents: 1000, strategy: 'percent', entries: [{ personId: A, percent: 60 }, { personId: B, percent: 40.01 }] }),
    ).toThrow(/more than 100%/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'percent', entries: [{ personId: A, percent: 0 }] })).toThrow(/greater than 0/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'percent', entries: [{ personId: A, percent: 100.01 }] })).toThrow(/at most 100/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'percent', entries: [{ personId: A, percent: 10.123 }] })).toThrow(/2 decimal/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'percent', entries: [{ personId: A }] })).toThrow(/"percent" is required/);
  });

  it('rejects a percent whose part would be less than a cent', () => {
    expect(() => computeSplit({ totalCents: 10, strategy: 'percent', entries: [{ personId: A, percent: 1 }] })).toThrow(/at least 0.01/);
  });
});

describe('computeSplit: shares', () => {
  it('splits by shares, counting mine (1 by default)', () => {
    const result = computeSplit({
      totalCents: 9000,
      strategy: 'shares',
      entries: [{ personId: A, shares: 2 }],
    });
    // 3 shares in all: A holds 2, I hold 1
    expect(parts(result)).toEqual([6000]);
    expect(result.myPartCents).toBe(3000);
  });

  it('honours myShares, including zero (everything goes to the others)', () => {
    const mine = computeSplit({ totalCents: 10000, strategy: 'shares', myShares: 2, entries: [{ personId: A, shares: 1 }, { personId: B, shares: 1 }] });
    expect(parts(mine)).toEqual([2500, 2500]);
    expect(mine.myPartCents).toBe(5000);

    const none = computeSplit({ totalCents: 10001, strategy: 'shares', myShares: 0, entries: [{ personId: A, shares: 1 }, { personId: B, shares: 1 }] });
    expect(none.myPartCents).toBe(0);
    expect(parts(none).reduce((a, b) => a + b, 0)).toBe(10001);
  });

  it('gives the remainder cents to the first person', () => {
    const result = computeSplit({
      totalCents: 1000,
      strategy: 'shares',
      entries: [{ personId: A, shares: 1 }, { personId: B, shares: 1 }],
    });
    // 3 shares: 333 each, 1 cent left for the first person
    expect(parts(result)).toEqual([334, 333]);
    expect(result.myPartCents).toBe(333);
  });

  it('rejects non-integer, zero or huge shares', () => {
    expect(() => computeSplit({ totalCents: 1000, strategy: 'shares', entries: [{ personId: A, shares: 1.5 }] })).toThrow(/whole number/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'shares', entries: [{ personId: A, shares: 0 }] })).toThrow(/whole number/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'shares', entries: [{ personId: A, shares: 1001 }] })).toThrow(/whole number/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'shares', myShares: -1, entries: [{ personId: A, shares: 1 }] })).toThrow(/myShares/);
    expect(() => computeSplit({ totalCents: 1000, strategy: 'shares', entries: [{ personId: A }] })).toThrow(/"shares" is required/);
  });
});

describe('computeSplit: equal', () => {
  it('splits evenly between me and the people listed', () => {
    const result = computeSplit({ totalCents: 9000, strategy: 'equal', entries: [{ personId: A }, { personId: B }] });
    expect(parts(result)).toEqual([3000, 3000]);
    expect(result.myPartCents).toBe(3000);
  });

  it('gives the whole remainder to the first person', () => {
    const result = computeSplit({ totalCents: 1000, strategy: 'equal', entries: [{ personId: A }, { personId: B }, { personId: C }] });
    // 4 people: 250 each, no remainder
    expect(parts(result)).toEqual([250, 250, 250]);

    const odd = computeSplit({ totalCents: 1001, strategy: 'equal', entries: [{ personId: A }, { personId: B }] });
    // 3 people: 333 each, 2 cents left for the first
    expect(parts(odd)).toEqual([335, 333]);
    expect(odd.myPartCents).toBe(333);
  });

  it('rejects a split whose even part would be less than a cent', () => {
    expect(() => computeSplit({ totalCents: 2, strategy: 'equal', entries: [{ personId: A }, { personId: B }] })).toThrow(/at least 0.01/);
  });
});

describe('computeSplit: common validation', () => {
  it('rejects the same person twice', () => {
    expect(() =>
      computeSplit({ totalCents: 1000, strategy: 'equal', entries: [{ personId: A }, { personId: A }] }),
    ).toThrow(/more than once/);
  });

  it('treats no entries as "nothing split": all of it stays with me', () => {
    for (const strategy of ['exact', 'percent', 'shares', 'equal'] as SplitStrategy[]) {
      expect(computeSplit({ totalCents: 1234, strategy, entries: [] })).toEqual({ parts: [], myPartCents: 1234 });
    }
  });

  it('rejects more people than the cap, and a non-positive total or unknown strategy', () => {
    const many: SplitEntry[] = Array.from({ length: MAX_SPLIT_ENTRIES + 1 }, (_, i) => ({ personId: `p-${i}` }));
    expect(() => computeSplit({ totalCents: 100000, strategy: 'equal', entries: many })).toThrow(/at most/);
    expect(() => computeSplit({ totalCents: 0, strategy: 'equal', entries: [{ personId: A }] })).toThrow(/positive/);
    expect(() => computeSplit({ totalCents: 100, strategy: 'bogus' as SplitStrategy, entries: [{ personId: A }] })).toThrow(/Unknown split strategy/);
  });

  it('keeps a trimmed note and drops a blank one', () => {
    const result = computeSplit({
      totalCents: 1000,
      strategy: 'equal',
      entries: [{ personId: A, note: '  lunch  ' }, { personId: B, note: '   ' }],
    });
    expect(result.parts.map((p) => p.note)).toEqual(['lunch', null]);
  });
});

// Deterministic pseudo-random generator, so a failure is reproducible.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('computeSplit: property (the parts and my part always add up to the total)', () => {
  it('holds for random totals, people and strategies', () => {
    const random = rng(20261005);
    const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
    let checked = 0;

    for (let round = 0; round < 3000; round++) {
      const totalCents = int(1, 5_000_000);
      const people = int(1, 8);
      const strategy = (['exact', 'percent', 'shares', 'equal'] as SplitStrategy[])[int(0, 3)]!;
      let entries: SplitEntry[];
      let myShares: number | undefined;

      if (strategy === 'exact') {
        // random amounts that fit in the total
        let left = totalCents;
        entries = [];
        for (let i = 0; i < people && left > 0; i++) {
          const cents = int(1, Math.max(1, Math.floor(left / (people - i))));
          entries.push({ personId: `p${i}`, amount: cents / 100 });
          left -= cents;
        }
      } else if (strategy === 'percent') {
        // percents that add up to at most 100 (2 decimals)
        let leftBp = 10000;
        entries = [];
        for (let i = 0; i < people && leftBp > 0; i++) {
          const bp = int(1, Math.max(1, Math.floor(leftBp / (people - i))));
          entries.push({ personId: `p${i}`, percent: bp / 100 });
          leftBp -= bp;
        }
        // half of the rounds cover exactly 100%
        if (random() < 0.5 && leftBp > 0) entries[0]!.percent = (entries[0]!.percent! * 100 + leftBp) / 100;
      } else if (strategy === 'shares') {
        entries = Array.from({ length: people }, (_, i) => ({ personId: `p${i}`, shares: int(1, 20) }));
        myShares = int(0, 20);
      } else {
        entries = Array.from({ length: people }, (_, i) => ({ personId: `p${i}` }));
      }

      let result;
      try {
        result = computeSplit({ totalCents, strategy, entries, myShares });
      } catch (error) {
        // The only legitimate refusal for these inputs: a part under a cent (tiny totals)
        expect(String((error as Error).message)).toMatch(/at least 0.01/);
        continue;
      }
      checked += 1;
      const sum = result.parts.reduce((a, p) => a + p.amountCents, 0);
      expect(sum + result.myPartCents).toBe(totalCents);
      expect(result.myPartCents).toBeGreaterThanOrEqual(0);
      for (const part of result.parts) {
        expect(Number.isInteger(part.amountCents)).toBe(true);
        expect(part.amountCents).toBeGreaterThanOrEqual(1);
      }
      if (strategy === 'equal') {
        // even split: everybody within the remainder of the same base
        const base = Math.floor(totalCents / (people + 1));
        expect(result.myPartCents).toBe(base);
        expect(result.parts.slice(1).every((p) => p.amountCents === base)).toBe(true);
      }
    }
    expect(checked).toBeGreaterThan(2000);
  });
});
