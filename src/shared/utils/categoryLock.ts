import type { Prisma } from '../../generated/prisma/client.js';
import { BadRequestError } from '../errors/index.js';
import { isCustomCategoryName, toCustomCategoryId } from './categoryHelpers.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Inside the SAME database transaction that writes a row carrying `categoryName`: when it is a custom category
 * ("CUSTOM:<uuid>") take a share lock on the category row and require it to exist in the household. A merge or delete
 * of that category takes the row FOR UPDATE, so the two serialize: either the write commits first and the merge then
 * moves it, or the merge/delete commits first and the write is refused here instead of leaving an orphan reference.
 * System names and empty values pass through. Returns the category type when custom (null otherwise).
 */
export async function lockCustomCategory(
  tx: Prisma.TransactionClient,
  householdId: string,
  categoryName: string | null | undefined,
): Promise<'INCOME' | 'EXPENSE' | null> {
  if (!categoryName || !isCustomCategoryName(categoryName)) return null;
  const id = toCustomCategoryId(categoryName)!;
  if (!UUID.test(id)) throw new BadRequestError('Custom category not found or does not belong to this household');
  const rows = await tx.$queryRaw<Array<{ id: string; type: string }>>`SELECT id, type::text AS type FROM categories WHERE id = ${id}::uuid AND household_id = ${householdId}::uuid FOR SHARE`;
  if (rows.length === 0) throw new BadRequestError('Custom category not found or does not belong to this household');
  return rows[0].type as 'INCOME' | 'EXPENSE';
}
