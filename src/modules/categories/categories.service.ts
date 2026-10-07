import { prisma } from '../../shared/db/prisma.js';
import { Prisma } from '../../generated/prisma/client.js';
import { NotFoundError, CategoryInUseError, CategoryNameTakenError } from '../../shared/errors/index.js';
import {
  CategoryName,
  CategoryType,
  CATEGORY_NAME_DISPLAY,
  getCategoriesByType,
} from '../../shared/enums/index.js';
import { toCustomCategoryName, normalizeCategoryName } from '../../shared/utils/categoryHelpers.js';

export { normalizeCategoryName };
import type {
  CreateCategoryInput,
  UpdateCategoryInput,
  ListCategoriesQuery,
} from './categories.schema.js';

/**
 * Create a custom category
 */
export async function createCategory(input: CreateCategoryInput) {
  await assertNameAvailable(input.householdId!, input.type, input.name);

  try {
    return await prisma.category.create({
      data: {
        householdId: input.householdId!,
        name: input.name,
        type: input.type,
        icon: input.icon ?? undefined,
        color: input.color ?? undefined,
      },
    });
  } catch (error) {
    // Two creates racing past the check: the unique index (household, name, type) decides.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new CategoryNameTakenError();
    }
    throw error;
  }
}

/**
 * A name is free when no other custom category of the household+type, and no system category of that type, has the
 * same name once case, accents and extra spaces are ignored ("investimentos" collides with the system "Investimentos").
 * Categories that already exist are never touched by this check, only new names and renames.
 */
async function assertNameAvailable(householdId: string, type: CategoryType, name: string, ignoreId?: string): Promise<void> {
  const wanted = normalizeCategoryName(name);
  const systemClash = getCategoriesByType(type).some((n: CategoryName) => normalizeCategoryName(CATEGORY_NAME_DISPLAY[n]) === wanted);
  if (systemClash) {
    throw new CategoryNameTakenError('A system category with this name already exists');
  }
  const siblings = await prisma.category.findMany({
    where: { householdId, type, ...(ignoreId && { id: { not: ignoreId } }) },
    select: { name: true },
  });
  if (siblings.some((c: { name: string }) => normalizeCategoryName(c.name) === wanted)) {
    throw new CategoryNameTakenError();
  }
}

/**
 * Get custom category by ID (must belong to household)
 */
export async function getCategory(categoryId: string, householdId: string) {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, householdId },
  });

  if (!category) {
    throw new NotFoundError('Category');
  }

  return category;
}

/**
 * Find custom category by ID only (used by GET /:id to resolve householdId for auth)
 */
export async function findCategoryById(categoryId: string) {
  return prisma.category.findUnique({
    where: { id: categoryId },
  });
}

/**
 * List custom categories for a household
 */
export async function listCategories(query: ListCategoriesQuery) {
  const { householdId, type } = query;

  const categories = await prisma.category.findMany({
    where: {
      householdId: householdId!,
      ...(type && { type }),
    },
    orderBy: [{ type: 'asc' }, { name: 'asc' }],
  });

  return categories;
}

/**
 * Update custom category
 */
export async function updateCategory(
  categoryId: string,
  householdId: string,
  input: UpdateCategoryInput
) {
  const category = await prisma.category.findFirst({
    where: { id: categoryId, householdId },
  });

  if (!category) {
    throw new NotFoundError('Category');
  }

  // Only a real change of name is checked (the same name with other letter case is allowed on itself).
  // References are CUSTOM:<id>, so renaming never touches transactions, budgets or recurring rows.
  if (input.name && input.name !== category.name) {
    await assertNameAvailable(householdId, category.type as CategoryType, input.name, categoryId);
  }

  try {
    return await prisma.category.update({
      where: { id: categoryId },
      data: {
        ...(input.name != null && { name: input.name }),
        ...(input.icon !== undefined && { icon: input.icon }),
        ...(input.color !== undefined && { color: input.color }),
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      throw new CategoryNameTakenError();
    }
    throw error;
  }
}

/**
 * Delete custom category only if not used in transactions, budgets, or recurring.
 * The check and the delete run in one database transaction holding the category row lock, the same lock a merge takes.
 */
export async function deleteCategory(categoryId: string, householdId: string) {
  await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM categories WHERE id = ${categoryId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
    if (locked.length === 0) {
      throw new NotFoundError('Category');
    }

    const customName = toCustomCategoryName(categoryId);
    const [txCount, budgetCount, recCount] = await Promise.all([
      tx.transaction.count({ where: { householdId, categoryName: customName } }),
      tx.budget.count({ where: { householdId, categoryName: customName } }),
      tx.recurringTransaction.count({ where: { householdId, categoryName: customName } }),
    ]);

    if (txCount > 0 || budgetCount > 0 || recCount > 0) {
      throw new CategoryInUseError('Category is in use');
    }

    await tx.category.delete({ where: { id: categoryId } });
  });
}

export interface CategoryUsage {
  transactions: number;
  recurringTransactions: number;
  budgets: number;
}

/** Usage counts per category name (system enum value or CUSTOM:<id>) of a household, three grouped queries. */
export async function getCategoryUsage(householdId: string): Promise<Map<string, CategoryUsage>> {
  const [tx, rec, bud] = await Promise.all([
    prisma.transaction.groupBy({ by: ['categoryName'], where: { householdId, categoryName: { not: null } }, _count: { _all: true } }),
    prisma.recurringTransaction.groupBy({ by: ['categoryName'], where: { householdId }, _count: { _all: true } }),
    prisma.budget.groupBy({ by: ['categoryName'], where: { householdId }, _count: { _all: true } }),
  ]);
  const usage = new Map<string, CategoryUsage>();
  const slot = (name: string): CategoryUsage => {
    let entry = usage.get(name);
    if (!entry) {
      entry = { transactions: 0, recurringTransactions: 0, budgets: 0 };
      usage.set(name, entry);
    }
    return entry;
  };
  for (const row of tx as Array<{ categoryName: string | null; _count: { _all: number } }>) if (row.categoryName) slot(row.categoryName).transactions = row._count._all;
  for (const row of rec as Array<{ categoryName: string; _count: { _all: number } }>) slot(row.categoryName).recurringTransactions = row._count._all;
  for (const row of bud as Array<{ categoryName: string; _count: { _all: number } }>) slot(row.categoryName).budgets = row._count._all;
  return usage;
}
