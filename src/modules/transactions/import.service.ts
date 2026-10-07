import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError } from '../../shared/errors/app-error.js';
import { CategoryName, TransactionType } from '../../shared/enums/index.js';
import { parseCsv } from './parsers/csv.parser.js';
import { parseOfx } from './parsers/ofx.parser.js';
import {
  decodeStatement,
  type ParsedRow,
  type ParseResult,
  type SkippedRow,
  type StatementWarning,
} from './parsers/statement.common.js';
import { createTransaction } from './transactions.service.js';

export type { ParsedRow };

/**
 * One import never carries more rows than this. Each row is saved by createTransaction (about 25 ms: its own database
 * transaction and balance update), so 1500 rows is about 40 s of work in one request, and the confirm body of
 * 1500 rows with 255-character descriptions stays under the 1 MB body limit. Bigger statements are imported in parts.
 */
export const MAX_IMPORT_ROWS = 1500;
/** The preview lists at most this many skipped lines; `skippedCount` always has the real total. */
const MAX_LISTED_SKIPPED = 100;

export interface ImportPreviewRow extends ParsedRow {
  index: number;
  duplicate: boolean;
}

export interface ImportPreview {
  rows: ImportPreviewRow[];
  total: number;
  duplicateCount: number;
  newCount: number;
  /** Lines of the file that could not be read, with the reason, so nothing disappears silently. */
  skipped: SkippedRow[];
  skippedCount: number;
  warnings: StatementWarning[];
}

export interface ConfirmImportResult {
  imported: number;
  skipped: number;
  ids: string[];
  /** Set when the import stopped half way: the rows before `stoppedAt` are saved, the others are not. */
  stoppedAt?: number;
  error?: string;
}

/**
 * Parse an uploaded statement file. Selects the parser by extension.
 * @throws BadRequestError (400) for unsupported extensions, an unreadable CSV header or too many rows.
 */
export function parseImportBuffer(filename: string, buffer: Buffer): ParseResult {
  const dot = filename.lastIndexOf('.');
  const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';

  if (ext !== '.ofx' && ext !== '.csv') {
    throw new BadRequestError(
      `Unsupported file type "${ext || filename}". Only .ofx and .csv files are accepted.`,
    );
  }

  const text = decodeStatement(buffer);
  const parsed = ext === '.ofx' ? parseOfx(text) : parseCsv(text);

  if (parsed.rows.length === 0 && parsed.skipped.length === 0) {
    throw new BadRequestError('No readable transactions found in the file.');
  }
  if (parsed.rows.length > MAX_IMPORT_ROWS) {
    throw new BadRequestError(`The file has more than ${MAX_IMPORT_ROWS} transactions; split it and import it in parts.`);
  }

  return parsed;
}

const dayKey = (date: Date) => date.toISOString().slice(0, 10);

/** Two rows are "the same transaction" when type, day, amount in cents and description match. */
function rowKey(type: string, date: Date, amount: number | Prisma.Decimal, description: string | null): string {
  const cents = Math.round(Number(amount) * 100);
  return `${type}|${dayKey(date)}|${cents}|${description ?? ''}`;
}

/**
 * Which rows already exist on the account, comparing by occurrence: when the file holds the same row three times and
 * the account already has two of it, the first two are duplicates and the third is new. Comparing only "does one
 * exist" would drop the second of two identical purchases (two coffees on the same day) without a word.
 * One query for the whole file. Preview and confirm both use it, so they always agree.
 */
export async function flagDuplicates(
  accountId: string,
  householdId: string,
  rows: ParsedRow[],
): Promise<boolean[]> {
  if (rows.length === 0) return [];
  let min = rows[0]!.date;
  let max = rows[0]!.date;
  for (const row of rows) {
    if (row.date < min) min = row.date;
    if (row.date > max) max = row.date;
  }

  const existing = await prisma.transaction.findMany({
    where: { householdId, accountId, date: { gte: min, lte: max }, type: { in: ['INCOME', 'EXPENSE'] } },
    select: { type: true, date: true, amount: true, description: true },
  });
  const stored = new Map<string, number>();
  for (const tx of existing) {
    const key = rowKey(tx.type, tx.date, tx.amount, tx.description);
    stored.set(key, (stored.get(key) ?? 0) + 1);
  }

  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = rowKey(row.type, row.date, row.amount, row.description);
    const occurrence = (seen.get(key) ?? 0) + 1;
    seen.set(key, occurrence);
    return occurrence <= (stored.get(key) ?? 0);
  });
}

export async function buildImportPreview(
  accountId: string,
  householdId: string,
  parsed: ParseResult,
): Promise<ImportPreview> {
  const flags = await flagDuplicates(accountId, householdId, parsed.rows);
  const rows: ImportPreviewRow[] = parsed.rows.map((row, index) => ({
    ...row,
    index,
    duplicate: flags[index] === true,
  }));
  const duplicateCount = flags.filter(Boolean).length;
  return {
    rows,
    total: rows.length,
    duplicateCount,
    newCount: rows.length - duplicateCount,
    skipped: parsed.skipped.slice(0, MAX_LISTED_SKIPPED),
    skippedCount: parsed.skipped.length,
    warnings: parsed.warnings,
  };
}

/**
 * Persist the rows that are not already on the account.
 *
 * - A per-account advisory lock serialises confirms: two parallel requests with the same file cannot both see "not
 *   there yet" and import it twice. The lock lives in a transaction that does nothing else, because createTransaction
 *   owns its own database transaction (and balance update) on another connection and cannot join this one. The lock
 *   is only tried, never waited for: a waiting request would hold a pool connection for the whole import ahead of it
 *   and enough of them would starve the pool. A second confirm on the same account gets 409 right away instead.
 * - That also means the rows are not atomic. If one fails, the rows before it stay saved and the result says where it
 *   stopped (`stoppedAt`, `error`); running the same file again continues from there because saved rows now count as
 *   duplicates. When the very first row fails the error is thrown as usual.
 */
export async function confirmImport(
  accountId: string,
  householdId: string,
  rows: ParsedRow[],
  userId?: string,
): Promise<ConfirmImportResult> {
  return prisma.$transaction(
    async (lock) => {
      const [{ locked }] = await lock.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(hashtext(${accountId})) AS locked`;
      if (!locked) throw new ConflictError('An import is already running for this account.');

      const flags = await flagDuplicates(accountId, householdId, rows);
      const ids: string[] = [];
      let skipped = 0;

      for (let index = 0; index < rows.length; index++) {
        if (flags[index]) {
          skipped += 1;
          continue;
        }
        const row = rows[index] as ParsedRow;
        try {
          const created = await createTransaction(
            {
              householdId,
              accountId,
              type: row.type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
              categoryName: row.type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES,
              amount: row.amount,
              description: row.description,
              date: row.date,
              paid: true,
              isSplit: false,
            },
            userId,
          );
          ids.push(created.id);
        } catch (error) {
          if (ids.length === 0) throw error;
          return {
            imported: ids.length,
            skipped,
            ids,
            stoppedAt: index,
            error: error instanceof Error ? error.message : 'Unknown error',
          };
        }
      }

      return { imported: ids.length, skipped, ids };
    },
    // The loop can run for minutes on a large file; the default 5 s would abort it midway.
    { timeout: 10 * 60 * 1000, maxWait: 30 * 1000 },
  );
}
