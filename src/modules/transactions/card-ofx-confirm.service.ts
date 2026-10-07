/**
 * Card invoice OFX importer: confirm. Creates a transaction for each selected line, idempotently.
 *
 * - The client echoes the preview lines. They are not trusted: each one is checked against its own content (its ref is
 *   rebuilt from its fitid, memo, amount and date, its kind and installment from its memo), so a ref can only name the
 *   line it was derived from.
 * - What is new is decided here, on fresh data, never by the client's `status`: a line whose ref a transaction already
 *   carries (or represents) is skipped, whoever did it and whenever. Every created row carries its ref in
 *   `transactions.source_ref`, which is unique per household, so two parallel confirms cannot both create a line.
 * - One confirm per card runs at a time in this process; a second one answers 409 at once instead of waiting. A wait
 *   would hold a connection of the pool (10 by default) per waiting request, and a handful of parallel confirms would
 *   starve the whole API. No database connection is held while the work runs. Across processes the unique source ref
 *   keeps a line from being created twice (a P2002 is read as "already imported").
 * - The rows are not atomic: each is created by the regular transaction service in its own database transaction. If
 *   one fails after others were saved, the answer says where it stopped and running the same selection again
 *   continues, because the saved lines are now known by their refs.
 * - The checks of the echoed lines prove that a line is consistent with itself (its ref is what its content derives),
 *   not that it came from a file: the ref is a public format, not a signature. A caller can do no more than an editor
 *   creating the transaction by hand.
 * - A selected line that still looks like a hand-typed transaction is not created unless the client says so, and can be
 *   linked to that transaction instead (the line is recorded as represented by it, nothing is created).
 */
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError } from '../../shared/errors/app-error.js';
import { CategoryName, CategoryType, TransactionType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { DUPLICATE_WINDOW_DAYS, findPossibleDuplicates } from './card-ofx-duplicates.js';
import { loadKnownRefs, type ResolvedCardAccount } from './card-ofx-import.service.js';
import type { CardOfxConfirmLine, CardOfxConfirmRequest, CardOfxConfirmResponse } from './card-ofx-import.types.js';
import {
  MAX_CARD_OFX_AMOUNT,
  MAX_CARD_OFX_FITID_LENGTH,
  cardOfxContentKey,
  cardOfxRef,
  classifyCardOfxLine,
  fitidToken,
  installmentFromMemo,
  merchantFromMemo,
  type CardOfxStatementLine,
} from './parsers/ofx-card.parser.js';
import { buildUtcDate } from './parsers/statement.common.js';
import { createTransaction } from './transactions.service.js';

const toCents = (amount: number) => Math.round(amount * 100);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const isUniqueViolation = (error: unknown) => (error as { code?: unknown } | null)?.code === 'P2002';

/**
 * Check every echoed line against its own content.
 * @throws BadRequestError (400) naming the first line (1-based) that does not hold.
 */
export function validateConfirmLines(lines: CardOfxConfirmLine[]): void {
  const occurrences = new Map<string, number>();
  lines.forEach((line, index) => {
    const fail = (why: string): never => {
      throw new BadRequestError(`Line ${index + 1} of the invoice does not match its content: ${why}.`);
    };
    // Postgres text cannot hold a NUL: it would fail the write (500) in the middle of an import.
    if ([line.ref, line.fitid, line.memo, line.merchant].some((text) => text.includes('\u0000'))) fail('text');
    const cents = toCents(line.amount);
    if (!(line.amount > 0) || line.amount > MAX_CARD_OFX_AMOUNT || Math.abs(line.amount * 100 - cents) > 1e-6) fail('amount');
    const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(line.date);
    if (!day || buildUtcDate(Number(day[1]), Number(day[2]), Number(day[3])) === null) fail('date');
    if (line.fitid.length === 0 || line.fitid.length > MAX_CARD_OFX_FITID_LENGTH) fail('id');

    const signed = (line.type === 'EXPENSE' ? -cents : cents) / 100;
    const kind = classifyCardOfxLine(line.memo, signed);
    if (line.kind !== kind) fail('kind');
    if ((kind === 'purchase') !== (line.type === 'EXPENSE')) fail('type');
    if (line.merchant !== merchantFromMemo(line.memo)) fail('merchant');
    const installment = installmentFromMemo(line.memo);
    if (JSON.stringify(line.installment) !== JSON.stringify(installment)) fail('installment');

    // The k-th identical line of the file carries the k-th ref of its content, in file order.
    const key = cardOfxContentKey(line.fitid, line.memo, signed, line.date);
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    if (line.ref !== cardOfxRef(line.fitid, line.memo, signed, line.date, occurrence)) fail('ref');
  });
}

/** Category of each merchant, checked: a system category of the line's direction, or a custom one of the household. */
async function resolveCategories(
  householdId: string,
  entries: CardOfxConfirmRequest['categoryMap'],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const customIds = new Set<string>();
  for (const entry of entries) {
    const customId = isCustomCategoryName(entry.categoryName) ? toCustomCategoryId(entry.categoryName) : null;
    if (isCustomCategoryName(entry.categoryName) && !(customId && UUID.test(customId))) {
      throw new BadRequestError('A custom category must be CUSTOM:<id> with the id of a category of this household.');
    }
    if (customId) {
      customIds.add(customId);
    } else {
      const allowed = getCategoriesByType(entry.type === 'INCOME' ? CategoryType.INCOME : CategoryType.EXPENSE) as string[];
      if (!allowed.includes(entry.categoryName)) {
        throw new BadRequestError(`Category "${entry.categoryName}" is not a ${entry.type.toLowerCase()} category.`);
      }
    }
    out.set(`${entry.type}|${entry.merchant}`, entry.categoryName);
  }
  if (customIds.size > 0) {
    const found = new Map(
      (await prisma.category.findMany({ where: { householdId, id: { in: [...customIds] } }, select: { id: true, type: true } })).map((c) => [c.id, c.type]),
    );
    for (const entry of entries) {
      const customId = isCustomCategoryName(entry.categoryName) ? toCustomCategoryId(entry.categoryName) : null;
      if (customId && found.get(customId) !== entry.type) {
        throw new BadRequestError('A custom category was not found in this household or has the other direction.');
      }
    }
  }
  return out;
}

class LinkRefused extends Error {}

/** Record `ref` as represented by `transactionId`, rechecking under a row lock that the transaction still fits (direction, amount and date). */
export async function linkLine(
  account: ResolvedCardAccount,
  line: CardOfxStatementLine,
  transactionId: string,
  offered: string | undefined,
): Promise<'linked' | 'already-imported' | 'link-refused'> {
  // Only the transaction the preview offers for this line (recomputed now) can be linked to it.
  if (offered !== transactionId) return 'link-refused';
  try {
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${transactionId}::uuid FOR UPDATE`;
      const row = await tx.transaction.findFirst({
        where: { id: transactionId, householdId: account.householdId, accountId: account.id, sourceRef: null },
        select: { type: true, amount: true, date: true, externalRefs: { select: { id: true }, take: 1 } },
      });
      const gapDays = row ? Math.abs(row.date.getTime() - Date.parse(`${line.date}T00:00:00.000Z`)) / (24 * 60 * 60 * 1000) : Infinity;
      if (
        !row ||
        row.externalRefs.length > 0 ||
        row.type !== line.type ||
        toCents(row.amount.toNumber()) !== toCents(line.amount) ||
        gapDays > DUPLICATE_WINDOW_DAYS
      ) {
        throw new LinkRefused();
      }
      await tx.transactionExternalRef.create({ data: { householdId: account.householdId, transactionId, ref: line.ref } });
    });
    return 'linked';
  } catch (error) {
    if (error instanceof LinkRefused) return 'link-refused';
    if (isUniqueViolation(error)) return 'already-imported';
    throw error;
  }
}

export interface ConfirmCardOfxParams {
  /** Resolved (and authorized) by the route. */
  account: ResolvedCardAccount;
  request: CardOfxConfirmRequest;
  userId?: string;
}

/** Cards with a confirm running in this process. */
const running = new Set<string>();

/**
 * Confirm an invoice. A second confirm for a card that already has one running answers 409 at once.
 * @throws ConflictError (409) when an import of this card is running.
 */
export async function confirmCardOfxImport(params: ConfirmCardOfxParams): Promise<CardOfxConfirmResponse> {
  // The request is validated first, so a bad request is a 400 whether or not an import is running.
  validateConfirmLines(params.request.lines);
  if (running.has(params.account.id)) {
    throw new ConflictError('An import of this card invoice is already running; wait for it to finish and try again.');
  }
  running.add(params.account.id);
  try {
    return await runConfirm(params);
  } finally {
    running.delete(params.account.id);
  }
}

/** The confirm without the one-at-a-time guard; exported for the tests of what keeps a line from being created twice. */
export async function runConfirm({ account, request, userId }: ConfirmCardOfxParams): Promise<CardOfxConfirmResponse> {
  validateConfirmLines(request.lines);
  const byRef = new Map(request.lines.map((l) => [l.ref, l]));

  const selected = new Set(request.selectedRefs);
  const linkRefs = new Set<string>();
  const linkTargets = new Set<string>();
  for (const ref of selected) {
    const line = byRef.get(ref);
    if (!line) throw new BadRequestError('A selected line is not part of the invoice.');
    if (line.kind === 'payment') throw new BadRequestError('Payment lines are not imported as transactions.');
  }
  for (const { ref, transactionId } of request.links) {
    const line = byRef.get(ref);
    if (!line) throw new BadRequestError('A linked line is not part of the invoice.');
    if (line.kind === 'payment') throw new BadRequestError('Payment lines cannot be linked.');
    if (selected.has(ref)) throw new BadRequestError('A line cannot be both created and linked.');
    if (linkRefs.has(ref) || linkTargets.has(transactionId)) throw new BadRequestError('Each line and each transaction can be linked once.');
    linkRefs.add(ref);
    linkTargets.add(transactionId);
  }
  for (const ref of request.createDespiteDuplicate) {
    if (!selected.has(ref)) throw new BadRequestError('A line marked to create despite a duplicate is not selected.');
  }
  const despite = new Set(request.createDespiteDuplicate);
  const categories = await resolveCategories(account.householdId, request.categoryMap);

  const acted = request.lines.filter((l) => selected.has(l.ref) || linkRefs.has(l.ref));
  const known = await loadKnownRefs(account.householdId, acted.map((l) => l.ref));
  const stillNew = request.lines.filter((l) => l.kind !== 'payment' && !known.has(l.ref));
  const duplicates = await findPossibleDuplicates(account, stillNew);

  const skipped: CardOfxConfirmResponse['skipped'] = [];
  const ids: string[] = [];
  let linked = 0;

  for (const { ref, transactionId } of request.links) {
    if (known.has(ref)) {
      skipped.push({ ref, cause: 'already-imported' });
      continue;
    }
    const result = await linkLine(account, byRef.get(ref)!, transactionId, duplicates.get(ref)?.transactionId);
    if (result === 'linked') linked += 1;
    else skipped.push({ ref, cause: result });
  }

  for (const line of request.lines) {
    if (!selected.has(line.ref)) continue;
    if (known.has(line.ref)) {
      skipped.push({ ref: line.ref, cause: 'already-imported' });
      continue;
    }
    if (duplicates.has(line.ref) && !despite.has(line.ref)) {
      skipped.push({ ref: line.ref, cause: 'possible-duplicate' });
      continue;
    }
    try {
      const created = await createTransaction(
        {
          householdId: account.householdId,
          accountId: account.id,
          type: line.type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
          categoryName: categories.get(`${line.type}|${line.merchant}`) ?? (line.type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES),
          amount: line.amount,
          description: line.memo,
          date: new Date(`${line.date}T00:00:00.000Z`),
          paid: true,
          isSplit: false,
          sourceRef: line.ref,
          ...(line.installment && {
            installmentId: `ofx:${fitidToken(line.fitid)}`,
            installmentNumber: line.installment.number,
            totalInstallments: line.installment.total,
          }),
        },
        userId,
      );
      ids.push(created.id);
    } catch (error) {
      // The ref is unique per household: another confirm created this line between the check and the write.
      if (isUniqueViolation(error)) {
        skipped.push({ ref: line.ref, cause: 'already-imported' });
        continue;
      }
      if (ids.length === 0 && linked === 0) throw error;
      return {
        created: ids.length,
        linked,
        skipped,
        ids,
        stoppedAt: { ref: line.ref, message: error instanceof Error ? error.message : 'Unknown error' },
      };
    }
  }

  return { created: ids.length, linked, skipped, ids };
}
