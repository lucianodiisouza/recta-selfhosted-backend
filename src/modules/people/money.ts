import { BadRequestError } from '../../shared/errors/app-error.js';

/** Largest amount a share or settlement may carry (reais); keeps cents well inside safe integers and the decimal(12,2) column. */
export const MAX_AMOUNT = 1_000_000_000;

/**
 * Reais (a number with at most 2 decimals) to integer cents.
 * @throws BadRequestError when the value is not finite or carries sub-cent precision.
 */
export function toCents(value: number, label = 'Amount'): number {
  if (!Number.isFinite(value)) throw new BadRequestError(`${label} must be a number`);
  const scaled = value * 100;
  const cents = Math.round(scaled);
  // The product carries float noise that grows with the magnitude (123456789.57 * 100 is off by ~1e-5): allow a few
  // ulps, far below the half cent a real sub-cent value is off by.
  const tolerance = Math.max(1e-6, Math.abs(scaled) * Number.EPSILON * 8);
  if (Math.abs(scaled - cents) > tolerance) {
    throw new BadRequestError(`${label} must have at most 2 decimal places`);
  }
  return cents;
}

/** Integer cents to reais (exact: the quotient of an integer by 100 is the closest double of the 2-decimal value). */
export function fromCents(cents: number): number {
  return Math.round(cents) / 100;
}

/** Anything that reads as a number: a Prisma Decimal, a plain number. */
export interface NumberLike {
  toNumber(): number;
}

/** Cents of a stored decimal(12,2) amount. */
export function storedToCents(value: NumberLike | number): number {
  const reais = typeof value === 'number' ? value : value.toNumber();
  return Math.round(reais * 100);
}
