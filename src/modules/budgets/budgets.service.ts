import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import { parseMonthFilter } from '../../shared/utils/pagination.js';
import { CategoryType, GENERAL_BUDGET_CATEGORY, getCategoriesByType, getCategoryColor } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { lockCustomCategory } from '../../shared/utils/categoryLock.js';
import type {
  CreateBudgetInput,
  UpdateBudgetInput,
  ListBudgetsQuery,
  BudgetSummaryQuery,
} from './budgets.schema.js';

/**
 * Create a new budget
 */
export async function createBudget(input: CreateBudgetInput) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const { categoryName, monthlyLimit, month, type } = input;

  // Verify category type matches budget type
  if (categoryName === GENERAL_BUDGET_CATEGORY) {
    // General pseudo-category is valid for both INCOME and EXPENSE budgets.
  } else if (isCustomCategoryName(categoryName)) {
    const customId = toCustomCategoryId(categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat || cat.type !== type) {
      throw new BadRequestError(`Category does not match budget type (${type})`);
    }
  } else {
    const categoriesByType = getCategoriesByType(type);
    if (!categoriesByType.includes(categoryName as any)) {
      throw new BadRequestError(`Category ${categoryName} does not match budget type (${type})`);
    }
  }

  // Normalize month to start of month
  const monthStart = new Date(month);
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  // Check if budget already exists for this category, month and type.
  // Including type lets a household keep both a general INCOME and a general
  // EXPENSE budget in the same month (GENERAL is shared across both types).
  const existingBudget = await prisma.budget.findFirst({
    where: {
      householdId,
      categoryName,
      month: monthStart,
      type,
    },
  });

  if (existingBudget) {
    throw new BadRequestError('Budget already exists for this category and month');
  }

  const budget = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await lockCustomCategory(tx, householdId, categoryName);
    return tx.budget.create({
      data: {
        householdId,
        categoryName,
        monthlyLimit: new Prisma.Decimal(monthlyLimit),
        month: monthStart,
        type,
      },
    });
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  };
}

/**
 * Get budget by ID
 */
export async function getBudget(budgetId: string) {
  const budget = await prisma.budget.findUnique({
    where: { id: budgetId },
  });

  if (!budget) {
    throw new NotFoundError('Budget');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  };
}

/**
 * List budgets for a household
 */
export async function listBudgets(query: ListBudgetsQuery) {
  const { householdId } = query;

  const budgets = await prisma.budget.findMany({
    where: { householdId },
    orderBy: [
      { month: 'desc' },
      { createdAt: 'desc' },
    ],
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return budgets.map(budget => ({
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  }));
}

/**
 * Update budget
 */
export async function updateBudget(budgetId: string, input: UpdateBudgetInput) {
  const updateData: any = {
    ...(input.monthlyLimit !== undefined && {
      monthlyLimit: new Prisma.Decimal(input.monthlyLimit),
    }),
    ...(input.type !== undefined && { type: input.type }),
  };

  // Normalize month to start of month if provided
  if (input.month) {
    const monthStart = new Date(input.month);
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    updateData.month = monthStart;
  }

  const budget = await prisma.budget.update({
    where: { id: budgetId },
    data: updateData,
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...budget,
    monthlyLimit: budget.monthlyLimit.toNumber(),
  };
}

/**
 * Delete budget
 */
export async function deleteBudget(budgetId: string) {
  const budget = await prisma.budget.findUnique({
    where: { id: budgetId },
  });

  if (!budget) {
    throw new NotFoundError('Budget');
  }

  await prisma.budget.delete({
    where: { id: budgetId },
  });

  return { deleted: true };
}

/**
 * Get budget summary with spending vs limit
 */
export async function getBudgetSummary(query: BudgetSummaryQuery) {
  const { householdId, month, startDate, endDate } = query;

  // Build date filter
  let dateFilter: { gte?: Date; lte?: Date } | undefined;
  if (month) {
    const { start, end } = parseMonthFilter(month);
    dateFilter = { gte: start, lte: end };
  } else if (startDate || endDate) {
    dateFilter = {};
    if (startDate) dateFilter.gte = startDate;
    if (endDate) dateFilter.lte = endDate;
  }

  // Get all budgets for the household
  const budgets = await prisma.budget.findMany({
    where: { householdId },
  });

  // Resolve colors for custom categories (batch)
  const customIds = budgets
    .filter((b) => isCustomCategoryName(b.categoryName))
    .map((b) => toCustomCategoryId(b.categoryName)!);
  const customCategories = customIds.length
    ? await prisma.category.findMany({ where: { id: { in: customIds }, householdId }, select: { id: true, color: true } })
    : [];
  const customColorMap = new Map(customCategories.map((c) => [c.id, c.color ?? '#64748B']));

  function categoryColor(categoryName: string): string {
    if (isCustomCategoryName(categoryName)) {
      return customColorMap.get(toCustomCategoryId(categoryName)!) ?? '#64748B';
    }
    return getCategoryColor(categoryName as any);
  }

  // Get spending for each budget category
  const budgetSummaries = await Promise.all(
    budgets.map(async (budget: { categoryName: string; monthlyLimit: Prisma.Decimal; month: Date; type: string; id: string; householdId: string; createdAt: Date; updatedAt: Date }) => {
      let spending: number;

      if (budget.categoryName === GENERAL_BUDGET_CATEGORY) {
        // General pseudo-budget represents the total spending/income of the period.
        const totalWhere: Prisma.TransactionWhereInput = {
          householdId,
          type: budget.type as CategoryType,
          ...(dateFilter && { date: dateFilter }),
        };
        const totalTransactions = await prisma.transaction.findMany({
          where: totalWhere,
          select: { amount: true },
        });
        spending = totalTransactions.reduce((sum: number, t: { amount: Prisma.Decimal }) => {
          return sum + Math.abs(t.amount.toNumber());
        }, 0);
      } else {
        const where: Prisma.TransactionWhereInput = {
          householdId,
          categoryName: budget.categoryName,
          ...(dateFilter && { date: dateFilter }),
        };

        const transactions = await prisma.transaction.findMany({
          where,
          select: { amount: true },
        });

        spending = transactions.reduce((sum: number, t: { amount: Prisma.Decimal }) => {
          return sum + Math.abs(t.amount.toNumber());
        }, 0);
      }

      const limit = budget.monthlyLimit.toNumber();
      const remaining = limit - spending;
      const percentage = limit > 0 ? (spending / limit) * 100 : 0;

      return {
        budgetId: budget.id,
        categoryName: budget.categoryName,
        categoryColor: categoryColor(budget.categoryName),
        monthlyLimit: limit,
        spending,
        remaining,
        percentage: Math.round(percentage * 100) / 100,
        isOverBudget: spending > limit,
      };
    })
  );

  return {
    budgets: budgetSummaries,
    totalLimit: budgets.reduce((sum: number, b: { monthlyLimit: Prisma.Decimal }) => sum + b.monthlyLimit.toNumber(), 0),
    totalSpending: budgetSummaries.reduce((sum: number, b: { spending: number }) => sum + b.spending, 0),
  };
}

