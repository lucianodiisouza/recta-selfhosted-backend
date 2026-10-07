import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError, ForbiddenError, ConflictError } from '../../shared/errors/index.js';
import {
  createPaginatedResponse,
  buildPaginationArgs,
  parseMonthFilter,
} from '../../shared/utils/pagination.js';
import { CategoryType, getCategoriesByType, getCategoryColor, AccountType, TransactionType, CATEGORY_NAME_DISPLAY } from '../../shared/enums/index.js';
import { CategoryName } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';
import { effectiveClosingDay } from '../accounts/closing-day.js';
import { executeRecurringTransaction } from '../recurring-transactions/recurring-transactions.service.js';
import { applyTransfer, applyAllocation, applyDeallocation, recalculateCreditCardLimit, updateBalanceForNormalTransaction } from '../../shared/services/balance.service.js';
import type {
  CreateTransactionInput,
  UpdateTransactionInput,
  ListTransactionsQuery,
  TransactionSummaryQuery,
  BatchCreateTransactionsInput,
  BatchDeleteTransactionsInput,
  PayInvoiceInput,
  CreditCardInvoiceParams,
  UndoPaymentParams,
} from './transactions.schema.js';

/**
 * Calculate balance change for a transaction based on account type and income/expense
 * @param amount Transaction amount (always positive)
 * @param isIncome True for INCOME, false for EXPENSE
 * @param accountType Account type (CREDIT for credit cards, others for bank accounts)
 * @returns Positive number to increment, negative number to decrement
 */
function calculateBalanceChange(amount: number, isIncome: boolean, accountType: string): number {
  const isCreditCard = accountType === AccountType.CREDIT;
  if (isCreditCard) {
    return isIncome ? -amount : amount;
  }
  return isIncome ? amount : -amount;
}

/**
 * Server-side extras of a create (not part of the HTTP schema, so a client cannot set them): an importer stamps the
 * row with the stable id of its source line.
 */
export type InternalCreateTransactionInput = CreateTransactionInput & { sourceRef?: string };

/** Hooks of createTransaction. */
export interface CreateTransactionHooks {
  /**
   * Runs inside the database transaction, after the row (and its balance effects) was written. Throwing rolls the whole
   * create back, so the caller's own writes (for example external refs) commit or vanish together with the row.
   */
  inTransaction?: (tx: Prisma.TransactionClient, created: { id: string }) => Promise<void>;
}

/**
 * Create a new transaction and update account balance
 * @param input Transaction input data
 * @param userId Optional user ID - if provided, allows using personal accounts in shared household
 * @param hooks Optional caller writes that commit or roll back together with the transaction
 */
export async function createTransaction(
  input: InternalCreateTransactionInput,
  userId?: string,
  hooks?: CreateTransactionHooks
) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const { accountId, categoryName, amount, description, date, notes } = input;

  // Verify account belongs to household (if accountId is provided)
  // If userId is provided, also allow accounts from user's personal household
  let account = null;
  if (accountId) {
    // First, try to find account in the transaction's household
    account = await prisma.account.findFirst({
      where: { id: accountId, householdId, isActive: true },
    });

    // If not found and userId is provided, try to find in user's personal household or other members' personal households
    if (!account && userId) {
      // Get user's personal household (oldest household)
      const userMemberships = await prisma.householdMember.findMany({
        where: { userId },
        include: { household: true },
        orderBy: { createdAt: 'asc' },
        take: 1,
      });

      const personalHousehold = userMemberships[0]?.household;
      const isSharedHousehold = personalHousehold && personalHousehold.id !== householdId;

      // First, try user's own personal account
      if (personalHousehold) {
        account = await prisma.account.findFirst({
          where: { 
            id: accountId, 
            householdId: personalHousehold.id, 
            isActive: true 
          },
        });
      }

      // If not found and this is a shared household, try other members' personal accounts (if they allowed access)
      if (!account && isSharedHousehold) {
        // Find which member owns this account by checking all members' personal households
        const allHouseholdMembers = await prisma.householdMember.findMany({
          where: { householdId },
          select: { userId: true, allowPersonalAccountAccess: true },
        });

        // Get personal households of members who allowed access
        const allowedMemberIds = allHouseholdMembers
          .filter(m => m.userId !== userId && m.allowPersonalAccountAccess)
          .map(m => m.userId);

        if (allowedMemberIds.length > 0) {
          const allowedPersonalHouseholds = await prisma.householdMember.findMany({
            where: {
              userId: { in: allowedMemberIds },
            },
            include: { household: true },
            orderBy: { createdAt: 'asc' },
          });

          // Get unique personal households (oldest per user)
          const personalHouseholdMap = new Map<string, string>();
          for (const membership of allowedPersonalHouseholds) {
            if (!personalHouseholdMap.has(membership.userId)) {
              personalHouseholdMap.set(membership.userId, membership.household.id);
            }
          }

          // Try to find account in allowed personal households
          const allowedPersonalHouseholdIds = Array.from(personalHouseholdMap.values());
          if (allowedPersonalHouseholdIds.length > 0) {
            account = await prisma.account.findFirst({
              where: { 
                id: accountId, 
                householdId: { in: allowedPersonalHouseholdIds },
                isActive: true 
              },
            });

            if (account) {
              // Verify the account owner has allowed access
              const accountOwnerMembership = allowedPersonalHouseholds.find(
                m => m.household.id === account!.householdId
              );
              if (!accountOwnerMembership) {
                throw new ForbiddenError('You do not have permission to use this account');
              }

              // Double-check that the owner has allowPersonalAccountAccess enabled
              const ownerMembershipInSharedHousehold = allHouseholdMembers.find(
                m => m.userId === accountOwnerMembership.userId && m.allowPersonalAccountAccess
              );
              if (!ownerMembershipInSharedHousehold) {
                throw new ForbiddenError('The account owner has not allowed others to use their personal accounts');
              }
            }
          }
        }
      }
    }

    if (!account) {
      throw new NotFoundError('Account');
    }
  }

  // Resolve transaction type: from input, or infer from category (system or custom)
  let transactionType: TransactionType.INCOME | TransactionType.EXPENSE;
  if (input.type === TransactionType.INCOME || input.type === TransactionType.EXPENSE) {
    transactionType = input.type;
  } else if (isCustomCategoryName(categoryName!)) {
    const customId = toCustomCategoryId(categoryName!)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat) throw new BadRequestError('Custom category not found or does not belong to this household');
    transactionType = cat.type as TransactionType.INCOME | TransactionType.EXPENSE;
  } else {
    const isInc = getCategoriesByType(CategoryType.INCOME).includes(categoryName as any);
    transactionType = isInc ? TransactionType.INCOME : TransactionType.EXPENSE;
  }
  const isIncomeForBalance = (t: TransactionType) => t === TransactionType.INCOME;

  // Create transaction and update balance in a single transaction
  const isPaid = input.paid !== undefined ? input.paid : true;
  const isSplit = input.isSplit === true && input.splits && input.splits.length > 0;
  
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: transactionType,
        accountId,
        categoryName,
        amount: new Prisma.Decimal(amount),
        description,
        date,
        notes,
        paid: isPaid,
        isSplit: isSplit,
        ...(input.recurringTransactionId && { recurringTransactionId: input.recurringTransactionId }),
        ...(input.installmentId && { installmentId: input.installmentId }),
        ...(input.installmentNumber && { installmentNumber: input.installmentNumber }),
        ...(input.totalInstallments && { totalInstallments: input.totalInstallments }),
        ...(input.sourceRef && { sourceRef: input.sourceRef }),
        ...(input.attachmentUrl && { attachmentUrl: input.attachmentUrl }),
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
        fromAccount: {
          select: { id: true, name: true, type: true },
        },
        toAccount: {
          select: { id: true, name: true, type: true },
        },
        relatedAccount: {
          select: { id: true, name: true, type: true },
        },
        splits: {
          include: {
            user: {
              select: { id: true, email: true, displayName: true },
            },
          },
        },
      },
    });

    // Create splits if provided (for expense sharing)
    if (isSplit && input.splits && input.splits.length > 0) {
      // Verify all split users are members of the household and have EDITOR or OWNER role
      const householdMembers = await tx.householdMember.findMany({
        where: { householdId },
        select: { userId: true, role: true, sharedAccountIds: true, allowPersonalAccountAccess: true },
      });
      
      const memberMap = new Map(householdMembers.map(m => [m.userId, m]));
      
      // Validate each split member
      for (const split of input.splits) {
        const member = memberMap.get(split.userId);
        if (!member) {
          throw new BadRequestError(`User ${split.userId} is not a member of this household`);
        }
        
        // Only EDITOR and OWNER can be part of splits
        if (member.role !== 'EDITOR' && member.role !== 'OWNER') {
          throw new BadRequestError(`User ${split.userId} must be an EDITOR or OWNER to participate in splits`);
        }
        
        // Get user's personal household to check for shared accounts
        const userMemberships = await tx.householdMember.findMany({
          where: { userId: split.userId },
          include: { household: true },
          orderBy: { createdAt: 'asc' },
          take: 1,
        });
        
        const personalHousehold = userMemberships[0]?.household;
        if (!personalHousehold) {
          throw new BadRequestError(`User ${split.userId} does not have a personal household`);
        }
        
        // Check if member has shared accounts available
        const sharedIds = member.sharedAccountIds;
        const hasSpecificSharedAccounts = Array.isArray(sharedIds) && sharedIds.length > 0 && sharedIds.every((id: unknown) => typeof id === 'string');
        
        let availableAccounts: Array<{ id: string }> = [];
        if (hasSpecificSharedAccounts) {
          // Check specific shared account IDs
          availableAccounts = await tx.account.findMany({
            where: {
              id: { in: sharedIds as string[] },
              householdId: personalHousehold.id,
              isActive: true,
              type: { in: ['CHECKING', 'SAVINGS', 'CREDIT', 'CASH'] }, // Only these types can be used for splits
            },
            select: { id: true },
          });
        } else if (member.allowPersonalAccountAccess) {
          // Check all personal accounts if allowPersonalAccountAccess is enabled
          availableAccounts = await tx.account.findMany({
            where: {
              householdId: personalHousehold.id,
              isActive: true,
              type: { in: ['CHECKING', 'SAVINGS', 'CREDIT', 'CASH'] },
            },
            select: { id: true },
          });
        }
        
        if (availableAccounts.length === 0) {
          throw new BadRequestError(`User ${split.userId} must have at least one shared account or credit card to participate in splits. Please share an account in your account settings.`);
        }
        
        await tx.transactionSplit.create({
          data: {
            transactionId: transaction.id,
            userId: split.userId,
            amount: new Prisma.Decimal(split.amount),
            paid: isPaid, // Mark as paid if transaction is paid
          },
        });
      }
    }

    // Update account balance only if transaction is paid
    // transactionType is always INCOME or EXPENSE here (createTransaction doesn't handle TRANSFER/ALLOCATION)
    if (isPaid && account && categoryName && accountId) {
      // If there are splits and transaction is paid, each member should pay from their own account
      if (isSplit && input.splits && input.splits.length > 0) {
        // For each split, create a transaction in the member's personal account
        for (const split of input.splits) {
          // Get member's personal household
          const userMemberships = await tx.householdMember.findMany({
            where: { userId: split.userId },
            include: { household: true },
            orderBy: { createdAt: 'asc' },
            take: 1,
          });
          
          const personalHousehold = userMemberships[0]?.household;
          if (!personalHousehold) continue;
          
          // If accountId is provided in the split, use it (validate it belongs to the member)
          let memberAccount = null;
          
          if (split.accountId) {
            // Verify that the provided account belongs to the member's personal household
            const providedAccount = await tx.account.findFirst({
              where: {
                id: split.accountId,
                householdId: personalHousehold.id,
                isActive: true,
                type: { in: ['CHECKING', 'SAVINGS', 'CREDIT', 'CASH'] },
              },
            });
            
            if (providedAccount) {
              // Verify that this account is accessible (either shared or member's own account)
              const member = await tx.householdMember.findFirst({
                where: { householdId, userId: split.userId },
                select: { sharedAccountIds: true, allowPersonalAccountAccess: true },
              });
              
              if (member) {
                const sharedIds = member.sharedAccountIds;
                const hasSpecificSharedAccounts = Array.isArray(sharedIds) && sharedIds.length > 0 && sharedIds.every((id: unknown) => typeof id === 'string');
                const isSharedAccount = hasSpecificSharedAccounts && (sharedIds as string[]).includes(split.accountId);
                const hasPersonalAccess = member.allowPersonalAccountAccess;
                
                // Account is valid if it's explicitly shared or if personal access is allowed
                if (isSharedAccount || hasPersonalAccess) {
                  memberAccount = providedAccount;
                }
              }
            }
          }
          
          // If no accountId provided or validation failed, use auto-selection logic
          if (!memberAccount) {
            // Get member info to find shared accounts
            const member = await tx.householdMember.findFirst({
              where: { householdId, userId: split.userId },
              select: { sharedAccountIds: true, allowPersonalAccountAccess: true },
            });
            
            if (!member) continue;
            
            // Find an available shared account for this member
            const sharedIds = member.sharedAccountIds;
            const hasSpecificSharedAccounts = Array.isArray(sharedIds) && sharedIds.length > 0 && sharedIds.every((id: unknown) => typeof id === 'string');
            
            if (hasSpecificSharedAccounts) {
              // Try to find a shared account (prefer CHECKING or SAVINGS, then CREDIT, then CASH)
              const accounts = await tx.account.findMany({
                where: {
                  id: { in: sharedIds as string[] },
                  householdId: personalHousehold.id,
                  isActive: true,
                  type: { in: ['CHECKING', 'SAVINGS', 'CREDIT', 'CASH'] },
                },
                orderBy: [
                  { type: 'asc' }, // CHECKING/SAVINGS first
                ],
              });
              memberAccount = accounts[0] || null;
            } else if (member.allowPersonalAccountAccess) {
              // Try to find any personal account
              const accounts = await tx.account.findMany({
                where: {
                  householdId: personalHousehold.id,
                  isActive: true,
                  type: { in: ['CHECKING', 'SAVINGS', 'CREDIT', 'CASH'] },
                },
                orderBy: [
                  { type: 'asc' }, // CHECKING/SAVINGS first
                ],
              });
              memberAccount = accounts[0] || null;
            }
          }
          
          if (memberAccount) {
            // Create transaction for this member's split
            const splitAmount = split.amount;
            const splitBalanceChange = calculateBalanceChange(splitAmount, isIncomeForBalance(transactionType), memberAccount.type);
            
            // Create the split transaction
            await tx.transaction.create({
              data: {
                householdId: personalHousehold.id,
                type: transactionType,
                accountId: memberAccount.id,
                categoryName,
                amount: new Prisma.Decimal(splitAmount),
                description: `${description || 'Despesa compartilhada'} (parte de ${amount})`,
                date,
                notes: notes ? `${notes} - Split da transação ${transaction.id}` : `Split da transação ${transaction.id}`,
                paid: true,
                isSplit: false, // This is the individual split transaction, not the main one
              },
            });
            
            // Update member's account balance
            await updateBalanceForNormalTransaction(tx, memberAccount.id, splitBalanceChange);
            
            // Recalculate credit card limit if it's a credit card
            if (memberAccount.type === AccountType.CREDIT) {
              await recalculateCreditCardLimit(tx, memberAccount.id);
            }
          }
        }
        
        // Don't debit from the original account if splits are used - each member pays from their own account
        // The main transaction is just a record of the split
      } else {
        // Normal transaction without splits - debit from original account
        const balanceChange = calculateBalanceChange(amount, isIncomeForBalance(transactionType), account.type);
        
        // Use helper function to ensure totalBalance = availableBalance + allocatedBalance
        await updateBalanceForNormalTransaction(tx, accountId, balanceChange);

        // Recalculate credit card limit if it's a credit card
        if (account.type === AccountType.CREDIT && accountId) {
          await recalculateCreditCardLimit(tx, accountId);
        }
      }
    }

    // Caller's writes that must commit (or roll back) together with the transaction
    if (hooks?.inTransaction) await hooks.inTransaction(tx, transaction);

    return transaction;
  });

  // Reload transaction with splits to ensure we have fresh data
  const transactionWithSplits = await prisma.transaction.findUnique({
    where: { id: result.id },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
      fromAccount: {
        select: { id: true, name: true, type: true },
      },
      toAccount: {
        select: { id: true, name: true, type: true },
      },
      relatedAccount: {
        select: { id: true, name: true, type: true },
      },
      splits: {
        include: {
          user: {
            select: { id: true, email: true, displayName: true },
          },
        },
      },
    },
  });

  if (!transactionWithSplits) {
    throw new NotFoundError('Transaction');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  const convertedResult = {
    ...transactionWithSplits,
    amount: transactionWithSplits.amount.toNumber(),
    splits: transactionWithSplits.splits?.map(split => ({
      ...split,
      amount: split.amount.toNumber(),
    })) || [],
  };

  // Check budget thresholds and create notifications if needed (async, don't block)
  // Only check for expense transactions with a category
  if (transactionType === TransactionType.EXPENSE && categoryName && isPaid) {
    try {
      const { checkBudgetThresholds } = await import('../notifications/budget-notifications.service.js');
      await checkBudgetThresholds(
        householdId,
        categoryName,
        date,
        amount,
        transactionType
      );
    } catch (error) {
      // Log error but don't fail transaction creation if notification fails
      console.error('[createTransaction] Error checking budget thresholds:', error);
    }
  }

  return convertedResult;
}

/**
 * Get transaction by ID
 */
export async function getTransaction(transactionId: string) {
  const transaction = await prisma.transaction.findUnique({
    where: { id: transactionId },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
      fromAccount: {
        select: { id: true, name: true, type: true },
      },
      toAccount: {
        select: { id: true, name: true, type: true },
      },
      relatedAccount: {
        select: { id: true, name: true, type: true },
      },
      splits: {
        include: {
          user: {
            select: { id: true, email: true, displayName: true },
          },
        },
      },
    },
  });

  if (!transaction) {
    throw new NotFoundError('Transaction');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...transaction,
    amount: transaction.amount.toNumber(),
    splits: transaction.splits?.map(split => ({
      ...split,
      amount: split.amount.toNumber(),
    })) || [],
  };
}

/**
 * Get transaction with household verification
 */
export async function getTransactionWithHousehold(
  transactionId: string,
  householdId: string
) {
  const transaction = await prisma.transaction.findFirst({
    where: {
      id: transactionId,
      householdId,
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
      fromAccount: {
        select: { id: true, name: true, type: true },
      },
      toAccount: {
        select: { id: true, name: true, type: true },
      },
      relatedAccount: {
        select: { id: true, name: true, type: true },
      },
      splits: {
        include: {
          user: {
            select: { id: true, email: true, displayName: true },
          },
        },
      },
    },
  });

  if (!transaction) {
    throw new NotFoundError('Transaction');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...transaction,
    amount: transaction.amount.toNumber(),
    splits: transaction.splits?.map(split => ({
      ...split,
      amount: split.amount.toNumber(),
    })) || [],
  };
}

/**
 * List transactions with filters and cursor-based pagination
 */
export async function listTransactions(query: ListTransactionsQuery) {
  const {
    householdId,
    accountId,
    categoryName,
    type,
    month,
    startDate,
    endDate,
    search,
    cursor,
    limit,
  } = query;

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

  // Build where clause
  const where: Prisma.TransactionWhereInput = {
    householdId,
    ...(accountId && { accountId }),
    ...(categoryName && { categoryName }),
    // Support TransactionType filter (TRANSFER, ALLOCATION, INCOME, EXPENSE)
    ...(type && {
      type: type as TransactionType,
    }),
    ...(dateFilter && { date: dateFilter }),
    ...(search && {
      OR: [
        { description: { contains: search, mode: 'insensitive' } },
        { notes: { contains: search, mode: 'insensitive' } },
        // Busca por valor numérico
        ...(search.match(/[\d.,]/) ? (() => {
          // Remove caracteres não numéricos exceto ponto e vírgula
          const numericString = search.replace(/[^\d.,]/g, '');
          if (numericString) {
            // Normaliza vírgula para ponto
            const normalized = numericString.replace(',', '.');
            const parsed = parseFloat(normalized);
            if (!isNaN(parsed) && isFinite(parsed)) {
              const searchAmount = new Prisma.Decimal(parsed);
              // Busca tanto valores positivos quanto negativos (valor absoluto)
              return [
                { amount: { equals: searchAmount } },
                { amount: { equals: new Prisma.Decimal(-parsed) } },
              ];
            }
          }
          return [];
        })() : []),
      ],
    }),
  };

  // Get transactions with pagination
  const paginationArgs = buildPaginationArgs({ cursor, limit });
  const transactions = await prisma.transaction.findMany({
    where,
    ...paginationArgs,
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
      splits: {
        include: {
          user: {
            select: { id: true, email: true, displayName: true },
          },
        },
      },
      fromAccount: {
        select: { id: true, name: true, type: true },
      },
      toAccount: {
        select: { id: true, name: true, type: true },
      },
      relatedAccount: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });

  // Get total count for the filters
  const total = await prisma.transaction.count({ where });

  // Convert Prisma.Decimal to number for JSON serialization
  const convertedTransactions = transactions.map(t => ({
    ...t,
    amount: t.amount.toNumber(),
    splits: t.splits?.map(split => ({
      ...split,
      amount: split.amount.toNumber(),
    })) || [],
  }));

  return createPaginatedResponse(convertedTransactions, limit, total);
}

/** Server-side extras of an update (not part of the HTTP schema): the importer re-points the source of a row. */
export type InternalUpdateTransactionInput = UpdateTransactionInput & { sourceRef?: string | null };

/** Hooks of updateTransaction, both run inside the same database transaction as the update. */
export interface UpdateTransactionOptions {
  /**
   * Runs right after the row was locked and read again, before any balance is touched; throwing aborts the whole
   * update with nothing written (callers record external refs here). It runs on every attempt of the retry (stale
   * read, deadlock), each time inside a fresh database transaction, so it must be safe to run more than once.
   */
  beforeWrite?: (tx: Prisma.TransactionClient) => Promise<void>;
  /** Runs after the row was written, still inside the transaction (also once per attempt). */
  inTransaction?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/** The row changed between the read and the lock in a way this update does not depend on: read again and retry. */
class StaleRowError extends Error {
  constructor() {
    super('The transaction changed meanwhile');
  }
}

const MAX_UPDATE_ATTEMPTS = 3;

/**
 * Postgres deadlock detected: two transactions locked rows (or accounts) in opposite orders; one was rolled back.
 * With the pg driver adapter it arrives as a DriverAdapterError whose `message` is "deadlock detected" and whose
 * code is in `cause.originalCode` (SQLSTATE 40P01); other layers put the code in `code` or `meta.code`.
 */
export function isDeadlock(error: unknown): boolean {
  const e = (error ?? {}) as {
    code?: unknown;
    originalCode?: unknown;
    meta?: { code?: unknown };
    cause?: { code?: unknown; originalCode?: unknown; message?: unknown };
    message?: unknown;
  };
  const codes = [e.code, e.originalCode, e.meta?.code, e.cause?.code, e.cause?.originalCode];
  const text = [e.message, e.cause?.message].filter((m): m is string => typeof m === 'string');
  return codes.includes('40P01') || text.some((m) => m.includes('40P01') || m.includes('deadlock detected'));
}

/**
 * Update a transaction and adjust balances. The row is locked (SELECT ... FOR UPDATE) inside the database transaction
 * and read again: when it still is what this call read, the update goes on; when someone changed it, the update
 * answers 409 only if what changed is what this call intends to change or depends on to move money (the account, the
 * amount or the type when the request sets them); any other concurrent change (a description, a note, a paid flag
 * already set) just makes the call read the row again and apply its update on top, so independent PATCHes all apply.
 * A deadlock between two moves that cross (A to B and B to A) rolls one back: it is retried like a stale read.
 */
export async function updateTransaction(
  transactionId: string,
  householdId: string,
  input: InternalUpdateTransactionInput,
  options: UpdateTransactionOptions = {}
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await updateTransactionOnce(transactionId, householdId, input, options);
    } catch (error) {
      if (!(error instanceof StaleRowError) && !isDeadlock(error)) throw error;
      if (attempt >= MAX_UPDATE_ATTEMPTS) {
        throw new ConflictError('The transaction is being changed by someone else; try again.');
      }
    }
  }
}

async function updateTransactionOnce(
  transactionId: string,
  householdId: string,
  input: InternalUpdateTransactionInput,
  options: UpdateTransactionOptions
) {
  const existingTransaction = await prisma.transaction.findFirst({
    where: { id: transactionId, householdId },
  });

  if (!existingTransaction) {
    throw new NotFoundError('Transaction');
  }

  // Validate new account if provided (and different from current)
  if (input.accountId && input.accountId !== existingTransaction.accountId) {
    const account = await prisma.account.findFirst({
      where: { id: input.accountId, householdId, isActive: true },
    });
    if (!account) {
      throw new NotFoundError('Account');
    }
  }
  // Note: If accountId is null (account was deleted), we allow it - transaction remains but won't affect any account balance

  // CategoryName is validated by Zod schema, no need to check in database

  // Validate type change: cannot change between TRANSFER/ALLOCATION and INCOME/EXPENSE
  if (input.type) {
    const existingType = existingTransaction.type;
    const isExistingInternal = existingType === TransactionType.TRANSFER || existingType === TransactionType.ALLOCATION;
    const isNewInternal = input.type === TransactionType.TRANSFER || input.type === TransactionType.ALLOCATION;
    
    if (isExistingInternal !== isNewInternal) {
      throw new BadRequestError('Cannot change transaction type between internal operations (TRANSFER/ALLOCATION) and income/expense (INCOME/EXPENSE)');
    }
  }

  // Calculate balance adjustments
  const oldAmount = existingTransaction.amount.toNumber();
  const newAmount = input.amount ?? oldAmount;
  const oldAccountId = existingTransaction.accountId;
  const newAccountId = input.accountId ?? oldAccountId;
  const oldPaid = existingTransaction.paid !== false; // undefined or true = paid
  const newPaid = input.paid !== undefined ? input.paid : oldPaid;
  const accountChanged = newAccountId !== oldAccountId;
  const amountChanged = newAmount !== oldAmount;
  const paidChanged = oldPaid !== newPaid;
  const oldCategoryName = input.categoryName ?? existingTransaction.categoryName ?? CategoryName.OTHER_EXPENSES;
  const newCategoryName = input.categoryName ?? oldCategoryName;
  const oldType = existingTransaction.type;
  const newType = input.type ?? oldType;
  const typeChanged = newType !== oldType;
  const oldIsIncome = oldType === TransactionType.INCOME;
  const newIsIncome = newType === TransactionType.INCOME;

  // Get account types for balance calculation
  let oldAccountType: string | null = null;
  let newAccountType: string | null = null;
  if (oldAccountId) {
    const oldAccount = await prisma.account.findUnique({ where: { id: oldAccountId }, select: { type: true } });
    oldAccountType = oldAccount?.type || null;
  }
  if (newAccountId && newAccountId !== oldAccountId) {
    const newAccount = await prisma.account.findUnique({ where: { id: newAccountId }, select: { type: true } });
    newAccountType = newAccount?.type || null;
  } else if (newAccountId) {
    newAccountType = oldAccountType;
  }

  // Update transaction and adjust balances
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Lock the row and read it again: what the balance math below uses must be what is stored now.
    await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${transactionId}::uuid FOR UPDATE`;
    const fresh = await tx.transaction.findFirst({ where: { id: transactionId, householdId } });
    if (!fresh) throw new NotFoundError('Transaction');
    const unchanged =
      fresh.accountId === existingTransaction.accountId &&
      fresh.type === existingTransaction.type &&
      fresh.paid === existingTransaction.paid &&
      fresh.categoryName === existingTransaction.categoryName &&
      fresh.amount.equals(existingTransaction.amount);
    if (!unchanged) {
      const intentChanged =
        (input.accountId !== undefined && fresh.accountId !== existingTransaction.accountId) ||
        (input.amount !== undefined && !fresh.amount.equals(existingTransaction.amount)) ||
        (input.type !== undefined && fresh.type !== existingTransaction.type);
      if (intentChanged) {
        throw new ConflictError('The transaction was changed by someone else; reload and try again.');
      }
      throw new StaleRowError();
    }
    // Two moves that cross (A to B and B to A) would lock the two accounts in opposite orders: always take them by id.
    if (accountChanged && oldAccountId && newAccountId) {
      await tx.$queryRaw`SELECT id FROM accounts WHERE id IN (${Prisma.join([oldAccountId, newAccountId].sort())}) ORDER BY id FOR UPDATE`;
    }
    await options.beforeWrite?.(tx);

    // Case 1: Type changed (INCOME <-> EXPENSE) - need to reverse old balance and apply new balance
    // This handles type change alone or with other changes
    if (typeChanged && oldAccountId && oldAccountType && oldCategoryName) {
      // Reverse old balance if it was paid
      if (oldPaid) {
        const reverseChange = -calculateBalanceChange(oldAmount, oldIsIncome, oldAccountType);
        await updateBalanceForNormalTransaction(tx, oldAccountId, reverseChange);
      }
      
      // Apply new balance if it should be paid
      if (newPaid) {
        // Use new account if changed, otherwise use old account
        const finalAccountId = accountChanged ? (newAccountId || oldAccountId) : oldAccountId;
        const finalAccountType = accountChanged ? (newAccountType || oldAccountType) : oldAccountType;
        const finalAmount = amountChanged ? newAmount : oldAmount;
        if (finalAccountId && finalAccountType) {
          const balanceChange = calculateBalanceChange(finalAmount, newIsIncome, finalAccountType);
          await updateBalanceForNormalTransaction(tx, finalAccountId, balanceChange);
        }
      }
    }
    // Case 2: Only paid status changed (no amount, account, or type change)
    else if (paidChanged && !amountChanged && !accountChanged && !typeChanged && oldAccountId && oldAccountType && oldCategoryName) {
      if (oldPaid && !newPaid) {
        const reverseChange = -calculateBalanceChange(oldAmount, oldIsIncome, oldAccountType);
        await updateBalanceForNormalTransaction(tx, oldAccountId, reverseChange);
      } else if (!oldPaid && newPaid) {
        const balanceChange = calculateBalanceChange(oldAmount, oldIsIncome, oldAccountType);
        await updateBalanceForNormalTransaction(tx, oldAccountId, balanceChange);
      }
    }
    // Case 3: Account changed (no type change)
    else if (accountChanged && !typeChanged) {
      if (oldPaid && oldAccountId && oldAccountType && oldCategoryName) {
        const reverseChange = -calculateBalanceChange(oldAmount, oldIsIncome, oldAccountType);
        await updateBalanceForNormalTransaction(tx, oldAccountId, reverseChange);
      }
      if (newPaid && newAccountId && newAccountType && newCategoryName) {
        const balanceChange = calculateBalanceChange(newAmount, oldIsIncome, newAccountType);
        await updateBalanceForNormalTransaction(tx, newAccountId, balanceChange);
      }
    }
    // Case 4: Amount changed (no account or type change)
    else if (amountChanged && !accountChanged && !typeChanged && oldAccountId && oldAccountType && oldCategoryName) {
      if (oldPaid && newPaid) {
        const oldBalanceChange = calculateBalanceChange(oldAmount, oldIsIncome, oldAccountType);
        const newBalanceChange = calculateBalanceChange(newAmount, oldIsIncome, oldAccountType);
        const difference = newBalanceChange - oldBalanceChange;
        if (difference !== 0) {
          await updateBalanceForNormalTransaction(tx, oldAccountId, difference);
        }
      } else if (oldPaid && !newPaid) {
        const reverseChange = -calculateBalanceChange(oldAmount, oldIsIncome, oldAccountType);
        await updateBalanceForNormalTransaction(tx, oldAccountId, reverseChange);
      } else if (!oldPaid && newPaid) {
        const balanceChange = calculateBalanceChange(newAmount, oldIsIncome, oldAccountType);
        await updateBalanceForNormalTransaction(tx, oldAccountId, balanceChange);
      }
    }

    // Update transaction
    const transaction = await tx.transaction.update({
      where: { id: transactionId },
      data: {
        ...(input.accountId && { accountId: input.accountId }),
        ...(input.categoryName && { categoryName: input.categoryName }),
        ...(input.type && { type: input.type }), // Update type if provided
        ...(input.amount !== undefined && { amount: new Prisma.Decimal(input.amount) }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.date && { date: input.date }),
        ...(input.notes !== undefined && { notes: input.notes }),
        ...(input.paid !== undefined && { paid: input.paid }),
        ...(input.recurringTransactionId !== undefined && { recurringTransactionId: input.recurringTransactionId }),
        ...(input.installmentId !== undefined && { installmentId: input.installmentId }),
        ...(input.installmentNumber !== undefined && { installmentNumber: input.installmentNumber }),
        ...(input.totalInstallments !== undefined && { totalInstallments: input.totalInstallments }),
        ...(input.attachmentUrl !== undefined && { attachmentUrl: input.attachmentUrl }),
        ...(input.sourceRef !== undefined && { sourceRef: input.sourceRef }),
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    if (options.inTransaction) await options.inTransaction(tx);

    // Recalculate credit card limit if transaction is on a credit card
    if (transaction.account?.type === AccountType.CREDIT) {
      await recalculateCreditCardLimit(tx, transaction.account.id);
    }

    return transaction;
  });

  // If transaction was marked as paid and it's from a recurring transaction on a credit card,
  // automatically process the recurring transaction for the next few months
  if (paidChanged && !oldPaid && newPaid && result.recurringTransactionId && result.account?.type === AccountType.CREDIT) {
    try {
      const recurring = await prisma.recurringTransaction.findUnique({
        where: { id: result.recurringTransactionId },
        include: { account: true },
      });

      if (recurring && recurring.isActive) {
        // Process recurring transactions for the next 6 months (or until endDate if sooner)
        const transactionDate = new Date(result.date);
        transactionDate.setHours(0, 0, 0, 0);
        const maxIterations = 6; // Process up to 6 future occurrences
        let iterationsProcessed = 0;
        
        // Start from the next occurrence after the current transaction date
        let currentDate = new Date(transactionDate);
        
        // Calculate next date based on frequency
        switch (recurring.frequency) {
          case 'DAILY':
            currentDate.setDate(currentDate.getDate() + 1);
            break;
          case 'WEEKLY':
            currentDate.setDate(currentDate.getDate() + 7);
            break;
          case 'BIWEEKLY':
            currentDate.setDate(currentDate.getDate() + 14);
            break;
          case 'MONTHLY':
            currentDate.setMonth(currentDate.getMonth() + 1);
            break;
          case 'YEARLY':
            currentDate.setFullYear(currentDate.getFullYear() + 1);
            break;
        }
        currentDate.setHours(0, 0, 0, 0);

        while (iterationsProcessed < maxIterations) {
          // Check if we've passed the end date
          if (recurring.endDate) {
            const endDate = new Date(recurring.endDate);
            endDate.setHours(0, 0, 0, 0);
            if (currentDate > endDate) {
              break;
            }
          }

          // Check if transaction for this date already exists
          const existingTransaction = await prisma.transaction.findFirst({
            where: {
              householdId,
              recurringTransactionId: recurring.id,
              date: currentDate,
            },
          });

          // Only process if transaction doesn't exist yet
          if (!existingTransaction) {
            try {
              await executeRecurringTransaction(recurring.id, householdId, { date: currentDate });
              iterationsProcessed++;
            } catch (error) {
              // If error occurs, stop processing (might be duplicate or other issue)
              break;
            }
          }

          // Calculate next date based on frequency
          switch (recurring.frequency) {
            case 'DAILY':
              currentDate.setDate(currentDate.getDate() + 1);
              break;
            case 'WEEKLY':
              currentDate.setDate(currentDate.getDate() + 7);
              break;
            case 'BIWEEKLY':
              currentDate.setDate(currentDate.getDate() + 14);
              break;
            case 'MONTHLY':
              currentDate.setMonth(currentDate.getMonth() + 1);
              break;
            case 'YEARLY':
              currentDate.setFullYear(currentDate.getFullYear() + 1);
              break;
          }
          currentDate.setHours(0, 0, 0, 0);
        }
      }
    } catch (error) {
      // Don't fail the transaction update if recurring processing fails
      // Log error but continue
      console.error('Error processing recurring transactions for credit card:', error);
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  const convertedResult = {
    ...result,
    amount: result.amount.toNumber(),
  };

  // Check budget thresholds and create notifications if needed (async, don't block)
  // Only check for expense transactions with a category that are paid
  const finalCategoryName = newCategoryName;
  const finalTransactionType = getCategoriesByType(CategoryType.INCOME).includes(finalCategoryName as any)
    ? TransactionType.INCOME
    : TransactionType.EXPENSE;
  
  if (finalTransactionType === TransactionType.EXPENSE && finalCategoryName && newPaid) {
    try {
      const { checkBudgetThresholds } = await import('../notifications/budget-notifications.service.js');
      const transactionDate = input.date ? new Date(input.date) : existingTransaction.date;
      await checkBudgetThresholds(
        householdId,
        finalCategoryName,
        transactionDate,
        newAmount,
        finalTransactionType
      );
    } catch (error) {
      // Log error but don't fail transaction update if notification fails
      console.error('[updateTransaction] Error checking budget thresholds:', error);
    }
  }

  return convertedResult;
}

export interface DeleteTransactionOptions {
  /**
   * Runs inside the database transaction of every delete except a paid transfer, a paid allocation and a paid split
   * expense (which have their own paths): so for a plain income/expense, paid or not, for an unpaid transfer,
   * allocation or split expense, and for a paid row with no account or category. It runs right after the row was
   * locked and read again and before anything is written; throwing aborts the delete with nothing written. For callers
   * that must recheck something atomically with the delete. It runs on every attempt of the retry.
   */
  guard?: (tx: Prisma.TransactionClient) => Promise<void>;
}

/** The fields the balance math of a delete depends on: if any changed between the read and the lock, read again. */
type DeleteSnapshot = {
  accountId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  relatedEntityId: string | null;
  type: string | null;
  paid: boolean | null;
  isSplit: boolean | null;
  categoryName: string | null;
  amount: Prisma.Decimal;
};

/**
 * First thing in every delete transaction, in the same order as updateTransaction (row first, then accounts), so
 * the two never wait for each other in opposite orders: lock the row, read it again, and give up (retry) if what the
 * balance math used has changed. @throws NotFoundError when the row is gone.
 */
async function lockRowForDelete(tx: Prisma.TransactionClient, transactionId: string, householdId: string, read: DeleteSnapshot) {
  await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${transactionId}::uuid FOR UPDATE`;
  const fresh = await tx.transaction.findFirst({ where: { id: transactionId, householdId } });
  if (!fresh) throw new NotFoundError('Transaction');
  const same =
    fresh.accountId === read.accountId &&
    fresh.fromAccountId === read.fromAccountId &&
    fresh.toAccountId === read.toAccountId &&
    fresh.relatedEntityId === read.relatedEntityId &&
    fresh.type === read.type &&
    fresh.paid === read.paid &&
    fresh.isSplit === read.isSplit &&
    fresh.categoryName === read.categoryName &&
    fresh.amount.equals(read.amount);
  if (!same) throw new StaleRowError();
}

/** Several accounts are always locked by id, as in updateTransaction. */
async function lockAccountsById(tx: Prisma.TransactionClient, ids: Array<string | null | undefined>) {
  const unique = [...new Set(ids.filter((id): id is string => !!id))].sort();
  if (unique.length > 0) await tx.$queryRaw`SELECT id FROM accounts WHERE id IN (${Prisma.join(unique)}) ORDER BY id FOR UPDATE`;
}

/**
 * Delete transaction and revert account balance
 */
export async function deleteTransaction(transactionId: string, householdId: string, options: DeleteTransactionOptions = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await deleteTransactionOnce(transactionId, householdId, options);
    } catch (error) {
      if (!(error instanceof StaleRowError) && !isDeadlock(error)) throw error;
      if (attempt >= MAX_UPDATE_ATTEMPTS) {
        throw new ConflictError('The transaction is being changed by someone else; try again.');
      }
    }
  }
}

async function deleteTransactionOnce(transactionId: string, householdId: string, options: DeleteTransactionOptions) {
  const transaction = await prisma.transaction.findFirst({
    where: { id: transactionId, householdId },
    include: {
      account: {
        select: { type: true },
      },
      splits: {
        include: {
          user: {
            select: { id: true },
          },
        },
      },
    },
  });

  if (!transaction) {
    throw new NotFoundError('Transaction');
  }

  // Delete transaction and revert balance
  // For TRANSFER and ALLOCATION, use BalanceService to revert
  // For INCOME/EXPENSE, use calculateBalanceChange
  const wasPaid = transaction.paid !== false; // undefined or true = paid
  const transactionType = transaction.type || TransactionType.INCOME; // Default to INCOME for legacy transactions
  const isSplit = transaction.isSplit === true && transaction.splits && transaction.splits.length > 0;
  
  if (wasPaid) {
    if (transactionType === TransactionType.TRANSFER && transaction.fromAccountId && transaction.toAccountId) {
      // Reverse transfer: move balance back
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockRowForDelete(tx, transactionId, householdId, transaction);
        await lockAccountsById(tx, [transaction.fromAccountId, transaction.toAccountId]);
        await applyTransfer(tx, transaction.toAccountId!, transaction.fromAccountId!, transaction.amount.toNumber());
        await tx.transaction.delete({ where: { id: transactionId } });
      });
    } else if (transactionType === TransactionType.ALLOCATION && transaction.accountId && transaction.relatedEntityId) {
      // Reverse allocation: move from allocated back to available
      const amount = Math.abs(transaction.amount.toNumber()); // Allocation amount is positive
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockRowForDelete(tx, transactionId, householdId, transaction);
        await lockAccountsById(tx, [transaction.accountId, transaction.relatedEntityId]);
        await applyDeallocation(tx, transaction.accountId!, transaction.relatedEntityId!, amount);
        await recalculateCreditCardLimit(tx, transaction.relatedEntityId!);
        await tx.transaction.delete({ where: { id: transactionId } });
      });
    } else if (isSplit && transaction.categoryName) {
      // Split transaction: revert balances for each participant's personal account
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockRowForDelete(tx, transactionId, householdId, transaction);
        // Find individual split transactions in personal households
        // They have notes containing "Split da transação {transactionId}"
        const splitNotePattern = `Split da transação ${transactionId}`;
        const splitTransactions = await tx.transaction.findMany({
          where: {
            notes: {
              contains: splitNotePattern,
            },
          },
          include: {
            account: {
              select: { type: true },
            },
          },
        });

        await lockAccountsById(tx, splitTransactions.map((t) => t.accountId));

        // Revert balance for each participant's account
        for (const splitTransaction of splitTransactions) {
          if (splitTransaction.accountId && splitTransaction.account && splitTransaction.categoryName) {
            const isInc = splitTransaction.type === TransactionType.INCOME;
            const reverseChange = -calculateBalanceChange(
              splitTransaction.amount.toNumber(),
              isInc,
              splitTransaction.account.type
            );
            
            // Revert the balance using the helper function
            await updateBalanceForNormalTransaction(tx, splitTransaction.accountId, reverseChange);
            
            // Recalculate credit card limit if it's a credit card
            if (splitTransaction.account.type === AccountType.CREDIT) {
              await recalculateCreditCardLimit(tx, splitTransaction.accountId);
            }
            
            // Delete the individual split transaction
            await tx.transaction.delete({ where: { id: splitTransaction.id } });
          }
        }

        // Delete TransactionSplit records
        await tx.transactionSplit.deleteMany({
          where: { transactionId },
        });

        // Delete the main transaction
        await tx.transaction.delete({ where: { id: transactionId } });
      });
    } else if (transaction.accountId && transaction.account && transaction.categoryName) {
      // Regular INCOME/EXPENSE transaction
      const isInc = transaction.type === TransactionType.INCOME;
      const reverseChange = -calculateBalanceChange(
        transaction.amount.toNumber(),
        isInc,
        transaction.account.type
      );
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockRowForDelete(tx, transactionId, householdId, transaction);
        await options.guard?.(tx);
        if (transaction.accountId) {
          await updateBalanceForNormalTransaction(tx, transaction.accountId, reverseChange);
          if (transaction.account && transaction.account.type === AccountType.CREDIT) {
            await recalculateCreditCardLimit(tx, transaction.accountId);
          }
        }
        await tx.transaction.delete({ where: { id: transactionId } });
      });
    } else {
      // Just delete if no account or category
      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        await lockRowForDelete(tx, transactionId, householdId, transaction);
        await options.guard?.(tx);
        // Delete TransactionSplit records if they exist
        if (isSplit) {
          await tx.transactionSplit.deleteMany({
            where: { transactionId },
          });
        }
        await tx.transaction.delete({ where: { id: transactionId } });
      });
    }
  } else {
    // Just delete if it wasn't paid (no balance to revert)
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      await lockRowForDelete(tx, transactionId, householdId, transaction);
      await options.guard?.(tx);
      // Delete TransactionSplit records if they exist
      if (isSplit) {
        await tx.transactionSplit.deleteMany({
          where: { transactionId },
        });
      }
      await tx.transaction.delete({ where: { id: transactionId } });
    });
  }
}

/**
 * Batch create transactions
 */
export async function batchCreateTransactions(input: BatchCreateTransactionsInput) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const { transactions: transactionsData } = input;

  // Verify all accounts
  const accountIds = [...new Set(transactionsData.map((t: { accountId: string }) => t.accountId))];

  const accounts = await prisma.account.findMany({
    where: { id: { in: accountIds }, householdId, isActive: true },
  });

  if (accounts.length !== accountIds.length) {
    throw new BadRequestError('One or more accounts not found');
  }

  // Resolve type (and isIncome) for each row: from custom categories or system enum
  const customIds = transactionsData
    .map((t: { categoryName: string }) => t.categoryName)
    .filter((cn: string) => isCustomCategoryName(cn))
    .map((cn: string) => toCustomCategoryId(cn)!);
  const customCats = customIds.length
    ? await prisma.category.findMany({ where: { id: { in: customIds }, householdId }, select: { id: true, type: true } })
    : [];
  const customTypeMap = new Map(customCats.map((c) => [toCustomCategoryName(c.id), c.type]));

  function isIncomeForCategory(categoryName: string): boolean {
    const ct = customTypeMap.get(categoryName);
    if (ct) return ct === CategoryType.INCOME;
    return getCategoriesByType(CategoryType.INCOME).includes(categoryName as any);
  }

  // Calculate balance changes per account (only for paid transactions)
  const accountMap = new Map<string, string>();
  accounts.forEach((acc: { id: string; type: string }) => accountMap.set(acc.id, acc.type));

  const balanceChanges = new Map<string, number>();
  for (const t of transactionsData) {
    const isPaid = t.paid !== undefined ? t.paid : true;
    if (isPaid) {
      const accountType = accountMap.get(t.accountId);
      if (accountType) {
        const isInc = isIncomeForCategory(t.categoryName);
        const change = calculateBalanceChange(t.amount, isInc, accountType);
        const current = balanceChanges.get(t.accountId) || 0;
        balanceChanges.set(t.accountId, current + change);
      }
    }
  }

  // Execute batch creation
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const created = await tx.transaction.createMany({
      data: transactionsData.map((t: { accountId: string; categoryName: string; amount: number; description?: string; date: Date; notes?: string; paid: boolean; recurringTransactionId?: string; installmentId?: string; installmentNumber?: number; totalInstallments?: number }) => {
        const isInc = isIncomeForCategory(t.categoryName);
        return {
          householdId,
          type: isInc ? TransactionType.INCOME : TransactionType.EXPENSE,
          accountId: t.accountId,
          categoryName: t.categoryName,
          amount: new Prisma.Decimal(t.amount),
          description: t.description,
          date: t.date,
          notes: t.notes,
          paid: t.paid !== undefined ? t.paid : true,
          ...(t.recurringTransactionId && { recurringTransactionId: t.recurringTransactionId }),
          ...(t.installmentId && { installmentId: t.installmentId }),
          ...(t.installmentNumber && { installmentNumber: t.installmentNumber }),
          ...(t.totalInstallments && { totalInstallments: t.totalInstallments }),
        };
      }),
    });

    // Update all account balances (only for paid transactions)
    // Use centralized balance update function to ensure consistency
    if (balanceChanges.size > 0) {
      // Get account types for credit card limit recalculation
      const accountIds = Array.from(balanceChanges.keys());
      const accounts = await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, type: true },
      });
      const accountTypeMap = new Map(accounts.map(a => [a.id, a.type]));
      
      await Promise.all(
        Array.from(balanceChanges.entries()).map(async ([accountId, change]) => {
          await updateBalanceForNormalTransaction(tx, accountId, change);
          
          // Recalculate credit card limit if it's a credit card
          const accountType = accountTypeMap.get(accountId);
          if (accountType === AccountType.CREDIT) {
            await recalculateCreditCardLimit(tx, accountId);
          }
        })
      );
    }

    return { count: created.count };
  });

  return result;
}

/**
 * Batch delete transactions
 */
export async function batchDeleteTransactions(input: BatchDeleteTransactionsInput) {
  const { householdId, transactionIds } = input;

  // Get all transactions to calculate balance reversals
  const transactions = await prisma.transaction.findMany({
    where: {
      id: { in: transactionIds },
      householdId,
    },
    include: {
      account: {
        select: { type: true },
      },
    },
  });

  if (transactions.length === 0) {
    throw new NotFoundError('Transactions');
  }

  // Calculate balance reversals per account (only for paid transactions)
  const balanceReversals = new Map<string, number>();
  for (const t of transactions) {
    const wasPaid = t.paid !== false; // undefined or true = paid
      if (wasPaid && t.accountId && t.account && t.categoryName) {
      const isInc = t.type === TransactionType.INCOME;
      const reverseChange = -calculateBalanceChange(
        t.amount.toNumber(),
        isInc,
        t.account.type
      );
      const current = balanceReversals.get(t.accountId) || 0;
      balanceReversals.set(t.accountId, current + reverseChange);
    }
  }

  // Execute batch deletion
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Delete all transactions
    const deleted = await tx.transaction.deleteMany({
      where: {
        id: { in: transactions.map((t: { id: string }) => t.id) },
      },
    });

    // Revert all account balances (only for paid transactions)
    // Use centralized balance update function to ensure consistency
    if (balanceReversals.size > 0) {
      // Get account types for credit card limit recalculation
      const accountIds = Array.from(balanceReversals.keys());
      const accounts = await tx.account.findMany({
        where: { id: { in: accountIds } },
        select: { id: true, type: true },
      });
      const accountTypeMap = new Map(accounts.map(a => [a.id, a.type]));
      
      await Promise.all(
        Array.from(balanceReversals.entries()).map(async ([accountId, change]) => {
          await updateBalanceForNormalTransaction(tx, accountId, change);
          
          // Recalculate credit card limit if it's a credit card
          const accountType = accountTypeMap.get(accountId);
          if (accountType === AccountType.CREDIT) {
            await recalculateCreditCardLimit(tx, accountId);
          }
        })
      );
    }

    return { count: deleted.count };
  });

  return result;
}

/**
 * Get transaction summary (income, expenses, balance) for a period
 */
export async function getTransactionSummary(query: TransactionSummaryQuery) {
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

  // Get transactions with account information to filter credit cards
  const transactions = await prisma.transaction.findMany({
    where: {
      householdId,
      ...(dateFilter && { date: dateFilter }),
    },
    include: {
      account: {
        select: { type: true },
      },
    },
  });

  const incomeCategories = getCategoriesByType(CategoryType.INCOME);
  const expenseCategories = getCategoriesByType(CategoryType.EXPENSE);

  let income = 0;
  let expenses = 0;

  for (const t of transactions) {
    // Exclude transfers and allocations from income/expense calculations
    if (t.type === TransactionType.TRANSFER || t.type === TransactionType.ALLOCATION) {
      continue;
    }
    
    // Exclude credit card transactions from P&L calculations
    // Credit card expenses don't represent actual cash outflow until the invoice is paid
    // The real expense is recorded when paying the invoice via a bank account transaction
    if (t.account && t.account.type === AccountType.CREDIT) {
      continue;
    }
    
    const amount = t.amount.toNumber();
    // Check by transaction type first (new system)
    if (t.type === TransactionType.INCOME) {
      income += amount;
    } else if (t.type === TransactionType.EXPENSE) {
      expenses += Math.abs(amount);
    } else if (t.categoryName) {
      // Fallback to category-based detection (legacy)
      if (incomeCategories.includes(t.categoryName as any)) {
        income += amount;
      } else if (expenseCategories.includes(t.categoryName as any)) {
        expenses += Math.abs(amount);
      }
    }
  }

  return {
    income,
    expenses,
    balance: income - expenses,
    transactionCount: transactions.length,
  };
}

/**
 * Get spending by category for a period
 */
export async function getSpendingByCategory(query: TransactionSummaryQuery) {
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

  const expenseSystem = getCategoriesByType(CategoryType.EXPENSE);
  const customExpense = await prisma.category.findMany({
    where: { householdId, type: CategoryType.EXPENSE },
    select: { id: true, color: true },
  });
  const expenseCategoryNames = [...expenseSystem, ...customExpense.map((c) => toCustomCategoryName(c.id))];
  const customColorMap = new Map(customExpense.map((c) => [toCustomCategoryName(c.id), c.color ?? '#64748B']));

  const result = await prisma.transaction.groupBy({
    by: ['categoryName'],
    where: {
      householdId,
      ...(dateFilter && { date: dateFilter }),
      categoryName: { in: expenseCategoryNames },
    },
    _sum: {
      amount: true,
    },
    _count: true,
    orderBy: {
      _sum: {
        amount: 'asc', // Most negative (highest spending) first
      },
    },
  });

  return result.map((r) => {
    if (!r.categoryName) return null;
    const color = isCustomCategoryName(r.categoryName)
      ? (customColorMap.get(r.categoryName) ?? '#64748B')
      : getCategoryColor(r.categoryName as any);
    return {
      categoryName: r.categoryName,
      categoryColor: color,
      total: Math.abs(r._sum?.amount?.toNumber() || 0),
      count: r._count,
    };
  }).filter((r): r is { categoryName: string; categoryColor: string; total: number; count: number } => r !== null);
}

/**
 * Get monthly recap with insights and statistics
 */
export async function getMonthlyRecap(query: { householdId: string; month?: string }) {
  const { householdId, month } = query;

  // Determine month to analyze (default to current month)
  let targetMonth: string;
  if (month) {
    targetMonth = month;
  } else {
    const now = new Date();
    targetMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  }

  const { start, end } = parseMonthFilter(targetMonth);
  const dateFilter = { gte: start, lte: end };

  // Calculate previous month for comparison
  const [year, monthNum] = targetMonth.split('-').map(Number);
  const prevMonthStart = new Date(year, monthNum - 2, 1);
  const prevMonthEnd = new Date(year, monthNum - 1, 0, 23, 59, 59, 999);
  const prevDateFilter = { gte: prevMonthStart, lte: prevMonthEnd };

  // Get all transactions for the month
  const transactions = await prisma.transaction.findMany({
    where: {
      householdId,
      date: dateFilter,
    },
    include: {
      account: {
        select: { type: true },
      },
    },
    orderBy: {
      date: 'desc',
    },
  });

  // Get previous month transactions for comparison
  const prevTransactions = await prisma.transaction.findMany({
    where: {
      householdId,
      date: prevDateFilter,
    },
    include: {
      account: {
        select: { type: true },
      },
    },
  });

  const incomeCategories = getCategoriesByType(CategoryType.INCOME);
  const expenseCategories = getCategoriesByType(CategoryType.EXPENSE);

  // Calculate current month stats
  let income = 0;
  let expenses = 0;
  const categoryTotals = new Map<string, { total: number; count: number }>();
  let largestExpense: { amount: number; description: string | null; categoryName: string | null; date: Date } | null = null;

  for (const t of transactions) {
    if (t.type === TransactionType.TRANSFER || t.type === TransactionType.ALLOCATION) {
      continue;
    }
    
    if (t.account && t.account.type === AccountType.CREDIT) {
      continue;
    }
    
    const amount = t.amount.toNumber();
    
    if (t.type === TransactionType.INCOME) {
      income += amount;
    } else if (t.type === TransactionType.EXPENSE) {
      const absAmount = Math.abs(amount);
      expenses += absAmount;
      
      // Track largest expense
      if (!largestExpense || absAmount > largestExpense.amount) {
        largestExpense = {
          amount: absAmount,
          description: t.description,
          categoryName: t.categoryName,
          date: t.date,
        };
      }
      
      // Track category totals
      if (t.categoryName) {
        const current = categoryTotals.get(t.categoryName) || { total: 0, count: 0 };
        categoryTotals.set(t.categoryName, {
          total: current.total + absAmount,
          count: current.count + 1,
        });
      }
    }
  }

  // Calculate previous month stats for comparison
  let prevIncome = 0;
  let prevExpenses = 0;
  for (const t of prevTransactions) {
    if (t.type === TransactionType.TRANSFER || t.type === TransactionType.ALLOCATION) {
      continue;
    }
    if (t.account && t.account.type === AccountType.CREDIT) {
      continue;
    }
    const amount = t.amount.toNumber();
    if (t.type === TransactionType.INCOME) {
      prevIncome += amount;
    } else if (t.type === TransactionType.EXPENSE) {
      prevExpenses += Math.abs(amount);
    }
  }

  // Get custom categories for color mapping
  const customExpense = await prisma.category.findMany({
    where: { householdId, type: CategoryType.EXPENSE },
    select: { id: true, name: true, color: true },
  });
  const customColorMap = new Map(customExpense.map((c) => [toCustomCategoryName(c.id), c.color ?? '#64748B']));
  const customNameMap = new Map(customExpense.map((c) => [toCustomCategoryName(c.id), c.name]));

  // Find top category
  let topCategory: { categoryName: string; categoryDisplayName: string; total: number; count: number; color: string } | null = null;
  for (const [categoryName, data] of categoryTotals.entries()) {
    if (!topCategory || data.total > topCategory.total) {
      const color = isCustomCategoryName(categoryName)
        ? (customColorMap.get(categoryName) ?? '#64748B')
        : getCategoryColor(categoryName as any);
      const displayName = isCustomCategoryName(categoryName)
        ? (customNameMap.get(categoryName) ?? categoryName)
        : (CATEGORY_NAME_DISPLAY[categoryName as CategoryName] || categoryName);
      
      topCategory = {
        categoryName,
        categoryDisplayName: displayName,
        total: data.total,
        count: data.count,
        color,
      };
    }
  }

  // Calculate insights
  const balance = income - expenses;
  const prevBalance = prevIncome - prevExpenses;
  const incomeChange = prevIncome > 0 ? ((income - prevIncome) / prevIncome) * 100 : 0;
  const expenseChange = prevExpenses > 0 ? ((expenses - prevExpenses) / prevExpenses) * 100 : 0;
  const balanceChange = prevBalance !== 0 ? ((balance - prevBalance) / Math.abs(prevBalance)) * 100 : 0;

  // Get category name for largest expense
  let largestExpenseCategoryName: string | null = null;
  if (largestExpense?.categoryName) {
    if (isCustomCategoryName(largestExpense.categoryName)) {
      largestExpenseCategoryName = customNameMap.get(largestExpense.categoryName) || largestExpense.categoryName;
    } else {
      largestExpenseCategoryName = CATEGORY_NAME_DISPLAY[largestExpense.categoryName as CategoryName] || largestExpense.categoryName;
    }
  }

  return {
    month: targetMonth,
    summary: {
      income,
      expenses,
      balance,
      transactionCount: transactions.length,
    },
    comparison: {
      incomeChange: Math.round(incomeChange * 100) / 100,
      expenseChange: Math.round(expenseChange * 100) / 100,
      balanceChange: Math.round(balanceChange * 100) / 100,
      prevIncome,
      prevExpenses,
      prevBalance,
    },
    topCategory: topCategory || null,
    largestExpense: largestExpense ? {
      amount: largestExpense.amount,
      description: largestExpense.description || 'Sem descrição',
      categoryName: largestExpenseCategoryName,
      date: largestExpense.date,
    } : null,
    categoryBreakdown: Array.from(categoryTotals.entries())
      .map(([categoryName, data]) => {
        const color = isCustomCategoryName(categoryName)
          ? (customColorMap.get(categoryName) ?? '#64748B')
          : getCategoryColor(categoryName as any);
        const displayName = isCustomCategoryName(categoryName)
          ? (customNameMap.get(categoryName) ?? categoryName)
          : (CATEGORY_NAME_DISPLAY[categoryName as CategoryName] || categoryName);
        
        return {
          categoryName,
          categoryDisplayName: displayName,
          total: data.total,
          count: data.count,
          color,
        };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, 5), // Top 5 categories
  };
}

/**
 * Get daily spending heatmap data for a month
 * Uses database aggregation for optimal performance
 */
export async function getSpendingHeatmap(householdId: string, month?: string) {
  // Default to current month if not provided
  const targetMonth = month || `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
  
  // Parse month (YYYY-MM) to start and end dates
  const [year, monthNum] = targetMonth.split('-').map(Number);
  const monthStart = new Date(year, monthNum - 1, 1);
  const monthEnd = new Date(year, monthNum, 0, 23, 59, 59, 999);

  // Get all credit card account IDs to exclude them
  const creditCardAccounts = await prisma.account.findMany({
    where: {
      householdId,
      type: AccountType.CREDIT,
      isActive: true,
    },
    select: { id: true },
  });
  const creditCardIds = creditCardAccounts.map(a => a.id);

  // Use raw SQL for efficient aggregation by day
  // This groups expenses by day of month and sums them
  const dailySpending = await prisma.$queryRaw<Array<{ day: number; amount: string }>>`
    SELECT 
      EXTRACT(DAY FROM date)::integer as day,
      SUM(ABS(amount))::text as amount
    FROM "transactions"
    WHERE "household_id" = ${householdId}::uuid
      AND date >= ${monthStart}
      AND date <= ${monthEnd}
      AND type = 'EXPENSE'
      AND (
        "account_id" IS NULL 
        OR "account_id" NOT IN (SELECT unnest(${creditCardIds}::uuid[]))
      )
    GROUP BY EXTRACT(DAY FROM date)
    ORDER BY day
  `;

  // Convert to the expected format and fill in missing days
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const spendingMap = new Map<number, number>();
  
  for (const row of dailySpending) {
    spendingMap.set(row.day, parseFloat(row.amount));
  }

  // Build complete array with all days of the month
  const data: Array<{ day: number; amount: number }> = [];
  let total = 0;
  
  for (let day = 1; day <= daysInMonth; day++) {
    const amount = spendingMap.get(day) || 0;
    data.push({ day, amount });
    total += amount;
  }

  return {
    month: targetMonth,
    data,
    total,
    daysInMonth,
  };
}

/**
 * Invoice window of a card month (month = 1..12) as UTC date-only bounds, to compare with @db.Date columns (stored as
 * UTC midnight). With a closing day the invoice runs from the closing day of the previous month to the day before the
 * closing day of this one, both ends inclusive (7 Jan to 6 Feb for closing day 7 and month 2024-02); without one it is
 * the calendar month (callers pass the effective closing day: the explicit one or due day - 7). Local-time bounds made
 * Prisma truncate both ends to the UTC day in time zones behind UTC, which counted the closing day in two invoices.
 */
export function creditCardInvoiceWindow(year: number, month: number, closingDay: number | null | undefined) {
  if (closingDay) {
    // A closing day past the end of a short month closes on that month's last day (30 in February is the 28th), so
    // every window starts where the previous one ended and the closing date never spills into the next month.
    const closeOn = (zeroBasedMonth: number) => Math.min(closingDay, new Date(Date.UTC(year, zeroBasedMonth + 1, 0)).getUTCDate());
    return {
      start: new Date(Date.UTC(year, month - 2, closeOn(month - 2))),
      end: new Date(Date.UTC(year, month - 1, closeOn(month - 1) - 1)),
      previousStart: new Date(Date.UTC(year, month - 3, closeOn(month - 3))),
    };
  }
  return {
    start: new Date(Date.UTC(year, month - 1, 1)),
    end: new Date(Date.UTC(year, month, 0)),
    previousStart: new Date(Date.UTC(year, month - 2, 1)),
  };
}

/** Today as a UTC date-only value, comparable with @db.Date columns (stored as UTC midnight). */
export function utcToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** Ordinal (year * 12 + zero-based month) of an invoice month, used to order payments by the invoice they pay. */
export function invoiceOrdinal(year: number, monthNum: number): number {
  return year * 12 + (monthNum - 1);
}

/**
 * Invoice ordinal of a payment tagged `invoice_pay:<cardId>:<YYYY>-<zero-based month>`; null when the transaction is
 * not a payment of this card or its tag cannot be read.
 */
export function parseInvoicePaymentOrdinal(attachmentUrl: string | null | undefined, accountId: string): number | null {
  const prefix = `invoice_pay:${accountId}:`;
  if (!attachmentUrl?.startsWith(prefix)) return null;
  const match = /^(\d{4})-(\d{1,2})$/.exec(attachmentUrl.slice(prefix.length));
  if (!match) return null;
  return Number(match[1]) * 12 + Number(match[2]);
}

/**
 * Payments of a card split by the invoice they pay (their tag), not by the window their date falls in: a payment is
 * dated on or after the closing day of its own invoice, so the date window never contains it. Payments dated after
 * `today` (scheduled / imported for an upcoming due date) are not paid yet and are left out.
 */
export async function loadInvoicePayments(
  client: Pick<Prisma.TransactionClient, 'transaction'>,
  householdId: string,
  accountId: string,
  invoice: { year: number; monthNum: number },
  today: Date
) {
  const rows = await client.transaction.findMany({
    where: {
      householdId,
      attachmentUrl: { startsWith: `invoice_pay:${accountId}:` },
      date: { lte: today },
    },
  });
  const current = invoiceOrdinal(invoice.year, invoice.monthNum);
  const previous: typeof rows = [];
  const currentRows: typeof rows = [];
  const later: typeof rows = [];
  for (const row of rows) {
    const ordinal = parseInvoicePaymentOrdinal(row.attachmentUrl, accountId);
    if (ordinal === null) continue;
    if (ordinal < current) previous.push(row);
    else if (ordinal === current) currentRows.push(row);
    else later.push(row);
  }
  const sum = (list: typeof rows) => list.reduce((total, t) => total + t.amount.toNumber(), 0);
  // laterTotal: payments made ahead for invoices after this one; they never reduce this invoice, but the card balance holds them.
  return { previousTotal: sum(previous), currentTotal: sum(currentRows), laterTotal: sum(later), currentRows };
}

/**
 * Calculate credit card invoice for a specific month.
 * `currentExpenses` is the card's net purchases in the invoice window, the figure comparable with the bank statement
 * total; `total` is the running debt (previous balance + currentExpenses - payments), not the invoice amount.
 */
export async function calculateCreditCardInvoice(
  accountId: string,
  month: string,
  householdId: string,
  pagination?: { limit?: number; cursor?: string },
  options?: { today?: Date }
) {
  // Verify account is a credit card
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isActive: true },
  });

  if (!account) {
    throw new NotFoundError('Account');
  }

  if (account.type !== AccountType.CREDIT) {
    throw new BadRequestError('Account is not a credit card');
  }

  // Parse month (YYYY-MM) to start and end dates
  const [year, monthNum] = month.split('-').map(Number);
  
  const window = creditCardInvoiceWindow(year, monthNum, effectiveClosingDay(account));
  const invoiceStart = window.start;
  const invoiceEnd = window.end;
  const previousPeriodStart = window.previousStart;

  // Get all transactions of the credit card before the invoice period
  const previousTransactions = await prisma.transaction.findMany({
    where: {
      accountId,
      householdId,
      date: { lt: invoiceStart },
      attachmentUrl: { equals: null }, // Exclude payment transactions
    },
  });

  // Calculate previous net expenses (expenses - income) before the month
  // For credit cards: expenses increase debt, income decreases debt
  const previousNetExpenses = previousTransactions.reduce((sum: number, t) => {
    if (!t.categoryName) return sum;
    // Use transaction type if available, otherwise infer from category
    const isIncome = t.type === TransactionType.INCOME || 
      (t.type !== TransactionType.EXPENSE && getCategoriesByType(CategoryType.INCOME).includes(t.categoryName as any));
    if (isIncome) {
      return sum - t.amount.toNumber(); // Income decreases debt
    } else {
      return sum + t.amount.toNumber(); // Expenses increase debt
    }
  }, 0);

  // Payments by the invoice they pay (tag), already paid as of today
  const payments = await loadInvoicePayments(prisma, householdId, accountId, { year, monthNum }, options?.today ?? utcToday());
  const previousPaymentsTotal = payments.previousTotal;

  // Calculate previous balance based on transactions
  // Previous balance = all net expenses (expenses - income) before this month - all payments before this month
  let previousBalance = 0;
  
  if (previousTransactions.length > 0) {
    // Calculate based on previous transactions (considering both expenses and income)
    previousBalance = Math.max(0, previousNetExpenses - previousPaymentsTotal);
  } else {
    // No previous transactions - check if account has initial debt
    // Get current invoice period transactions to see if balance was modified
    const currentPeriodTransactions = await prisma.transaction.findMany({
      where: { accountId, householdId, date: { gte: invoiceStart, lte: invoiceEnd }, OR: [{ attachmentUrl: null }, { attachmentUrl: { not: { startsWith: `invoice_pay:${accountId}:` } } }] },
    });
    // The balance already holds every payment made. Those for this invoice are taken out of the total below and those
    // for later invoices never reduce it, so both are added back here; payments for earlier invoices are not, because
    // the branch above does not take them out either (the initial debt is what is left of the balance before them).
    const paidSoFar = payments.currentTotal + payments.laterTotal;

    if (currentPeriodTransactions.length === 0 && paidSoFar === 0) {
      // No transactions at all - use account balance as initial debt
      previousBalance = Math.max(0, account.balance.toNumber());
    } else {
      // Has transactions in current period but none before
      // Calculate net change in current period
      let currentPeriodNetChange = -paidSoFar; // Payments decrease debt
      for (const t of currentPeriodTransactions) {
        if (t.accountId === accountId && t.categoryName) {
          // Use transaction type if available, otherwise infer from category
          const isIncome = t.type === TransactionType.INCOME || 
            (t.type !== TransactionType.EXPENSE && getCategoriesByType(CategoryType.INCOME).includes(t.categoryName as any));
          if (isIncome) {
            currentPeriodNetChange -= t.amount.toNumber(); // Income decreases debt
          } else {
            currentPeriodNetChange += t.amount.toNumber(); // Expense increases debt
          }
        }
      }
      
      // Initial balance = current balance - current period net change
      previousBalance = Math.max(0, account.balance.toNumber() - currentPeriodNetChange);
    }
  }

  // Get current invoice period transactions (purchases in the period)
  const currentPeriodTransactions = await prisma.transaction.findMany({
    where: {
      accountId,
      householdId,
      date: { gte: invoiceStart, lte: invoiceEnd },
      attachmentUrl: { equals: null }, // Exclude payment transactions
    },
  });

  // Calculate current net expenses (expenses - income) in the period
  // For credit cards: expenses increase debt, income decreases debt
  const currentNetExpenses = currentPeriodTransactions.reduce((sum: number, t) => {
    if (!t.categoryName) return sum;
    // Use transaction type if available, otherwise infer from category
    const isIncome = t.type === TransactionType.INCOME || 
      (t.type !== TransactionType.EXPENSE && getCategoriesByType(CategoryType.INCOME).includes(t.categoryName as any));
    if (isIncome) {
      return sum - t.amount.toNumber(); // Income decreases debt
    } else {
      return sum + t.amount.toNumber(); // Expenses increase debt
    }
  }, 0);

  // Get payment transactions for this invoice period
  // monthKey format: "YYYY-M" where M is 0-indexed (0-11)
  const monthKey = `${year}-${monthNum - 1}`;
  const technicalIdentifier = `invoice_pay:${accountId}:${monthKey}`;
  
  const currentPayments = payments.currentRows;
  const currentPaymentsTotal = payments.currentTotal;

  // Total invoice = previous balance + current net expenses (expenses - income) - current payments
  const invoiceTotal = previousBalance + currentNetExpenses - currentPaymentsTotal;

  // Get invoice transactions (purchases + payments) with pagination
  const limit = pagination?.limit || 50;
  const whereClause = {
    OR: [
      {
        accountId,
        householdId,
        date: { gte: invoiceStart, lte: invoiceEnd },
      },
      {
        householdId,
        attachmentUrl: technicalIdentifier,
        // Only payments already made, as in the total above: one still dated in the future is not paid yet.
        date: { lte: options?.today ?? utcToday() },
      },
    ],
  };

  // Build pagination args
  const allInvoiceTransactions = pagination?.cursor
    ? await prisma.transaction.findMany({
        where: whereClause,
        orderBy: { date: 'desc' },
        take: limit + 1,
        cursor: { id: pagination.cursor },
        skip: 1,
      })
    : await prisma.transaction.findMany({
        where: whereClause,
        orderBy: { date: 'desc' },
        take: limit + 1,
      });

  // Check if there are more transactions
  const hasMore = allInvoiceTransactions.length > limit;
  const transactions = hasMore ? allInvoiceTransactions.slice(0, limit) : allInvoiceTransactions;
  const nextCursor = hasMore && transactions.length > 0 ? transactions[transactions.length - 1].id : null;

  // Get total count for pagination info
  const totalCount = await prisma.transaction.count({ where: whereClause });

  return {
    data: {
      accountId,
      month,
      previousBalance,
      currentExpenses: currentNetExpenses, // Net expenses (expenses - income)
      currentPayments: currentPaymentsTotal,
      total: Math.max(0, invoiceTotal),
      isPaid: currentPaymentsTotal > 0 && invoiceTotal <= 0.01,
      paymentTransactions: currentPayments,
      invoiceTransactions: transactions.map(t => ({
        ...t,
        amount: t.amount.toNumber(),
      })),
    },
    pagination: {
      nextCursor,
      hasMore,
      total: totalCount,
    },
  };
}

/**
 * Pay credit card invoice
 */
export async function payCreditCardInvoice(input: PayInvoiceInput) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  // accountId must be provided (from route params)
  if (!input.accountId) {
    throw new BadRequestError('accountId is required');
  }
  const accountId = input.accountId;

  const { sourceAccountId, amount, month, description } = input;

  // Parse month
  const [year, monthNum] = month.split('-').map(Number);
  const monthStart = new Date(year, monthNum - 1, 1);
  const monthEnd = new Date(year, monthNum, 0, 23, 59, 59, 999);
  const monthKey = `${year}-${monthNum - 1}`;
  const technicalIdentifier = `invoice_pay:${accountId}:${monthKey}`;

  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Verify credit card account
    const creditCard = await tx.account.findFirst({
      where: { id: accountId, householdId, isActive: true },
    });

    if (!creditCard) {
      throw new NotFoundError('Credit card account');
    }

    if (creditCard.type !== AccountType.CREDIT) {
      throw new BadRequestError('Account is not a credit card');
    }

    // 2. Verify source account
    const sourceAccount = await tx.account.findFirst({
      where: { id: sourceAccountId, householdId, isActive: true },
    });

    if (!sourceAccount) {
      throw new NotFoundError('Source account');
    }

    if (sourceAccount.type === AccountType.CREDIT) {
      throw new BadRequestError('Cannot pay invoice from credit card');
    }

    // 3. Calculate invoice (inline calculation to avoid nested transactions)
    const [invoiceYear, invoiceMonthNum] = month.split('-').map(Number);
    
    const invoiceWindow = creditCardInvoiceWindow(invoiceYear, invoiceMonthNum, effectiveClosingDay(creditCard));
    const invoiceMonthStart = invoiceWindow.start;
    const invoiceMonthEnd = invoiceWindow.end;

    // Get previous transactions
    const invoicePreviousTransactions = await tx.transaction.findMany({
      where: {
        accountId,
        householdId: householdId!,
        date: { lt: invoiceMonthStart },
        attachmentUrl: { equals: null },
      },
    });

    // Calculate previous net expenses (expenses - income) before the invoice period
    const invoicePreviousNetExpenses = invoicePreviousTransactions.reduce((sum: number, t) => {
      if (!t.categoryName) return sum;
      // Use transaction type if available, otherwise infer from category
      const isIncome = t.type === TransactionType.INCOME || 
        (t.type !== TransactionType.EXPENSE && getCategoriesByType(CategoryType.INCOME).includes(t.categoryName as any));
      if (isIncome) {
        return sum - t.amount.toNumber(); // Income decreases debt
      } else {
        return sum + t.amount.toNumber(); // Expenses increase debt
      }
    }, 0);

    const invoicePayments = await loadInvoicePayments(
      tx,
      householdId!,
      accountId,
      { year: invoiceYear, monthNum: invoiceMonthNum },
      utcToday()
    );
    const invoicePreviousPaymentsTotal = invoicePayments.previousTotal;

    // Calculate previous balance based on transactions
    // Previous balance = all expenses before this month - all payments before this month
    let invoicePreviousBalance = 0;
    
    if (invoicePreviousTransactions.length > 0) {
      // Calculate based on previous transactions
      invoicePreviousBalance = Math.max(0, invoicePreviousNetExpenses - invoicePreviousPaymentsTotal);
    } else {
      // No previous transactions - check if account has initial debt
      // Get current period transactions to see if balance was modified
      const currentPeriodTransactions = await tx.transaction.findMany({
        where: { accountId, householdId: householdId!, date: { gte: invoiceMonthStart, lte: invoiceMonthEnd }, OR: [{ attachmentUrl: null }, { attachmentUrl: { not: { startsWith: `invoice_pay:${accountId}:` } } }] },
      });
      // The balance already holds every payment made: see calculateCreditCardInvoice for which ones are added back.
      const paidSoFar = invoicePayments.currentTotal + invoicePayments.laterTotal;

      if (currentPeriodTransactions.length === 0 && paidSoFar === 0) {
        // No transactions at all - use account balance as initial debt
        invoicePreviousBalance = Math.max(0, creditCard.balance.toNumber());
      } else {
        // Has transactions in current period but none before
        // Calculate net change in current period
        let currentPeriodNetChange = -paidSoFar; // Payments decrease debt
        for (const t of currentPeriodTransactions) {
        if (t.accountId === accountId && t.categoryName) {
          // Use transaction type if available, otherwise infer from category
          const isIncome = t.type === TransactionType.INCOME || 
            (t.type !== TransactionType.EXPENSE && getCategoriesByType(CategoryType.INCOME).includes(t.categoryName as any));
          if (isIncome) {
            currentPeriodNetChange -= t.amount.toNumber(); // Income decreases debt
          } else {
            currentPeriodNetChange += t.amount.toNumber(); // Expense increases debt
          }
        }
      }
        
        // Initial balance = current balance - current period net change
        invoicePreviousBalance = Math.max(0, creditCard.balance.toNumber() - currentPeriodNetChange);
      }
    }

    // Get current period transactions
    const invoiceCurrentPeriodTransactions = await tx.transaction.findMany({
      where: {
        accountId,
        householdId: householdId!,
        date: { gte: invoiceMonthStart, lte: invoiceMonthEnd },
        attachmentUrl: { equals: null },
      },
    });

    // Calculate current net expenses (expenses - income) in the invoice period
    const invoiceCurrentNetExpenses = invoiceCurrentPeriodTransactions.reduce((sum: number, t) => {
      if (!t.categoryName) return sum;
      // Use transaction type if available, otherwise infer from category
      const isIncome = t.type === TransactionType.INCOME || 
        (t.type !== TransactionType.EXPENSE && getCategoriesByType(CategoryType.INCOME).includes(t.categoryName as any));
      if (isIncome) {
        return sum - t.amount.toNumber(); // Income decreases debt
      } else {
        return sum + t.amount.toNumber(); // Expenses increase debt
      }
    }, 0);

    // Pagamentos já realizados nesta fatura (parcial ou total) — devem ser descontados do total
    const invoiceCurrentPaymentsTotal = invoicePayments.currentTotal;

    // Total restante = saldo anterior + despesas líquidas do período (expenses - income) - pagamentos já feitos neste período
    const invoiceRemaining = Math.max(
      0,
      invoicePreviousBalance + invoiceCurrentNetExpenses - invoiceCurrentPaymentsTotal
    );

    const invoice = {
      total: invoiceRemaining,
      previousBalance: invoicePreviousBalance,
      currentExpenses: invoiceCurrentNetExpenses, // Net expenses (expenses - income)
    };

    // 4. Determine amount to pay: se amount não informado, usar o restante da fatura
    const amountToPay = amount ?? invoice.total;

    if (amountToPay <= 0) {
      throw new BadRequestError('Payment amount must be greater than zero');
    }

    // 5. Create payment transaction in source account (EXPENSE: saída da conta para pagar a fatura)
    const paymentTransaction = await tx.transaction.create({
      data: {
        householdId: householdId!,
        type: TransactionType.EXPENSE,
        accountId: sourceAccountId,
        categoryName: CategoryName.OTHER_EXPENSES,
        amount: new Prisma.Decimal(amountToPay),
        description: description || `Pagamento de fatura - ${month}`,
        date: new Date(),
        paid: true,
        attachmentUrl: technicalIdentifier,
      },
    });

    // Structured log so the payment's technical identifier can be compared against
    // the frontend invoice filter (CreditCards.tsx builds the same
    // `invoice_pay:${cardId}:${year}-${zeroBasedMonth}` string). If the frontend
    // does not surface this payment, compare `technicalIdentifier` and `paymentDate`
    // below with the month bucket being viewed: a payment is stored with today's date,
    // so paying an invoice in a later month lands it outside that month's bucket.
    console.info('[payCreditCardInvoice] payment recorded', JSON.stringify({
      householdId,
      creditCardAccountId: accountId,
      sourceAccountId,
      requestedMonth: month,
      monthKey,
      technicalIdentifier,
      paymentTransactionId: paymentTransaction.id,
      paymentDate: paymentTransaction.date.toISOString(),
      invoicePeriodStart: invoiceMonthStart.toISOString(),
      invoicePeriodEnd: invoiceMonthEnd.toISOString(),
      amountToPay,
      invoiceRemainingBeforePayment: invoiceRemaining,
    }));

    // 6. Update source account balance (decrease available balance)
    await tx.account.update({
      where: { id: sourceAccountId },
      data: {
        balance: { decrement: amountToPay }, // Legacy field
        totalBalance: { decrement: amountToPay },
        availableBalance: { decrement: amountToPay },
      },
    });

    // 7. Update credit card balance (decrease debt)
    // When paying the invoice, we simply deduct the payment amount from the balance
    // The balance already reflects all purchases (both paid and unpaid when created)
    // When we pay, we're reducing the debt by the payment amount
    await tx.account.update({
      where: { id: accountId },
      data: {
        balance: { decrement: amountToPay }, // Legacy field
        totalBalance: { decrement: amountToPay },
        availableBalance: { decrement: amountToPay },
      },
    });
    
    // Recalculate credit card limit after payment
    await recalculateCreditCardLimit(tx, accountId);

    // 8. Mark credit card transactions in the month as paid
    // Only unpaid transactions that are part of the invoice
    await tx.transaction.updateMany({
      where: {
        accountId,
        householdId: householdId!,
        date: { gte: invoiceMonthStart, lte: invoiceMonthEnd },
        paid: false,
        attachmentUrl: { equals: null }, // Only purchases, not payments
      },
      data: {
        paid: true,
      },
    });

    // 9. Get updated accounts
    const updatedCreditCard = await tx.account.findUnique({
      where: { id: accountId },
    });
    const updatedSourceAccount = await tx.account.findUnique({
      where: { id: sourceAccountId },
    });

    return {
      paymentTransaction,
      creditCardAccount: updatedCreditCard!,
      sourceAccount: updatedSourceAccount!,
      invoiceTotal: invoice.total,
      previousBalance: invoice.previousBalance,
      currentExpenses: invoice.currentExpenses,
      paidAmount: amountToPay,
    };
  });
}

/**
 * Undo credit card invoice payment
 */
export async function undoCreditCardPayment(
  input: UndoPaymentParams,
  householdId: string
) {
  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // 1. Find the payment transaction
    const paymentTransaction = await tx.transaction.findFirst({
      where: {
        id: input.transactionId,
        householdId,
        attachmentUrl: { not: null },
      },
    });

    if (!paymentTransaction) {
      throw new NotFoundError('Payment transaction');
    }

    if (!paymentTransaction.attachmentUrl?.startsWith(`invoice_pay:${input.accountId}:`)) {
      throw new BadRequestError('Transaction is not a payment for this credit card');
    }

    // 2. Verify credit card account
    const creditCard = await tx.account.findFirst({
      where: { id: input.accountId, householdId, isActive: true },
    });

    if (!creditCard) {
      throw new NotFoundError('Credit card account');
    }

    if (creditCard.type !== AccountType.CREDIT) {
      throw new BadRequestError('Account is not a credit card');
    }

    // 3. Extract month from attachmentUrl
    // Format: invoice_pay:accountId:YYYY-M (where M is 0-indexed, 0-11)
    const monthMatch = paymentTransaction.attachmentUrl.match(/invoice_pay:[^:]+:(\d{4}-\d+)/);
    if (!monthMatch) {
      throw new BadRequestError('Invalid payment transaction format');
    }

    const monthKey = monthMatch[1];
    const [year, monthIndex] = monthKey.split('-').map(Number);
    // monthIndex is 0-indexed (0-11), convert to 1-indexed for Date constructor
    const monthNum = monthIndex + 1;
    
    const undoWindow = creditCardInvoiceWindow(year, monthNum, effectiveClosingDay(creditCard));
    const monthStart = undoWindow.start;
    const monthEnd = undoWindow.end;

    // 4. Return amount to credit card balance (increase debt)
    const paymentAmount = paymentTransaction.amount.toNumber();
    await tx.account.update({
      where: { id: input.accountId },
      data: {
        balance: { increment: paymentAmount }, // Legacy field
        totalBalance: { increment: paymentAmount },
        availableBalance: { increment: paymentAmount },
      },
    });
    
    // Recalculate credit card limit after undoing payment
    await recalculateCreditCardLimit(tx, input.accountId);

    // 5. Return amount to source account balance (increase)
    if (!paymentTransaction.accountId) {
      throw new BadRequestError('Payment transaction must have a source account');
    }
    await tx.account.update({
      where: { id: paymentTransaction.accountId },
      data: {
        balance: { increment: paymentAmount }, // Legacy field
        totalBalance: { increment: paymentAmount },
        availableBalance: { increment: paymentAmount },
      },
    });

    // 6. Mark transactions as unpaid (only those that were paid when this payment was made)
    // Only transactions up to the payment date
    await tx.transaction.updateMany({
      where: {
        accountId: input.accountId,
        householdId,
        date: {
          gte: monthStart,
          // Never past the invoice's own window: the payment is dated on or after its closing day
          lte: paymentTransaction.date < monthEnd ? paymentTransaction.date : monthEnd,
        },
        paid: true,
        attachmentUrl: { equals: null }, // Only purchases, not payments
      },
      data: {
        paid: false,
      },
    });

    // 7. Delete the payment transaction
    await tx.transaction.delete({
      where: { id: input.transactionId },
    });

    // 8. Get updated accounts
    const updatedCreditCard = await tx.account.findUnique({
      where: { id: input.accountId },
    });
    const updatedSourceAccount = await tx.account.findUnique({
      where: { id: paymentTransaction.accountId! },
    });

    return {
      creditCardAccount: updatedCreditCard!,
      sourceAccount: updatedSourceAccount!,
      undoneTransaction: paymentTransaction,
    };
  });
}

/**
 * Create a transfer transaction between accounts
 * Transfer does not affect total balance (patrimony), only moves available balance
 */
export async function createTransfer(input: {
  householdId: string;
  fromAccountId: string;
  toAccountId: string;
  amount: number;
  description?: string;
  date: Date;
  notes?: string;
}) {
  const { householdId, fromAccountId, toAccountId, amount, description, date, notes } = input;

  if (fromAccountId === toAccountId) {
    throw new BadRequestError('Cannot transfer to the same account');
  }

  // Verify both accounts belong to household and are active
  const [fromAccount, toAccount] = await Promise.all([
    prisma.account.findFirst({
      where: { id: fromAccountId, householdId, isActive: true },
      select: { id: true, name: true, type: true },
    }),
    prisma.account.findFirst({
      where: { id: toAccountId, householdId, isActive: true },
      select: { id: true, name: true, type: true },
    }),
  ]);

  if (!fromAccount) {
    throw new NotFoundError('Source account');
  }

  if (!toAccount) {
    throw new NotFoundError('Destination account');
  }

  // Verify currencies match
  const [fromAccountFull, toAccountFull] = await Promise.all([
    prisma.account.findUnique({ where: { id: fromAccountId }, select: { currency: true } }),
    prisma.account.findUnique({ where: { id: toAccountId }, select: { currency: true } }),
  ]);

  if (fromAccountFull?.currency !== toAccountFull?.currency) {
    throw new BadRequestError('Cannot transfer between accounts with different currencies');
  }

  // Create transfer transaction and update balances
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Apply transfer (updates available_balance only)
    await applyTransfer(tx, fromAccountId, toAccountId, amount);

    // Create transfer transaction record
    const transferDescription = description || `${fromAccount.name} → ${toAccount.name}`;
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: TransactionType.TRANSFER,
        categoryName: CategoryName.TRANSFER,
        fromAccountId,
        toAccountId,
        amount: new Prisma.Decimal(amount),
        description: transferDescription,
        date,
        notes: notes || `Transfer from ${fromAccount.name} to ${toAccount.name}`,
        paid: true, // Transfers are always considered "paid"
      },
      include: {
        fromAccount: {
          select: { id: true, name: true, type: true },
        },
        toAccount: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    return transaction;
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...result,
    amount: result.amount.toNumber(),
  };
}

/**
 * Create an allocation transaction (allocate balance to credit card limit)
 * Allocation moves balance from available to allocated and increases credit card limit
 */
export async function createAllocation(input: {
  householdId: string;
  accountId: string;
  creditCardId: string;
  amount: number;
  description?: string;
  date: Date;
  notes?: string;
}) {
  const { householdId, accountId, creditCardId, amount, description, date, notes } = input;

  if (accountId === creditCardId) {
    throw new BadRequestError('Cannot allocate from account to itself');
  }

  // Verify accounts belong to household
  const [account, creditCard] = await Promise.all([
    prisma.account.findFirst({
      where: { id: accountId, householdId, isActive: true },
      select: { id: true, name: true, type: true },
    }),
    prisma.account.findFirst({
      where: { id: creditCardId, householdId, type: AccountType.CREDIT, isActive: true },
      select: { id: true, name: true, type: true },
    }),
  ]);

  if (!account) {
    throw new NotFoundError('Source account');
  }

  if (!creditCard) {
    throw new NotFoundError('Credit card account');
  }

  if (account.type === AccountType.CREDIT) {
    throw new BadRequestError('Cannot allocate from a credit card account');
  }

  // Create allocation transaction and update balances
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Apply allocation (moves from available to allocated, updates credit card limit)
    await applyAllocation(tx, accountId, creditCardId, amount);

    // Recalculate credit card available limit
    await recalculateCreditCardLimit(tx, creditCardId);

    // Create allocation transaction record
    const allocationDescription = description || `${account.name} → ${creditCard.name}`;
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: TransactionType.ALLOCATION,
        categoryName: CategoryName.ALLOCATION,
        accountId,
        relatedEntityId: creditCardId,
        amount: new Prisma.Decimal(amount),
        description: allocationDescription,
        date,
        notes: notes || `Allocation from ${account.name} to ${creditCard.name} limit`,
        paid: true, // Allocations are always considered "paid"
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
        relatedAccount: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    return transaction;
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...result,
    amount: result.amount.toNumber(),
  };
}

/**
 * Create a deallocation transaction (deallocate balance from credit card limit)
 * Deallocation moves balance from allocated back to available and decreases credit card limit
 */
export async function createDeallocation(input: {
  householdId: string;
  accountId: string;
  creditCardId: string;
  amount: number;
  description?: string;
  date: Date;
  notes?: string;
}) {
  const { householdId, accountId, creditCardId, amount, description, date, notes } = input;

  // Verify accounts belong to household
  const [account, creditCard] = await Promise.all([
    prisma.account.findFirst({
      where: { id: accountId, householdId, isActive: true },
      select: { id: true, name: true, type: true },
    }),
    prisma.account.findFirst({
      where: { id: creditCardId, householdId, type: AccountType.CREDIT, isActive: true },
      select: { id: true, name: true, type: true },
    }),
  ]);

  if (!account) {
    throw new NotFoundError('Source account');
  }

  if (!creditCard) {
    throw new NotFoundError('Credit card account');
  }

  // Create deallocation transaction and update balances
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Apply deallocation (moves from allocated back to available, updates credit card limit)
    await applyDeallocation(tx, accountId, creditCardId, amount);

    // Recalculate credit card available limit
    await recalculateCreditCardLimit(tx, creditCardId);

    // Create deallocation transaction record (negative amount to indicate reversal)
    const deallocationDescription = description || `${creditCard.name} → ${account.name}`;
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: TransactionType.ALLOCATION, // Same type, but negative amount indicates deallocation
        categoryName: CategoryName.ALLOCATION,
        accountId,
        relatedEntityId: creditCardId,
        amount: new Prisma.Decimal(-amount), // Negative to indicate deallocation
        description: deallocationDescription,
        date,
        notes: notes || `Deallocation from ${creditCard.name} limit back to ${account.name}`,
        paid: true, // Deallocations are always considered "paid"
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
        relatedAccount: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    return transaction;
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...result,
    amount: result.amount.toNumber(),
  };
}

