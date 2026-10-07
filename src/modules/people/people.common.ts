import { Prisma } from '../../generated/prisma/client.js';
import { BadRequestError, ConflictError } from '../../shared/errors/app-error.js';
import { normalizeLabel } from '../../shared/utils/labels.js';

/** The Prisma client or an interactive-transaction client: every helper works inside or outside a transaction. */
export type Db = Prisma.TransactionClient;

/** True for a unique-constraint violation (P2002), the loser of a race on a unique key. */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2002';
}

/** True for a foreign-key violation (P2003): the row a write points to was deleted meanwhile. */
export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'P2003';
}

/**
 * Runs a write, answering 409 when it loses a race instead of surfacing a 500: `message` when a unique key is
 * taken, `goneMessage` (default: the same) when a row it points to was deleted meanwhile (foreign key).
 */
export async function conflictOnUnique<T>(message: string, run: () => Promise<T>): Promise<T>;
export async function conflictOnUnique<T>(message: string, goneMessage: string, run: () => Promise<T>): Promise<T>;
export async function conflictOnUnique<T>(message: string, second: string | (() => Promise<T>), third?: () => Promise<T>): Promise<T> {
  const goneMessage = typeof second === 'string' ? second : message;
  const run = typeof second === 'string' ? third! : second;
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(message);
    if (isForeignKeyViolation(error)) throw new ConflictError(goneMessage);
    throw error;
  }
}

/** A decimal(12,2) value from integer cents. */
export function decimalFromCents(cents: number): Prisma.Decimal {
  return new Prisma.Decimal((cents / 100).toFixed(2));
}

/** Lookup key of a name or alias: lower case, no accents, single spaces. */
export function labelKey(label: string): string {
  return normalizeLabel(label);
}

export interface KeyRow {
  label: string;
  key: string;
  isName: boolean;
}

/** `person_aliases.key` is VARCHAR(100); normalization can lengthen a label (NFD of Hangul triples it). */
export const MAX_KEY_LENGTH = 100;
/** Aliases a person can have: the create and update bodies are capped here, and a rename trims to it. */
export const MAX_ALIASES = 20;
/** A household's people: the free-text matcher and the alias scans are sized for this. */
export const MAX_PEOPLE_PER_HOUSEHOLD = 500;

/**
 * The lookup key of a label, validated for storage: a name must keep at least one character once normalized
 * (a name of combining marks only would be an empty key) and no key may exceed the column.
 * @returns the key, or '' for an alias that normalizes to nothing (to be skipped).
 * @throws BadRequestError
 */
export function assertKeyUsable(label: string, isName: boolean): string {
  const key = labelKey(label.trim());
  // A label of combining marks alone has no letter to look up by
  if (/^[\p{M}\s]*$/u.test(key)) {
    if (isName) throw new BadRequestError('The name must contain at least one letter or digit');
    return '';
  }
  if (key.length > MAX_KEY_LENGTH) {
    throw new BadRequestError(`"${label.trim().slice(0, 40)}" is too long once normalized (limit ${MAX_KEY_LENGTH} characters)`);
  }
  return key;
}

/**
 * The lookup rows of a person: the name first, then the aliases, one per distinct key (an alias that repeats the
 * name or an earlier alias is dropped, not an error).
 * @throws BadRequestError when the name has no usable key or a key is too long.
 */
export function buildKeyRows(name: string, aliases: readonly string[]): KeyRow[] {
  const rows: KeyRow[] = [];
  const seen = new Set<string>();
  const add = (label: string, isName: boolean) => {
    const key = assertKeyUsable(label, isName);
    if (key === '' || seen.has(key)) return;
    seen.add(key);
    rows.push({ label: label.trim(), key, isName });
  };
  add(name, true);
  for (const alias of aliases) add(alias, false);
  return rows;
}
