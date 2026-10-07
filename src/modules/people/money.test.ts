import { describe, expect, it } from 'vitest';

import { fromCents, storedToCents, toCents } from './money.js';

describe('toCents', () => {
  it('reads two-decimal values exactly, however large', () => {
    expect(toCents(0.1 + 0.2)).toBe(30);
    expect(toCents(19.99)).toBe(1999);
    expect(toCents(123456789.57)).toBe(12345678957);
    // values whose product by 100 is off by more than 1e-6
    expect(toCents(140989321.67)).toBe(14098932167);
    expect(toCents(165869790.2)).toBe(16586979020);
    expect(toCents(281978643.34)).toBe(28197864334);
    expect(toCents(999999999.99)).toBe(99999999999);
    expect(toCents(1000000000)).toBe(100000000000);
    expect(toCents(0)).toBe(0);
  });

  it('keeps rejecting sub-cent values, at any magnitude', () => {
    expect(() => toCents(10.005)).toThrow(/2 decimal/);
    expect(() => toCents(0.001)).toThrow(/2 decimal/);
    expect(() => toCents(123456789.575)).toThrow(/2 decimal/);
    expect(() => toCents(999999999.994)).toThrow(/2 decimal/);
  });

  it('rejects what is not a number', () => {
    expect(() => toCents(Number.NaN)).toThrow(/must be a number/);
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow(/must be a number/);
  });

  it('round-trips every cent value over a wide range', () => {
    for (let i = 0; i < 20000; i++) {
      const cents = Math.floor((i * 7919 * 104729) % 100_000_000_000);
      expect(toCents(fromCents(cents))).toBe(cents);
    }
  });
});

describe('storedToCents', () => {
  it('reads decimals and numbers', () => {
    expect(storedToCents(12.34)).toBe(1234);
    expect(storedToCents({ toNumber: () => 0.07 })).toBe(7);
  });
});
