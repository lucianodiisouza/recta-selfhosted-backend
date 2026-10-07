import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { CategoryName, CategoryType, TransactionType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { parseLocalDateString, storedDateString } from '../../shared/utils/local-date.js';
import { createTransaction, deleteTransaction } from '../transactions/transactions.service.js';
import { withSharesLock } from './shares.service.js';
import { conflictOnUnique, decimalFromCents } from './people.common.js';
import type { CreateSettlementInput } from './people.schema.js';
import type { SettlementDirection, SettlementDto } from './people.types.js';
import { findPersonOrThrow } from './people.service.js';
import { fromCents, storedToCents, toCents } from './money.js';

interface SettlementRow {
  id: string;
  personId: string;
  direction: SettlementDirection;
  amount: { toNumber(): number };
  date: Date;
  transactionId: string | null;
  note: string | null;
}

function toDto(row: SettlementRow): SettlementDto {
  return {
    id: row.id,
    personId: row.personId,
    direction: row.direction,
    amount: fromCents(storedToCents(row.amount)),
    date: storedDateString(row.date),
    transactionId: row.transactionId,
    note: row.note,
  };
}

/** The transaction type a settlement of this direction is: what they paid me is an income, what I paid them an expense. */
export function settlementTransactionType(direction: SettlementDirection): 'INCOME' | 'EXPENSE' {
  return direction === 'RECEIVED' ? 'INCOME' : 'EXPENSE';
}

/** Household that owns a settlement, to authorize routes keyed by the settlement id alone; null when there is none. */
export async function findSettlementHousehold(settlementId: string): Promise<string | null> {
  const settlement = await prisma.settlement.findFirst({ where: { id: settlementId }, select: { householdId: true } });
  return settlement?.householdId ?? null;
}

export async function listSettlements(householdId: string, personId: string): Promise<SettlementDto[]> {
  await findPersonOrThrow(prisma, householdId, personId);
  const rows = await prisma.settlement.findMany({
    where: { householdId, personId },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map(toDto);
}

/** Category of the transaction a settlement creates: the one asked for if it fits the type, else the generic one. */
async function resolveCategory(householdId: string, type: 'INCOME' | 'EXPENSE', requested: string | undefined): Promise<string> {
  const categoryType = type === 'INCOME' ? CategoryType.INCOME : CategoryType.EXPENSE;
  if (requested === undefined) return type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES;
  if (isCustomCategoryName(requested)) {
    const category = await prisma.category.findFirst({
      where: { id: toCustomCategoryId(requested)!, householdId, type },
      select: { id: true },
    });
    if (!category) throw new BadRequestError(`Custom category not found for ${type.toLowerCase()} transactions in this household`);
    return requested;
  }
  if (!getCategoriesByType(categoryType).includes(requested as CategoryName)) {
    throw new BadRequestError(`Category ${requested} is not an ${type.toLowerCase()} category`);
  }
  return requested;
}

const LINKED_MESSAGE = 'That transaction is already linked to a settlement';
const GONE_MESSAGE = 'The person or the transaction was removed meanwhile; try again';

/**
 * Registers money that changed hands with a person.
 *
 * - `transactionId`: links an existing transaction (an income for RECEIVED, an expense for PAID) that no other
 *   settlement uses. The transaction's advisory lock (the one the guarded update takes) and then its row lock (by id
 *   and household) are held while the type and the link are checked and the settlement is written, so a concurrent
 *   delete waits for the commit and then only unlinks the settlement, and a concurrent change of the type either
 *   finishes before (and is what is checked) or is refused after (the guard sees the settlement).
 * - `createTransaction`: creates the real transaction on the account through the transactions service, so the
 *   account balance stays coherent, and links it. If the settlement cannot be saved afterwards, the transaction is
 *   removed again (balance included).
 * - neither: only the settlement is recorded.
 */
export async function createSettlement(
  householdId: string,
  personId: string,
  input: CreateSettlementInput,
): Promise<SettlementDto> {
  const person = await findPersonOrThrow(prisma, householdId, personId);
  const amountCents = toCents(input.amount);
  if (amountCents < 1) throw new BadRequestError('Amount must be at least 0.01');
  const date = parseLocalDateString(input.date);
  const type = settlementTransactionType(input.direction);
  const data = {
    householdId,
    personId,
    direction: input.direction,
    amount: decimalFromCents(amountCents),
    date,
    note: input.note ? input.note : null,
  };

  if (input.transactionId) {
    const linkedId = input.transactionId;
    // The advisory lock of the transaction first (the update of its type takes it too), then the row lock: otherwise
    // an update that already passed its guard could change the type between the check below and the link
    const row = await conflictOnUnique(LINKED_MESSAGE, GONE_MESSAGE, () =>
      withSharesLock(linkedId, () => prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ type: string }>>`SELECT type::text AS type FROM transactions WHERE id = ${linkedId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
        if (locked.length === 0) throw new NotFoundError('Transaction');
        if (locked[0]!.type !== type) {
          throw new BadRequestError(
            `A ${input.direction === 'RECEIVED' ? 'received' : 'paid'} settlement links an ${type.toLowerCase()} transaction`,
          );
        }
        if (await tx.settlement.findFirst({ where: { transactionId: linkedId }, select: { id: true } })) {
          throw new ConflictError(LINKED_MESSAGE);
        }
        return tx.settlement.create({ data: { ...data, transactionId: linkedId } });
      })),
    );
    return toDto(row);
  }

  let createdTransactionId: string | null = null;
  if (input.createTransaction) {
    const categoryName = await resolveCategory(householdId, type, input.createTransaction.categoryName);
    const created = await createTransaction({
      householdId,
      accountId: input.createTransaction.accountId,
      type: type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
      categoryName,
      amount: fromCents(amountCents),
      description:
        input.createTransaction.description ??
        (input.direction === 'RECEIVED' ? `Settlement received from ${person.name}` : `Settlement paid to ${person.name}`),
      date,
      ...(input.note ? { notes: input.note.slice(0, 1000) } : {}),
      paid: true,
      isSplit: false,
    });
    createdTransactionId = created.id;
  }

  try {
    const row = await conflictOnUnique(LINKED_MESSAGE, GONE_MESSAGE, () =>
      prisma.settlement.create({ data: { ...data, transactionId: createdTransactionId } }),
    );
    return toDto(row);
  } catch (error) {
    if (createdTransactionId) {
      // The settlement was not saved: do not leave a stray transaction (and its effect on the account) behind.
      try {
        await deleteTransaction(createdTransactionId, householdId);
      } catch (cleanup) {
        console.error('[createSettlement] Could not remove the transaction of a failed settlement:', cleanup);
      }
    }
    throw error;
  }
}

/** Deletes the settlement; the transaction it was linked to (or created) stays. */
export async function deleteSettlement(householdId: string, settlementId: string): Promise<void> {
  // One scoped write: a settlement of another household, or one deleted meanwhile, is a plain 404
  const { count } = await prisma.settlement.deleteMany({ where: { id: settlementId, householdId } });
  if (count === 0) throw new NotFoundError('Settlement');
}
