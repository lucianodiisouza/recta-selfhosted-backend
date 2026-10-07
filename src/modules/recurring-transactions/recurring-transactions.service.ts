import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import { getCategoryColor, getCategoriesByType, CategoryType, AccountType, TransactionType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { updateBalanceForNormalTransaction, recalculateCreditCardLimit } from '../../shared/services/balance.service.js';
import { dayString, monthBoundsUtc } from './recurring-dates.js';
import { FOLLOW_LOOKAHEAD_DAYS, plusDays } from './recurring-follow.js';
import type {
  CreateRecurringTransactionInput,
  UpdateRecurringTransactionInput,
  ListRecurringTransactionsQuery,
  ExecuteRecurringTransactionInput,
} from './recurring-transactions.schema.js';

/**
 * Calculate next run date based on frequency
 */
function calculateNextRunDate(
  currentDate: Date,
  frequency: 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY'
): Date {
  const next = new Date(currentDate);

  switch (frequency) {
    case 'DAILY':
      next.setDate(next.getDate() + 1);
      break;
    case 'WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'BIWEEKLY':
      next.setDate(next.getDate() + 14);
      break;
    case 'MONTHLY':
      next.setMonth(next.getMonth() + 1);
      break;
    case 'YEARLY':
      next.setFullYear(next.getFullYear() + 1);
      break;
  }

  return next;
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Criar uma recorrência NÃO cria transações antecipadamente.
 * Recorrências são apenas REGRAS de geração futura.
 * 
 * Transações reais são criadas APENAS pelo cronjob no dia do vencimento.
 * Isso garante que:
 * - Limite de cartão NÃO é consumido antecipadamente
 * - Saldos NÃO são afetados até a data de vencimento
 * - Sistema financeiro permanece previsível e consistente
 * 
 * Create a new recurring transaction (rule only, no transactions created)
 */
export async function createRecurringTransaction(
  input: CreateRecurringTransactionInput
) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const {
    accountId,
    categoryName,
    amount,
    description,
    frequency,
    startDate,
    endDate,
    nextRunAt,
    isActive,
    followLastAmount,
  } = input;

  // Verify account belongs to household
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isActive: true },
  });

  if (!account) {
    throw new NotFoundError('Account');
  }

  // Validate custom category exists and belongs to household
  if (isCustomCategoryName(categoryName)) {
    const customId = toCustomCategoryId(categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat) throw new BadRequestError('Custom category not found or does not belong to this household');
  }

  const recurring = await prisma.recurringTransaction.create({
    data: {
      householdId,
      accountId,
      categoryName,
      amount: new Prisma.Decimal(amount),
      description,
      frequency,
      startDate,
      endDate,
      nextRunAt,
      isActive,
      followLastAmount,
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });

  // REGRA DE NEGÓCIO: Edge case de timing
  // Se a recorrência foi criada com nextRunAt = hoje (ou no passado) e startDate <= hoje,
  // processar imediatamente para não esperar até o próximo cronjob
  // Isso resolve o caso onde o usuário cria uma recorrência depois do horário do cronjob (01:00)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const nextRunAtDate = new Date(nextRunAt);
  nextRunAtDate.setHours(0, 0, 0, 0);
  
  const startDateNormalized = new Date(startDate);
  startDateNormalized.setHours(0, 0, 0, 0);
  
  const shouldProcessImmediately = 
    isActive && 
    nextRunAtDate <= today && 
    startDateNormalized <= today;

  if (shouldProcessImmediately) {
    try {
      // Verificar se já existe transação para hoje (idempotência)
      const existingTransaction = await prisma.transaction.findFirst({
        where: {
          householdId,
          recurringTransactionId: recurring.id,
          date: today,
        },
      });

      if (!existingTransaction) {
        // Processar imediatamente
        const isCreditCard = account.type === AccountType.CREDIT;
        const shouldCreateAsPaid = isCreditCard;

        await executeRecurringTransaction(recurring.id, householdId, {
          date: today,
          paid: shouldCreateAsPaid,
        });

        console.log(
          `[RecurringTransaction] ✅ Processed immediately after creation: ${recurring.id} - ` +
          `Date: ${today.toISOString().split('T')[0]} - Paid: ${shouldCreateAsPaid}`
        );
      }
    } catch (error) {
      // Não falhar a criação da recorrência se o processamento imediato falhar
      // Log do erro mas continua
      console.error(
        `[RecurringTransaction] ⚠️  Error processing immediately after creation: ${recurring.id}`,
        error
      );
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...recurring,
    amount: recurring.amount.toNumber(),
  };
}

/**
 * Date (YYYY-MM-DD) of the most recent occurrence of each recurrence that still counts as "the current one" (not beyond
 * today + 31 days, the rule of followLastAmountInTx). A client editing an occurrence knows only a page of transactions,
 * so it compares the edited date with this: `date >= lastOccurrenceDate` means it is the latest one.
 */
async function lastOccurrenceDates(householdId: string, recurringIds: string[], now: Date = new Date()): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (recurringIds.length === 0) return map;
  const limit = plusDays(now, FOLLOW_LOOKAHEAD_DAYS);
  const rows = await prisma.transaction.groupBy({
    by: ['recurringTransactionId'],
    where: { householdId, recurringTransactionId: { in: recurringIds }, date: { lte: new Date(`${limit}T00:00:00.000Z`) } },
    _max: { date: true },
  });
  for (const r of rows) if (r.recurringTransactionId && r._max.date) map.set(r.recurringTransactionId, dayString(r._max.date));
  return map;
}

/**
 * Get recurring transaction by ID
 */
export async function getRecurringTransaction(recurringId: string) {
  const recurring = await prisma.recurringTransaction.findUnique({
    where: { id: recurringId },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...recurring,
    amount: recurring.amount.toNumber(),
  };
}

/**
 * List recurring transactions for a household
 */
export async function listRecurringTransactions(
  query: ListRecurringTransactionsQuery
) {
  const { householdId, isActive } = query;

  const recurring = await prisma.recurringTransaction.findMany({
    where: {
      householdId,
      ...(isActive !== undefined && { isActive }),
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }],
  });

  const last = await lastOccurrenceDates(householdId as string, recurring.map((r) => r.id));
  // Convert Prisma.Decimal to number for JSON serialization
  return recurring.map(r => ({
    ...r,
    amount: r.amount.toNumber(),
    lastOccurrenceDate: last.get(r.id) ?? null,
  }));
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Atualizar uma recorrência NÃO cria transações antecipadamente.
 * Apenas atualiza a REGRA de recorrência.
 * 
 * Transações reais continuam sendo criadas apenas pelo cronjob no dia do vencimento.
 * 
 * Update recurring transaction (rule only, no transactions created)
 */
export async function updateRecurringTransaction(
  recurringId: string,
  householdId: string,
  input: UpdateRecurringTransactionInput
) {
  const existing = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
  });

  if (!existing) {
    throw new NotFoundError('Recurring transaction');
  }

  // Validate new account if provided
  if (input.accountId && input.accountId !== existing.accountId) {
    const account = await prisma.account.findFirst({
      where: { id: input.accountId, householdId, isActive: true },
    });
    if (!account) {
      throw new NotFoundError('Account');
    }
  }

  // Validate custom category exists when updating categoryName
  if (input.categoryName && isCustomCategoryName(input.categoryName)) {
    const customId = toCustomCategoryId(input.categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat) throw new BadRequestError('Custom category not found or does not belong to this household');
  }

  const recurring = await prisma.recurringTransaction.update({
    where: { id: recurringId },
    data: {
      ...(input.accountId && { accountId: input.accountId }),
      ...(input.categoryName && { categoryName: input.categoryName }),
      ...(input.amount !== undefined && { amount: new Prisma.Decimal(input.amount) }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.frequency && { frequency: input.frequency }),
      ...(input.startDate && { startDate: input.startDate }),
      ...(input.endDate !== undefined && { endDate: input.endDate }),
      ...(input.nextRunAt && { nextRunAt: input.nextRunAt }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      ...(input.followLastAmount !== undefined && { followLastAmount: input.followLastAmount }),
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });

  // REGRA DE NEGÓCIO: Edge case de timing
  // Se a recorrência foi atualizada com nextRunAt = hoje (ou no passado) e startDate <= hoje,
  // processar imediatamente para não esperar até o próximo cronjob
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const nextRunAtDate = new Date(recurring.nextRunAt);
  nextRunAtDate.setHours(0, 0, 0, 0);
  
  const startDateNormalized = new Date(recurring.startDate);
  startDateNormalized.setHours(0, 0, 0, 0);
  
  const shouldProcessImmediately = 
    recurring.isActive && 
    nextRunAtDate <= today && 
    startDateNormalized <= today;

  if (shouldProcessImmediately) {
    try {
      // Verificar se já existe transação para hoje (idempotência)
      const existingTransaction = await prisma.transaction.findFirst({
        where: {
          householdId,
          recurringTransactionId: recurring.id,
          date: today,
        },
      });

      if (!existingTransaction) {
        // Processar imediatamente
        const isCreditCard = recurring.account.type === AccountType.CREDIT;
        const shouldCreateAsPaid = isCreditCard;

        await executeRecurringTransaction(recurring.id, householdId, {
          date: today,
          paid: shouldCreateAsPaid,
        });

        console.log(
          `[RecurringTransaction] ✅ Processed immediately after update: ${recurring.id} - ` +
          `Date: ${today.toISOString().split('T')[0]} - Paid: ${shouldCreateAsPaid}`
        );
      }
    } catch (error) {
      // Não falhar a atualização da recorrência se o processamento imediato falhar
      // Log do erro mas continua
      console.error(
        `[RecurringTransaction] ⚠️  Error processing immediately after update: ${recurring.id}`,
        error
      );
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...recurring,
    amount: recurring.amount.toNumber(),
  };
}

/**
 * Delete recurring transaction
 */
export async function deleteRecurringTransaction(
  recurringId: string,
  householdId: string
) {
  const recurring = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  await prisma.recurringTransaction.delete({
    where: { id: recurringId },
  });

  return { deleted: true };
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Esta função é chamada APENAS pelo cronjob no dia do vencimento.
 * 
 * Cria uma transação REAL:
 * - Para cartão de crédito: paid: true (consome limite imediatamente)
 * - Para conta bancária: paid: false (pendente para revisão)
 * 
 * Atualiza lastRunDate e nextRunAt.
 * NÃO deve ser chamada manualmente pelo usuário.
 */
export async function executeRecurringTransaction(
  recurringId: string,
  householdId: string,
  input: ExecuteRecurringTransactionInput = {}
) {
  const recurring = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId, isActive: true },
    include: {
      account: true,
    },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  const transactionDate = input.date || recurring.nextRunAt;
  const isPaid = input.paid ?? false; // Default: false (pendente)

  let isIncome: boolean;
  if (isCustomCategoryName(recurring.categoryName)) {
    const cat = await prisma.category.findFirst({
      where: { id: toCustomCategoryId(recurring.categoryName)!, householdId },
      select: { type: true },
    });
    isIncome = cat?.type === CategoryType.INCOME;
  } else {
    isIncome = getCategoriesByType(CategoryType.INCOME).includes(recurring.categoryName as any);
  }

  function calculateBalanceChange(amount: number, isInc: boolean, accountType: string): number {
    const isCreditCard = accountType === AccountType.CREDIT;
    if (isCreditCard) return isInc ? -amount : amount;
    return isInc ? amount : -amount;
  }

  // Determine transaction type
  const transactionType = isIncome ? TransactionType.INCOME : TransactionType.EXPENSE;

  // Create the actual transaction and update next run date
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Idempotency guard: a monthly recurrence has at most one occurrence per month. When the month already holds a
    // transaction of this recurrence (generated earlier, or linked to it by the detector), nothing is created and the
    // recurrence just moves on. The check runs under a per-recurrence lock, so two executions (cron, manual) cannot
    // both see an empty month.
    if (recurring.frequency === 'MONTHLY') {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recurring:${recurring.id}`}))`;
      const { start, end } = monthBoundsUtc(dayString(transactionDate));
      const existing = await tx.transaction.findFirst({
        where: { householdId, recurringTransactionId: recurring.id, date: { gte: start, lt: end } },
        include: { account: { select: { id: true, name: true, type: true } } },
      });
      if (existing) {
        const nextRunAt = calculateNextRunDate(transactionDate, recurring.frequency);
        await tx.recurringTransaction.update({
          where: { id: recurringId },
          data: { lastRunDate: transactionDate, nextRunAt },
        });
        return { transaction: existing, nextRunAt, skipped: true as boolean };
      }
    }

    // Create transaction
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: transactionType,
        accountId: recurring.accountId,
        categoryName: recurring.categoryName,
        amount: recurring.amount,
        description: recurring.description || `Recurring: ${recurring.categoryName}`,
        date: transactionDate,
        notes: `Auto-generated from recurring transaction: ${recurring.id} on ${new Date().toISOString()}`,
        paid: isPaid,
        recurringTransactionId: recurring.id,
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    // REGRA DE NEGÓCIO: Atualizar saldo APENAS se paid: true
    // Para cartão de crédito: consome limite imediatamente
    // Para conta bancária: saldo só é atualizado quando confirmada
    if (isPaid && recurring.account) {
      const amount = recurring.amount.toNumber();
      const balanceChange = calculateBalanceChange(amount, isIncome, recurring.account.type);
      
      // Use centralized balance update function to ensure consistency
      await updateBalanceForNormalTransaction(tx, recurring.accountId, balanceChange);
      
      // Recalculate credit card limit if it's a credit card
      if (recurring.account.type === AccountType.CREDIT) {
        await recalculateCreditCardLimit(tx, recurring.accountId);
      }
    }

    // Calculate and update next run date
    const nextRunAt = calculateNextRunDate(transactionDate, recurring.frequency);

    // Update lastRunDate and nextRunAt
    await tx.recurringTransaction.update({
      where: { id: recurringId },
      data: { 
        lastRunDate: transactionDate,
        nextRunAt,
      },
    });

    return {
      transaction,
      nextRunAt,
      skipped: false as boolean,
    };
  });

  return result;
}

/**
 * Get recurring transactions that are due (nextRunAt <= today)
 */
export async function getDueRecurringTransactions(householdId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = await prisma.recurringTransaction.findMany({
    where: {
      householdId,
      isActive: true,
      nextRunAt: {
        lte: today,
      },
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: { nextRunAt: 'asc' },
  });

  return due;
}

