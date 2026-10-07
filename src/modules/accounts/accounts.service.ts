import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError } from '../../shared/errors/index.js';
import { localToday } from './accounts.schema.js';
import { CategoryName, AccountType, TransactionType } from '../../shared/enums/index.js';
import { applyTransfer, updateBalanceForNormalTransaction, recalculateCreditCardLimit } from '../../shared/services/balance.service.js';
import type {
  CreateAccountInput,
  UpdateAccountInput,
  ListAccountsQuery,
  TransferInput,
  AdjustBalanceInput,
} from './accounts.schema.js';

/**
 * Create a new account
 */
export async function createAccount(input: CreateAccountInput) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  // Se for cartão de crédito com linkedAccountId, buscar a cor da conta vinculada
  let accountColor = input.color;
  if (input.type === 'CREDIT' && input.linkedAccountId && !input.color) {
    const linkedAccount = await prisma.account.findUnique({
      where: { id: input.linkedAccountId },
      select: { color: true },
    });
    if (linkedAccount?.color) {
      accountColor = linkedAccount.color;
    }
  }

  // Validar linkedAccountId se fornecido (deve ser uma conta bancária, não cartão)
  if (input.linkedAccountId) {
    const linkedAccount = await prisma.account.findFirst({
      where: { 
        id: input.linkedAccountId,
        householdId,
        type: { not: 'CREDIT' }, // Só pode vincular a contas bancárias
      },
    });
    if (!linkedAccount) {
      throw new BadRequestError('Linked account must be a bank account (not a credit card)');
    }
  }

  // Para contas bancárias, o saldo inicial deve ser definido em totalBalance e availableBalance
  // Para cartões de crédito, o saldo inicial (dívida) é negativo
  const initialBalance = new Prisma.Decimal(input.balance);
  const isCreditCard = input.type === 'CREDIT';
  
  // Para cartões de crédito, o balance inicial é a dívida (negativa)
  // Para contas bancárias, o balance inicial é o saldo disponível
  const totalBalance = isCreditCard ? initialBalance : initialBalance;
  const availableBalance = isCreditCard ? initialBalance : initialBalance;
  const allocatedBalance = new Prisma.Decimal(0); // Sempre começa sem alocação

  const account = await prisma.account.create({
    data: {
      householdId,
      name: input.name,
      type: input.type,
      balance: initialBalance, // Legacy field - mantido para compatibilidade
      totalBalance: totalBalance, // Saldo total (available + allocated)
      availableBalance: availableBalance, // Saldo disponível
      allocatedBalance: allocatedBalance, // Saldo alocado (sempre 0 na criação)
      currency: input.currency,
      ...(accountColor && { color: accountColor }),
      ...(input.icon && { icon: input.icon }),
      ...(input.creditLimit && { creditLimit: new Prisma.Decimal(input.creditLimit) }),
      ...(input.dueDay && { dueDay: input.dueDay }),
      ...(input.closingDay && { closingDay: input.closingDay }),
      // Default to 10 days when creating a credit card without an explicit offset
      ...(input.bestDayOffset !== undefined
        ? { bestDayOffset: input.bestDayOffset }
        : input.type === 'CREDIT'
          ? { bestDayOffset: 10 }
          : {}),
      ...(input.linkedAccountId && { linkedAccountId: input.linkedAccountId }),
    },
  });

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...account,
    balance: account.balance.toNumber(),
    totalBalance: account.totalBalance.toNumber(),
    availableBalance: account.availableBalance.toNumber(),
    allocatedBalance: account.allocatedBalance.toNumber(),
    creditLimit: account.creditLimit ? account.creditLimit.toNumber() : null,
  };
}

/**
 * Get account by ID
 */
export async function getAccount(accountId: string) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
    include: {
      _count: {
        select: {
          transactions: true,
        },
      },
    },
  });

  if (!account) {
    throw new NotFoundError('Account');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...account,
    balance: account.balance.toNumber(),
    creditLimit: account.creditLimit ? account.creditLimit.toNumber() : null,
  };
}

/**
 * Get account with household verification
 */
export async function getAccountWithHousehold(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({
    where: {
      id: accountId,
      householdId,
    },
  });

  if (!account) {
    throw new NotFoundError('Account');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...account,
    balance: account.balance.toNumber(),
    creditLimit: account.creditLimit ? account.creditLimit.toNumber() : null,
  };
}

/**
 * List accounts for a household
 * Includes shared personal accounts when in a shared household
 */
export async function listAccounts(query: ListAccountsQuery, userId?: string) {
  const { householdId, includeInactive } = query;

  // Get household accounts
  const householdAccounts = await prisma.account.findMany({
    where: {
      householdId,
      ...(includeInactive ? {} : { isActive: true }),
    },
    include: {
      _count: {
        select: {
          transactions: true,
        },
      },
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });

  // If userId is provided and this is a shared household, include shared personal accounts
  let sharedAccounts: Array<typeof householdAccounts[0] & { accountOwnerId: string; isPersonal: boolean }> = [];
  if (userId) {
    // Get user's personal household (oldest household)
    const userMemberships = await prisma.householdMember.findMany({
      where: { userId },
      include: { household: true },
      orderBy: { createdAt: 'asc' },
      take: 1,
    });

    const personalHousehold = userMemberships[0]?.household;
    const isSharedHousehold = personalHousehold && personalHousehold.id !== householdId;

    if (isSharedHousehold && personalHousehold) {
      // Get current user's membership to check their shared accounts
      const currentUserMembership = await prisma.householdMember.findFirst({
        where: {
          householdId,
          userId,
        },
        select: { 
          userId: true, 
          allowPersonalAccountAccess: true,
          sharedAccountIds: true,
        },
      });

      // Get all household members (including current user)
      const allHouseholdMembers = await prisma.householdMember.findMany({
        where: {
          householdId,
        },
        select: { 
          userId: true, 
          allowPersonalAccountAccess: true,
          sharedAccountIds: true,
        },
      });

      // Filter members who have explicitly shared accounts
      // Only include accounts that are explicitly shared via sharedAccountIds
      // allowPersonalAccountAccess is for backward compatibility but we prioritize sharedAccountIds
      const membersWithAccess = allHouseholdMembers.filter((member) => {
        const sharedIds = member.sharedAccountIds;
        const hasSpecificSharedAccounts = Array.isArray(sharedIds) && sharedIds.length > 0 && sharedIds.every((id: unknown) => typeof id === 'string');
        
        // Only include if has specific shared accounts
        // If sharedAccountIds is empty array or null, don't include even if allowPersonalAccountAccess is true
        // This ensures accounts only appear when explicitly shared
        return hasSpecificSharedAccounts;
      });

      // Get shared accounts from each member (including current user's own shared accounts)
      for (const member of membersWithAccess) {
        const sharedIds = member.sharedAccountIds;
        const hasSpecificSharedAccounts = Array.isArray(sharedIds) && sharedIds.length > 0 && sharedIds.every((id: unknown) => typeof id === 'string');

        // Get member's personal household
        const memberPersonalHousehold = await prisma.householdMember.findFirst({
          where: { userId: member.userId },
          include: { household: true },
          orderBy: { createdAt: 'asc' },
        });

        if (!memberPersonalHousehold) continue;

        const memberPersonalHouseholdId = memberPersonalHousehold.household.id;

        // Fetch accounts from this member's personal household
        // Only fetch accounts that are explicitly in sharedAccountIds
        const whereClause: Prisma.AccountWhereInput = {
          householdId: memberPersonalHouseholdId,
          ...(includeInactive ? {} : { isActive: true }),
          // Only include accounts that are explicitly in sharedAccountIds
          id: { in: sharedIds as string[] },
        };

        const accounts = await prisma.account.findMany({
          where: whereClause,
          include: {
            _count: {
              select: {
                transactions: true,
              },
            },
          },
          orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
        });

        // Map accounts to their owner
        for (const acc of accounts) {
          sharedAccounts.push({
            ...acc,
            accountOwnerId: member.userId,
            isPersonal: true,
          } as typeof householdAccounts[0] & { accountOwnerId: string; isPersonal: boolean });
        }
      }
    }
  }

  // Combine household and shared accounts
  const allAccounts = [
    ...householdAccounts.map(acc => ({
      ...acc,
      isPersonal: false,
      accountOwnerId: null as string | null,
    })),
    ...sharedAccounts,
  ];

  // Calculate totals by currency (only from household accounts, not shared)
  const totals = householdAccounts.reduce(
    (acc: Record<string, Prisma.Decimal>, account) => {
      if (!account.isActive) return acc;
      const currency = account.currency;
      if (!acc[currency]) {
        acc[currency] = new Prisma.Decimal(0);
      }
      acc[currency] = acc[currency].add(account.balance);
      return acc;
    },
    {} as Record<string, Prisma.Decimal>
  );

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    accounts: allAccounts.map(account => ({
      ...account,
      balance: account.balance.toNumber(),
      creditLimit: account.creditLimit ? account.creditLimit.toNumber() : null,
      isPersonal: (account as any).isPersonal || false,
      accountOwnerId: (account as any).accountOwnerId || null,
    })),
    totals: Object.entries(totals).map(([currency, amount]: [string, Prisma.Decimal]) => ({
      currency,
      amount: amount.toNumber(),
    })),
  };
}

/**
 * List available accounts for a household transaction
 * Returns accounts from the household + personal accounts (if allowed)
 * @param householdId The household ID where the transaction will be created
 * @param userId The user ID requesting accounts
 * @param includeInactive Whether to include inactive accounts
 */
export async function listAvailableAccounts(householdId: string, userId: string, includeInactive = false) {
  // Get all accounts from the household
  const householdAccounts = await prisma.account.findMany({
    where: {
      householdId,
      ...(includeInactive ? {} : { isActive: true }),
    },
    include: {
      household: {
        select: { id: true, name: true },
      },
      _count: {
        select: {
          transactions: true,
        },
      },
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });

  // Get user's personal household (oldest household)
  const userMemberships = await prisma.householdMember.findMany({
    where: { userId },
    include: { household: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  });

  const personalHousehold = userMemberships[0]?.household;
  const isSharedHousehold = personalHousehold && personalHousehold.id !== householdId;

  // If this is a shared household, include shared personal accounts (from all members including current user)
  // Only include accounts that are explicitly shared via sharedAccountIds
  let sharedPersonalAccounts: Array<typeof householdAccounts[0] & { accountOwnerId: string }> = [];
  if (isSharedHousehold && personalHousehold) {
    // Get all household members (including current user) to check their shared accounts
    const allHouseholdMembers = await prisma.householdMember.findMany({
      where: {
        householdId,
      },
      select: { 
        userId: true, 
        allowPersonalAccountAccess: true,
        sharedAccountIds: true,
      },
    });

    // Filter members who have explicitly shared accounts
    // Only include accounts that are explicitly shared via sharedAccountIds
    const membersWithAccess = allHouseholdMembers.filter((member) => {
      // Check if member has specific account IDs shared
      const sharedIds = member.sharedAccountIds;
      const hasSpecificSharedAccounts = Array.isArray(sharedIds) && sharedIds.length > 0 && sharedIds.every((id: unknown) => typeof id === 'string');

      // Only include if has specific shared accounts
      return hasSpecificSharedAccounts;
    });

    // Process each member separately to respect their sharedAccountIds selection
    for (const member of membersWithAccess) {
      // Check if member has specific account IDs shared (new feature)
      const sharedIds = member.sharedAccountIds;
      const hasSpecificSharedAccounts = Array.isArray(sharedIds) && sharedIds.length > 0 && sharedIds.every((id: unknown) => typeof id === 'string');

      // Get personal household of this member
      const memberPersonalHousehold = await prisma.householdMember.findFirst({
        where: { userId: member.userId },
        include: { household: true },
        orderBy: { createdAt: 'asc' },
      });

      if (!memberPersonalHousehold) continue;

      const memberPersonalHouseholdId = memberPersonalHousehold.household.id;

      // Fetch accounts from this member's personal household
      // Only fetch accounts that are explicitly in sharedAccountIds
      const whereClause: Prisma.AccountWhereInput = {
        householdId: memberPersonalHouseholdId,
        ...(includeInactive ? {} : { isActive: true }),
        // Only include accounts that are explicitly in sharedAccountIds
        id: { in: sharedIds as string[] },
      };

      const accounts = await prisma.account.findMany({
        where: whereClause,
        include: {
          household: {
            select: { id: true, name: true },
          },
          _count: {
            select: {
              transactions: true,
            },
          },
        },
        orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      });

      // Map accounts to their owner and convert Prisma.Decimal to number
      for (const acc of accounts) {
        const mappedAccount = {
          ...acc,
          accountOwnerId: member.userId,
          balance: acc.balance.toNumber(),
          creditLimit: acc.creditLimit ? acc.creditLimit.toNumber() : null,
        };
        // Type assertion needed because we're converting Prisma.Decimal to number
        sharedPersonalAccounts.push(mappedAccount as unknown as typeof householdAccounts[0] & { accountOwnerId: string });
      }
    }
  }

  // Combine and mark personal accounts
  const allAccounts = [
    ...householdAccounts.map(acc => ({
      ...acc,
      isPersonal: false,
      accountOwnerId: undefined as string | undefined,
      balance: acc.balance.toNumber(),
      creditLimit: acc.creditLimit ? acc.creditLimit.toNumber() : null,
    })),
    ...sharedPersonalAccounts.map(acc => {
      // Balance and creditLimit are already converted to number in the loop above
      // Just ensure isPersonal and accountOwnerId are set correctly
      return {
        ...acc,
        isPersonal: true,
        accountOwnerId: acc.accountOwnerId || '',
      };
    }),
  ];

  return {
    accounts: allAccounts,
    hasPersonalAccounts: sharedPersonalAccounts.length > 0,
  };
}

/**
 * Update account
 */
export async function updateAccount(accountId: string, householdId: string, input: UpdateAccountInput) {
  // Buscar conta atual para verificar tipo
  const currentAccount = await prisma.account.findFirst({
    where: { id: accountId, householdId },
  });

  if (!currentAccount) {
    throw new NotFoundError('Account');
  }

  // Se for cartão de crédito e linkedAccountId for atualizado, buscar cor da conta vinculada
  let accountColor = input.color;
  if (currentAccount.type === 'CREDIT' && input.linkedAccountId !== undefined && !input.color) {
    if (input.linkedAccountId) {
      const linkedAccount = await prisma.account.findFirst({
        where: { 
          id: input.linkedAccountId,
          householdId,
          type: { not: 'CREDIT' }, // Só pode vincular a contas bancárias
        },
        select: { color: true },
      });
      if (linkedAccount?.color) {
        accountColor = linkedAccount.color;
      }
    } else if (input.linkedAccountId === null) {
      // Se estiver removendo o vínculo, manter a cor atual ou usar padrão
      accountColor = currentAccount.color || input.color;
    }
  }

  // Validar linkedAccountId se fornecido
  if (input.linkedAccountId) {
    const linkedAccount = await prisma.account.findFirst({
      where: { 
        id: input.linkedAccountId,
        householdId,
        type: { not: 'CREDIT' },
      },
    });
    if (!linkedAccount) {
      throw new BadRequestError('Linked account must be a bank account (not a credit card)');
    }
  }

  const updateData: any = {
    ...(input.name !== undefined && { name: input.name }),
    ...(input.type !== undefined && { type: input.type }),
    ...(input.balance !== undefined && { balance: new Prisma.Decimal(input.balance) }), // Permitir atualização direta (usado para pagamento de fatura)
    ...(input.isActive !== undefined && { isActive: input.isActive }),
    ...(accountColor !== undefined && { color: accountColor }),
    ...(input.icon !== undefined && { icon: input.icon }),
    ...(input.creditLimit !== undefined && {
      creditLimit: input.creditLimit ? new Prisma.Decimal(input.creditLimit) : null,
    }),
    ...(input.dueDay !== undefined && { dueDay: input.dueDay }),
    ...(input.closingDay !== undefined && { closingDay: input.closingDay }),
    ...(input.bestDayOffset !== undefined && { bestDayOffset: input.bestDayOffset }),
    ...(input.linkedAccountId !== undefined && { linkedAccountId: input.linkedAccountId }),
  };

  // If account type is not credit, remove credit-specific fields
  if (input.type && input.type !== 'CREDIT') {
    updateData.creditLimit = null;
    updateData.dueDay = null;
    updateData.closingDay = null;
    updateData.bestDayOffset = null;
    updateData.linkedAccountId = null;
    updateData.totalLimit = null;
  }

  const account = await prisma.account.update({
    where: { id: accountId },
    data: updateData,
  });

  // REGRA: totalLimit = creditLimit + currently allocated balance (only if credit card).
  // Recalculate after every edit so the value never drifts from the invariant.
  if (account.type === AccountType.CREDIT) {
    const allocatedFromBankAccounts = await prisma.account.aggregate({
      where: {
        householdId: account.householdId,
        type: { not: AccountType.CREDIT },
        isActive: true,
      },
      _sum: { allocatedBalance: true },
    });
    const allocatedTotal = allocatedFromBankAccounts._sum.allocatedBalance?.toNumber() ?? 0;
    const creditLimitValue = account.creditLimit?.toNumber() ?? 0;
    const correctTotalLimit = creditLimitValue + allocatedTotal;
    if (
      account.totalLimit === null ||
      Math.abs(account.totalLimit.toNumber() - correctTotalLimit) > 0.001
    ) {
      const updated = await prisma.account.update({
        where: { id: accountId },
        data: { totalLimit: new Prisma.Decimal(correctTotalLimit) },
      });
      return {
        ...updated,
        balance: updated.balance.toNumber(),
        creditLimit: updated.creditLimit ? updated.creditLimit.toNumber() : null,
      };
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return {
    ...account,
    balance: account.balance.toNumber(),
    creditLimit: account.creditLimit ? account.creditLimit.toNumber() : null,
  };
}

/**
 * Delete account permanently from database
 * This is a hard delete - the account record is removed from the database
 *
 * By default transactions are preserved (the schema sets their account FKs to NULL
 * via onDelete: SetNull), which leaves them showing up unlinked in the Transactions
 * list. When `deleteTransactions` is true we explicitly delete every transaction that
 * references this account (via accountId, fromAccountId or toAccountId) inside the same
 * DB transaction, so no orphaned records are left behind.
 */
export async function deleteAccount(accountId: string, deleteTransactions = false) {
  const account = await prisma.account.findUnique({
    where: { id: accountId },
  });

  if (!account) {
    throw new NotFoundError('Account');
  }

  // Store id and householdId before deletion for response
  const deletedAccountId = account.id;
  const householdId = account.householdId;

  let deletedTransactionsCount = 0;

  if (deleteTransactions) {
    // Delete linked transactions and the account atomically, so we never end up
    // with the account gone but its transactions half-deleted (or vice-versa).
    const [{ count }] = await prisma.$transaction([
      prisma.transaction.deleteMany({
        where: {
          householdId,
          OR: [
            { accountId },
            { fromAccountId: accountId },
            { toAccountId: accountId },
          ],
        },
      }),
      prisma.account.delete({
        where: { id: accountId },
      }),
    ]);
    deletedTransactionsCount = count;
  } else {
    // Hard delete the account only; linked transactions keep their rows with the
    // account FKs set to NULL (onDelete: SetNull in schema).
    await prisma.account.delete({
      where: { id: accountId },
    });
  }

  return {
    id: deletedAccountId,
    householdId: householdId,
    deletedTransactions: deletedTransactionsCount,
  };
}

/**
 * Transfer money between accounts
 */
export async function transferBetweenAccounts(
  householdId: string,
  input: TransferInput
) {
  const { fromAccountId, toAccountId, amount, description } = input;

  if (fromAccountId === toAccountId) {
    throw new BadRequestError('Cannot transfer to the same account');
  }

  // Verify both accounts belong to the household
  const [fromAccount, toAccount] = await Promise.all([
    prisma.account.findFirst({
      where: { id: fromAccountId, householdId, isActive: true },
    }),
    prisma.account.findFirst({
      where: { id: toAccountId, householdId, isActive: true },
    }),
  ]);

  if (!fromAccount) {
    throw new NotFoundError('Source account');
  }
  if (!toAccount) {
    throw new NotFoundError('Destination account');
  }

  // Verify currencies match
  if (fromAccount.currency !== toAccount.currency) {
    throw new BadRequestError('Cannot transfer between accounts with different currencies');
  }

  // Verify sufficient available balance for non-credit accounts
  if (fromAccount.type !== 'CREDIT') {
    const currentAvailable = fromAccount.availableBalance?.toNumber() || fromAccount.balance.toNumber();
    if (currentAvailable < amount) {
      throw new BadRequestError('Insufficient available balance');
    }
  }

  // Use TRANSFER category for transfers (categories are now enums)
  const transferCategoryName = CategoryName.TRANSFER;

  // Execute transfer in a transaction using BalanceService
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Apply transfer using BalanceService (updates availableBalance only, not totalBalance)
    await applyTransfer(tx, fromAccountId, toAccountId, amount);

    // Get updated accounts
    const [updatedFrom, updatedTo] = await Promise.all([
      tx.account.findUnique({ where: { id: fromAccountId } }),
      tx.account.findUnique({ where: { id: toAccountId } }),
    ]);

    // Create transactions for both sides
    const transferDescription = description || `Transfer: ${fromAccount.name} → ${toAccount.name}`;
    const now = new Date();

    const [outTransaction, inTransaction] = await Promise.all([
      tx.transaction.create({
        data: {
          householdId,
          type: 'TRANSFER' as const,
          categoryName: transferCategoryName,
          fromAccountId,
          toAccountId,
          accountId: fromAccountId, // For filtering purposes
          amount: new Prisma.Decimal(-amount),
          description: transferDescription,
          date: now,
          notes: `Transfer out to ${toAccount.name}`,
          paid: true,
        },
      }),
      tx.transaction.create({
        data: {
          householdId,
          type: 'TRANSFER' as const,
          categoryName: transferCategoryName,
          fromAccountId,
          toAccountId,
          accountId: toAccountId, // For filtering purposes
          amount: new Prisma.Decimal(amount),
          description: transferDescription,
          date: now,
          notes: `Transfer in from ${fromAccount.name}`,
          paid: true,
        },
      }),
    ]);

    return {
      fromAccount: updatedFrom!,
      toAccount: updatedTo!,
      transactions: [outTransaction, inTransaction],
    };
  });

  return result;
}

/**
 * Manually adjust account balance: the account ends with exactly input.newBalance and ONE adjustment entry records the
 * difference (nothing else is touched). The entry is a regular paid INCOME/EXPENSE row with a positive amount, the way
 * createTransaction stores them, so reports and the balance recompute treat it like any other row:
 * - bank/cash accounts: a higher balance is an INCOME (OTHER_INCOME), a lower one an EXPENSE (OTHER_EXPENSES);
 * - credit cards: the balance is the debt, so a higher balance is an EXPENSE and a lower one an INCOME.
 * The entry is dated input.date (default today): an opening balance dated in the previous year stays out of this year's
 * reports. The account row is locked (SELECT ... FOR UPDATE) and the difference is computed from the locked row, so two
 * concurrent submits of the same target apply once: the second one finds difference zero and creates no entry.
 */
export async function adjustBalance(
  accountId: string,
  householdId: string,
  input: AdjustBalanceInput
) {
  const exists = await prisma.account.findFirst({
    where: { id: accountId, householdId },
    select: { id: true },
  });

  if (!exists) {
    throw new NotFoundError('Account');
  }

  const target = new Prisma.Decimal(input.newBalance);
  // The schema already trims the reason; an empty one falls back to the default.
  const reason = input.reason || 'Balance adjustment';

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    await tx.$queryRaw`SELECT id FROM accounts WHERE id = ${accountId}::uuid FOR UPDATE`;
    const account = await tx.account.findFirst({ where: { id: accountId, householdId } });
    if (!account) {
      throw new NotFoundError('Account');
    }

    // The difference is taken against totalBalance (available + allocated), the balance the app shows.
    const difference = target.minus(account.totalBalance);
    if (difference.isZero()) {
      return { account, adjustment: null };
    }

    const isCreditCard = account.type === AccountType.CREDIT;
    // A card's balance is its debt: more debt is an expense, less debt a credit.
    const isIncome = isCreditCard ? difference.isNegative() : difference.isPositive();
    const date = input.date ?? localToday();

    const adjustment = await tx.transaction.create({
      data: {
        householdId,
        accountId,
        type: isIncome ? TransactionType.INCOME : TransactionType.EXPENSE,
        categoryName: isIncome ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES,
        amount: difference.abs(),
        description: reason,
        date,
        notes: `Previous balance: ${account.totalBalance.toFixed(2)}, New balance: ${target.toFixed(2)}`,
        paid: true, // Ajustes são sempre considerados pagos
      },
    });

    // The balance always moves by the signed difference (for a card, more debt is a positive change).
    await updateBalanceForNormalTransaction(tx, accountId, difference.toNumber());
    if (isCreditCard) {
      await recalculateCreditCardLimit(tx, accountId);
    }

    const updatedAccount = await tx.account.findUniqueOrThrow({ where: { id: accountId } });
    return { account: updatedAccount, adjustment: { ...adjustment, amount: adjustment.amount.toNumber() } };
  });
}

/**
 * Get account summary for a household
 */
export async function getAccountsSummary(householdId: string) {
  const accounts = await prisma.account.findMany({
    where: { householdId, isActive: true },
  });

  const summary = {
    totalAccounts: accounts.length,
    byType: {} as Record<string, { count: number; total: number }>,
    byCurrency: {} as Record<string, number>,
  };

  for (const account of accounts) {
    // By type
    if (!summary.byType[account.type]) {
      summary.byType[account.type] = { count: 0, total: 0 };
    }
    summary.byType[account.type].count++;
    summary.byType[account.type].total += account.balance.toNumber();

    // By currency
    if (!summary.byCurrency[account.currency]) {
      summary.byCurrency[account.currency] = 0;
    }
    summary.byCurrency[account.currency] += account.balance.toNumber();
  }

  return summary;
}





