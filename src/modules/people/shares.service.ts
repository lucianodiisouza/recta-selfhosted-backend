import { withAdvisoryLock } from '../../shared/db/advisory-lock.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/app-error.js';
import { conflictOnUnique, decimalFromCents, type Db } from './people.common.js';
import type { PutSharesInput } from './people.schema.js';
import type { SharePreviewResponse, TransactionShareDto, TransactionSharesResponse } from './people.types.js';
import { fromCents, storedToCents } from './money.js';
import { computeSplit, type SplitResult } from './split-strategies.js';

interface TransactionFacts {
  id: string;
  type: string;
  amountCents: number;
}

/** Household that owns a transaction, to authorize routes keyed by the transaction id alone; null when there is none. */
export async function findTransactionHousehold(transactionId: string): Promise<string | null> {
  const transaction = await prisma.transaction.findFirst({ where: { id: transactionId }, select: { householdId: true } });
  return transaction?.householdId ?? null;
}

/** The transaction of the household that can carry shares (an income or an expense), or 404 / 400. */
async function loadTransaction(db: Db, householdId: string, transactionId: string): Promise<TransactionFacts> {
  const transaction = await db.transaction.findFirst({
    where: { id: transactionId, householdId },
    select: { id: true, type: true, amount: true },
  });
  if (!transaction) throw new NotFoundError('Transaction');
  if (transaction.type !== 'INCOME' && transaction.type !== 'EXPENSE') {
    throw new BadRequestError('Only income and expense transactions can be shared');
  }
  return { id: transaction.id, type: transaction.type, amountCents: storedToCents(transaction.amount) };
}

/** Every person of an entry list must be an active person of this household. */
async function assertPeopleUsable(db: Db, householdId: string, personIds: string[]): Promise<void> {
  if (personIds.length === 0) return;
  const people = await db.person.findMany({
    where: { householdId, id: { in: personIds } },
    select: { id: true, name: true, isActive: true },
  });
  const byId = new Map(people.map((p) => [p.id, p]));
  for (const id of personIds) {
    const person = byId.get(id);
    if (!person) throw new NotFoundError('Person');
    if (!person.isActive) throw new BadRequestError(`${person.name} is inactive: reactivate the person before sharing with them`);
  }
}

async function resolveSplit(db: Db, householdId: string, transaction: TransactionFacts, input: PutSharesInput): Promise<SplitResult> {
  await assertPeopleUsable(db, householdId, input.entries.map((e) => e.personId));
  return computeSplit({
    totalCents: transaction.amountCents,
    strategy: input.strategy,
    entries: input.entries,
    myShares: input.myShares,
  });
}

/**
 * What stays with me: the transaction amount minus what people owe me. What I owe people (I_OWE_THEM) does not reduce
 * it. The one rule behind `myPart` of the stored shares and of the preview.
 */
function myPartCents(amountCents: number, theyOweMeCents: number): number {
  return amountCents - theyOweMeCents;
}

async function buildResponse(db: Db, householdId: string, transaction: TransactionFacts): Promise<TransactionSharesResponse> {
  const rows = await db.transactionShare.findMany({
    where: { householdId, transactionId: transaction.id },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  const people = rows.length
    ? await db.person.findMany({ where: { householdId, id: { in: [...new Set(rows.map((r) => r.personId))] } }, select: { id: true, name: true } })
    : [];
  const names = new Map(people.map((p) => [p.id, p.name]));
  const shares: TransactionShareDto[] = rows.map((row) => ({
    id: row.id,
    transactionId: row.transactionId,
    personId: row.personId,
    personName: names.get(row.personId) ?? '',
    direction: row.direction,
    amount: fromCents(storedToCents(row.amount)),
    note: row.note,
    source: row.source === 'import' ? 'import' : 'manual',
  }));
  const theirs = rows.filter((r) => r.direction === 'THEY_OWE_ME').reduce((sum, r) => sum + storedToCents(r.amount), 0);
  return {
    transactionId: transaction.id,
    transactionAmount: fromCents(transaction.amountCents),
    shares,
    myPart: fromCents(myPartCents(transaction.amountCents, theirs)),
  };
}

export async function getTransactionShares(householdId: string, transactionId: string): Promise<TransactionSharesResponse> {
  const transaction = await loadTransaction(prisma, householdId, transactionId);
  return buildResponse(prisma, householdId, transaction);
}

/** The split the entries would produce, without saving anything. */
export async function previewTransactionShares(
  householdId: string,
  transactionId: string,
  input: PutSharesInput,
): Promise<SharePreviewResponse> {
  const transaction = await loadTransaction(prisma, householdId, transactionId);
  const result = await resolveSplit(prisma, householdId, transaction, input);
  // The preview replaces the shares of this direction only: what people owe me is the new parts when this is that
  // direction, and what is stored otherwise
  let theyOweMe = result.parts.reduce((sum, part) => sum + part.amountCents, 0);
  if (input.direction !== 'THEY_OWE_ME') {
    const stored = await prisma.transactionShare.findMany({
      where: { householdId, transactionId, direction: 'THEY_OWE_ME' },
      select: { amount: true },
    });
    theyOweMe = stored.reduce((sum, row) => sum + storedToCents(row.amount), 0);
  }
  return {
    shares: result.parts.map((part) => ({ personId: part.personId, amount: fromCents(part.amountCents) })),
    myPart: fromCents(myPartCents(transaction.amountCents, theyOweMe)),
  };
}

/**
 * Replaces the shares of the transaction in this direction (the other direction is untouched); no entries removes
 * them. The split is computed from the transaction in the database, never from client amounts.
 */
export async function putTransactionShares(
  householdId: string,
  transactionId: string,
  input: PutSharesInput,
): Promise<TransactionSharesResponse> {
  // Early answers (404, inactive person, bad split) without opening a transaction
  const first = await loadTransaction(prisma, householdId, transactionId);
  await resolveSplit(prisma, householdId, first, input);

  // The advisory lock comes first: the row lock below must never be taken before it (the guarded update holds the
  // advisory lock and then waits for the row)
  const transaction = await conflictOnUnique('The shares of this transaction changed meanwhile; try again', () =>
    withSharesLock(transactionId, () => prisma.$transaction(async (tx) => {
      // Row lock, then compute against the amount as it is now: a concurrent amount update either finished before
      // (and its new amount is what we split) or waits for this commit (its guard runs after our shares exist).
      const locked = await tx.$queryRaw<Array<{ amount: { toString(): string }; type: string }>>`SELECT amount, type::text AS type FROM transactions WHERE id = ${transactionId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
      const row = locked[0];
      if (!row) throw new NotFoundError('Transaction');
      if (row.type !== 'INCOME' && row.type !== 'EXPENSE') {
        throw new BadRequestError('Only income and expense transactions can be shared');
      }
      const current: TransactionFacts = { id: transactionId, type: row.type, amountCents: storedToCents(Number(row.amount.toString())) };
      const result = await resolveSplit(tx, householdId, current, input);

      await tx.transactionShare.deleteMany({ where: { transactionId, direction: input.direction } });
      if (result.parts.length > 0) {
        await tx.transactionShare.createMany({
          data: result.parts.map((part) => ({
            householdId,
            transactionId,
            personId: part.personId,
            direction: input.direction,
            amount: decimalFromCents(part.amountCents),
            source: 'manual',
            note: part.note,
          })),
        });
      }
      return current;
    })),
  );
  return buildResponse(prisma, householdId, transaction);
}

/** Namespace of the advisory lock that orders the writers of one transaction's shares and amount. */
const SHARES_LOCK_NAMESPACE = 17;

/**
 * Runs `work` as the only writer of this transaction's shares and amount. `putTransactionShares` and the guarded
 * update of the route both go through it, which is what makes "check the shares, then change the amount" one step:
 * neither can start while the other is between its check and its write.
 */
function withSharesLock<T>(transactionId: string, work: () => Promise<T>): Promise<T> {
  return withAdvisoryLock(SHARES_LOCK_NAMESPACE, transactionId, work);
}

function formatReais(cents: number): string {
  return fromCents(cents).toFixed(2);
}

/**
 * Guard for the user-facing transaction update (called by the route, never by transactions.service, so internal flows
 * such as the card OFX import or installment generation are not affected). A transaction that has shares cannot
 * get an amount below the sum of the shares of either direction (the SIGNED amount is compared: a negative amount
 * is below any share), nor turn from an expense into an income.
 *
 * Call it through `updateKeepingShares`, which holds the lock that makes the check and the update one step.
 * @throws BadRequestError telling to reduce or remove the shares first.
 */
export async function assertUpdateKeepsShares(
  householdId: string,
  transactionId: string,
  current: { type: string },
  change: { amount?: number; type?: string },
): Promise<void> {
  const amountChanges = change.amount !== undefined;
  const typeChanges = change.type !== undefined && change.type !== current.type;
  if (!amountChanges && !typeChanges) return;

  const shares = await prisma.transactionShare.findMany({
    where: { householdId, transactionId },
    select: { direction: true, amount: true },
  });
  if (shares.length === 0) return;

  if (typeChanges && current.type === 'EXPENSE' && change.type === 'INCOME') {
    throw new BadRequestError('This transaction has shares, so it cannot become an income. Remove the shares first.');
  }
  if (amountChanges) {
    const newCents = Math.round(change.amount! * 100);
    for (const direction of ['THEY_OWE_ME', 'I_OWE_THEM'] as const) {
      const sum = shares.filter((s) => s.direction === direction).reduce((total, s) => total + storedToCents(s.amount), 0);
      if (sum > newCents) {
        const who = direction === 'THEY_OWE_ME' ? 'people owe you' : 'you owe people';
        throw new BadRequestError(
          `The new amount (${formatReais(newCents)}) is lower than the shares of this transaction (${formatReais(sum)} that ${who}). Reduce the shares first.`,
        );
      }
    }
  }
}

/**
 * The user-facing transaction update: when the amount or the type changes, the guard and `update` run while no share
 * can be written for the transaction, so shares can never end up above the amount (see `withSharesLock`).
 */
export async function updateKeepingShares<T>(
  householdId: string,
  transactionId: string,
  current: { type: string },
  change: { amount?: number; type?: string },
  update: () => Promise<T>,
): Promise<T> {
  if (change.amount === undefined && change.type === undefined) return update();
  return withSharesLock(transactionId, async () => {
    await assertUpdateKeepsShares(householdId, transactionId, current, change);
    return update();
  });
}
