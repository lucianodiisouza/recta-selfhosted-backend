import { BadRequestError } from '../../shared/errors/app-error.js';
import { MAX_AMOUNT, toCents } from './money.js';

/**
 * Ways to type a split. They are only shortcuts for entering it: what is stored is always an amount per person.
 * All the arithmetic is on integer cents. Cents left over by a division go to the first person listed, so the
 * parts always add up to the intended total.
 */
export const SPLIT_STRATEGIES = ['exact', 'percent', 'shares', 'equal'] as const;
export type SplitStrategy = (typeof SPLIT_STRATEGIES)[number];

/** People per split: a safety cap, far above any real expense. */
export const MAX_SPLIT_ENTRIES = 50;
/** Largest number of shares (cotas) one participant may hold. */
export const MAX_SHARES = 1000;

export interface SplitEntry {
  personId: string;
  /** strategy `exact`: reais (2 decimals, > 0) */
  amount?: number;
  /** strategy `percent`: percent of the transaction total (2 decimals, > 0 and <= 100) */
  percent?: number;
  /** strategy `shares`: how many shares this person holds (integer >= 1) */
  shares?: number;
  note?: string;
}

export interface SplitRequest {
  /** The transaction amount, in cents. */
  totalCents: number;
  strategy: SplitStrategy;
  entries: SplitEntry[];
  /** strategy `shares`: shares of my own part (integer >= 0, default 1). */
  myShares?: number;
}

export interface SplitPart {
  personId: string;
  amountCents: number;
  note: string | null;
}

export interface SplitResult {
  parts: SplitPart[];
  /** What stays with me: the total minus every part. */
  myPartCents: number;
}

function label(entry: SplitEntry, index: number): string {
  return `Entry ${index + 1} (${entry.personId})`;
}

function requireNumber(value: number | undefined, entry: SplitEntry, index: number, field: string): number {
  if (value === undefined || value === null || typeof value !== 'number') {
    throw new BadRequestError(`${label(entry, index)}: "${field}" is required for this strategy`);
  }
  return value;
}

/** Basis points (1/100 of a percent) of a percent with at most 2 decimals; 100% = 10000. */
function toBasisPoints(percent: number, entry: SplitEntry, index: number): number {
  if (!Number.isFinite(percent) || percent <= 0 || percent > 100) {
    throw new BadRequestError(`${label(entry, index)}: percent must be greater than 0 and at most 100`);
  }
  const scaled = percent * 100;
  const basisPoints = Math.round(scaled);
  if (Math.abs(scaled - basisPoints) > 1e-6) {
    throw new BadRequestError(`${label(entry, index)}: percent must have at most 2 decimal places`);
  }
  return basisPoints;
}

function toShareCount(value: number, entry: SplitEntry, index: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_SHARES) {
    throw new BadRequestError(`${label(entry, index)}: shares must be a whole number between 1 and ${MAX_SHARES}`);
  }
  return value;
}

/**
 * Computes the amount of each person for a transaction.
 *
 * - `exact`: each entry carries its amount.
 * - `percent`: each entry carries its percent of the total; what is left stays with me. When the percents add up
 *   to 100 the cents lost to rounding go to the first person, so nothing is left to me.
 * - `shares`: each entry carries its shares; mine (`myShares`, default 1) count too. The first person absorbs the
 *   cents the division leaves.
 * - `equal`: the people listed and I share the total evenly; the first person absorbs the remainder.
 *
 * Validates that every part is at least one cent, that nobody is listed twice and that the parts do not exceed the
 * total. No entries is valid: nothing is split and the whole total stays with me.
 * @throws BadRequestError
 */
export function computeSplit(request: SplitRequest): SplitResult {
  const { totalCents, strategy, entries } = request;
  if (!Number.isInteger(totalCents) || totalCents <= 0 || totalCents > MAX_AMOUNT * 100) {
    throw new BadRequestError('The transaction amount must be a positive value');
  }
  if (!SPLIT_STRATEGIES.includes(strategy)) {
    throw new BadRequestError(`Unknown split strategy "${String(strategy)}"`);
  }
  if (entries.length > MAX_SPLIT_ENTRIES) {
    throw new BadRequestError(`A split takes at most ${MAX_SPLIT_ENTRIES} people`);
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.personId)) {
      throw new BadRequestError(`Person ${entry.personId} appears more than once in the split`);
    }
    seen.add(entry.personId);
  }
  if (entries.length === 0) return { parts: [], myPartCents: totalCents };

  let amounts: number[];
  switch (strategy) {
    case 'exact':
      amounts = entries.map((entry, i) => toCents(requireNumber(entry.amount, entry, i, 'amount'), label(entry, i)));
      break;
    case 'percent': {
      const basisPoints = entries.map((entry, i) => toBasisPoints(requireNumber(entry.percent, entry, i, 'percent'), entry, i));
      const sum = basisPoints.reduce((a, b) => a + b, 0);
      if (sum > 10000) throw new BadRequestError('The percentages add up to more than 100%');
      amounts = basisPoints.map((bp) => Math.floor((totalCents * bp) / 10000));
      // Everything handed out: the rounding dust must not become a phantom part of mine.
      if (sum === 10000) amounts[0]! += totalCents - amounts.reduce((a, b) => a + b, 0);
      break;
    }
    case 'shares': {
      const mine = request.myShares ?? 1;
      if (!Number.isInteger(mine) || mine < 0 || mine > MAX_SHARES) {
        throw new BadRequestError(`myShares must be a whole number between 0 and ${MAX_SHARES}`);
      }
      const counts = entries.map((entry, i) => toShareCount(requireNumber(entry.shares, entry, i, 'shares'), entry, i));
      const all = counts.reduce((a, b) => a + b, 0) + mine;
      amounts = counts.map((count) => Math.floor((totalCents * count) / all));
      const myFloor = Math.floor((totalCents * mine) / all);
      // The first person takes the cents of the division, mine included in the accounting.
      amounts[0]! += totalCents - amounts.reduce((a, b) => a + b, 0) - myFloor;
      break;
    }
    case 'equal': {
      const people = entries.length + 1;
      const each = Math.floor(totalCents / people);
      amounts = entries.map(() => each);
      amounts[0]! += totalCents - each * people;
      break;
    }
  }

  const parts: SplitPart[] = entries.map((entry, i) => {
    const amountCents = amounts[i]!;
    if (!Number.isInteger(amountCents) || amountCents < 1) {
      throw new BadRequestError(`${label(entry, i)}: the part must be at least 0.01`);
    }
    return { personId: entry.personId, amountCents, note: entry.note?.trim() ? entry.note.trim() : null };
  });
  const sum = parts.reduce((a, p) => a + p.amountCents, 0);
  if (sum > totalCents) throw new BadRequestError('The parts add up to more than the transaction amount');
  return { parts, myPartCents: totalCents - sum };
}
