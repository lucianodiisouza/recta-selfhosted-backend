import { prisma } from '../../shared/db/prisma.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { NotFoundError, CategoryMergeError } from '../../shared/errors/index.js';
import {
  CategoryName,
  CategoryType,
  CATEGORY_NAME_DISPLAY,
  getCategoriesByType,
} from '../../shared/enums/index.js';
import { toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';

/**
 * Everything that stores a category reference is listed here (the schema was grepped for category_name):
 *  - transactions.category_name           (re-pointed)
 *  - recurring_transactions.category_name (re-pointed)
 *  - budgets.category_name                (re-pointed; unique per household+category+month, so when the target
 *                                          already has a budget for the month the two limits are added and the
 *                                          source row is removed)
 * No other table keeps a category reference. A PR that adds one must be handled here (and listed by the guard in
 * shared/utils/categoryLock.guard.test.ts when it writes `categoryName`).
 */
export interface MergeCounts {
  transactions: number;
  recurringTransactions: number;
  /** Budgets of the source that moved to the target (no budget of the target in that month). */
  budgets: number;
  /** Budgets of the source whose month already had a budget on the target: limits added, source row removed. */
  budgetsCombined: number;
}

export interface MergeTarget {
  id: string;
  name: string;
  isSystem: boolean;
  /** categoryName stored in rows: enum value or CUSTOM:<uuid> */
  categoryName: string;
}

export interface MergeResult {
  preview: boolean;
  sourceId: string;
  sourceName: string;
  type: CategoryType;
  target: Omit<MergeTarget, 'categoryName'>;
  counts: MergeCounts;
}

export interface MergeInput {
  sourceId: string;
  targetCategoryId?: string;
  targetSystemName?: CategoryName;
  preview: boolean;
}

function systemType(name: CategoryName): CategoryType | null {
  if (getCategoriesByType(CategoryType.INCOME).includes(name)) return CategoryType.INCOME;
  if (getCategoriesByType(CategoryType.EXPENSE).includes(name)) return CategoryType.EXPENSE;
  return null; // TRANSFER / ALLOCATION: movement markers, never a merge target
}

type Db = Prisma.TransactionClient;

/** Household that owns the source category, for the route's authorization step; null when it does not exist (anymore). */
export async function findSourceHousehold(sourceId: string): Promise<string | null> {
  const row = await prisma.category.findUnique({ where: { id: sourceId }, select: { householdId: true } });
  return row?.householdId ?? null;
}

/**
 * Merge a custom category into another one of the same type, in ONE database transaction:
 * the source (and the target, when custom) rows are locked FOR UPDATE in id order (two opposite merges cannot
 * deadlock, the second one finds its source gone and gets 404), every reference is moved, the source is deleted.
 *
 * Idempotency: merging an id that was already merged (or never existed) is a 404, nothing changes. A retry after a
 * lost response therefore never moves rows twice. Self merge, other type, other household target: 400/404.
 * preview=true runs the same validation and counting without locking or writing anything.
 */
export async function mergeCategory(householdId: string, input: MergeInput): Promise<MergeResult> {
  if (input.targetCategoryId && input.targetCategoryId === input.sourceId) {
    throw new CategoryMergeError('CATEGORY_MERGE_SELF', 'A category cannot be merged into itself');
  }

  if (input.preview) {
    return prisma.$transaction((tx: Db) => run(tx, householdId, input, false));
  }
  return prisma.$transaction((tx: Db) => run(tx, householdId, input, true));
}

async function run(tx: Db, householdId: string, input: MergeInput, write: boolean): Promise<MergeResult> {
  const ids = [input.sourceId, ...(input.targetCategoryId ? [input.targetCategoryId] : [])];
  if (write) {
    // Lock in id order so two opposite merges cannot deadlock.
    const sorted = [...ids].sort();
    for (const id of sorted) {
      await tx.$queryRaw`SELECT id FROM categories WHERE id = ${id}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
    }
  }

  const source = await tx.category.findFirst({ where: { id: input.sourceId, householdId } });
  if (!source) throw new NotFoundError('Category');

  let target: MergeTarget;
  if (input.targetCategoryId) {
    const custom = await tx.category.findFirst({ where: { id: input.targetCategoryId, householdId } });
    if (!custom) throw new NotFoundError('Target category');
    if (custom.type !== source.type) {
      throw new CategoryMergeError('CATEGORY_MERGE_TYPE_MISMATCH', 'Categories of different types cannot be merged');
    }
    target = { id: custom.id, name: custom.name, isSystem: false, categoryName: toCustomCategoryName(custom.id) };
  } else {
    const name = input.targetSystemName!;
    const type = systemType(name);
    if (!type) throw new CategoryMergeError('CATEGORY_MERGE_TARGET_INVALID', 'This category cannot be a merge target');
    if (type !== source.type) {
      throw new CategoryMergeError('CATEGORY_MERGE_TYPE_MISMATCH', 'Categories of different types cannot be merged');
    }
    target = { id: name, name: CATEGORY_NAME_DISPLAY[name], isSystem: true, categoryName: name };
  }

  const from = toCustomCategoryName(source.id);
  const sourceBudgets = await tx.budget.findMany({ where: { householdId, categoryName: from } });
  const targetBudgets = await tx.budget.findMany({
    where: { householdId, categoryName: target.categoryName, month: { in: sourceBudgets.map((b: { month: Date }) => b.month) } },
  });
  const targetMonths = new Map<number, { id: string }>(targetBudgets.map((b: { id: string; month: Date }) => [b.month.getTime(), { id: b.id }]));
  const combine = sourceBudgets.filter((b: { month: Date }) => targetMonths.has(b.month.getTime()));
  const move = sourceBudgets.filter((b: { month: Date }) => !targetMonths.has(b.month.getTime()));

  const counts: MergeCounts = {
    transactions: await tx.transaction.count({ where: { householdId, categoryName: from } }),
    recurringTransactions: await tx.recurringTransaction.count({ where: { householdId, categoryName: from } }),
    budgets: move.length,
    budgetsCombined: combine.length,
  };

  if (write) {
    await tx.transaction.updateMany({ where: { householdId, categoryName: from }, data: { categoryName: target.categoryName } });
    await tx.recurringTransaction.updateMany({ where: { householdId, categoryName: from }, data: { categoryName: target.categoryName } });
    for (const budget of combine as Array<{ id: string; month: Date; monthlyLimit: Prisma.Decimal }>) {
      const into = targetMonths.get(budget.month.getTime())!;
      await tx.budget.update({ where: { id: into.id }, data: { monthlyLimit: { increment: budget.monthlyLimit } } });
      await tx.budget.delete({ where: { id: budget.id } });
    }
    if (move.length > 0) {
      await tx.budget.updateMany({ where: { householdId, categoryName: from }, data: { categoryName: target.categoryName } });
    }
    await tx.category.delete({ where: { id: source.id } });
  }

  const { categoryName: _stored, ...publicTarget } = target;
  return { preview: !write, sourceId: source.id, sourceName: source.name, type: source.type as CategoryType, target: publicTarget, counts };
}
