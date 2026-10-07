import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError } from '../../shared/errors/index.js';
import type { UpdateUserPreferencesInput } from './users.schema.js';

/**
 * Get user by Firebase UID
 */
export async function getUserByFirebaseUid(firebaseUid: string) {
  const user = await prisma.user.findUnique({
    where: { firebaseUid },
    select: {
      id: true,
      firebaseUid: true,
      email: true,
      displayName: true,
      isPremium: true,
      onboardingCompleted: true,
      onboardingRestartedAt: true,
      theme: true,
      baseCurrency: true,
      locale: true,
      country: true,
      referralCode: true,
      dashboardPreferences: true,
      lastRecurringProcessedMonth: true,
      lastRecurringProcessedAt: true,
      preferencesUpdatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new NotFoundError('User');
  }

  return user;
}

/**
 * Get user by database ID
 */
export async function getUserById(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      firebaseUid: true,
      email: true,
      displayName: true,
      isPremium: true,
      onboardingCompleted: true,
      onboardingRestartedAt: true,
      theme: true,
      baseCurrency: true,
      locale: true,
      country: true,
      referralCode: true,
      dashboardPreferences: true,
      lastRecurringProcessedMonth: true,
      lastRecurringProcessedAt: true,
      preferencesUpdatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  if (!user) {
    throw new NotFoundError('User');
  }

  return user;
}

/**
 * Update user preferences
 */
export async function updateUserPreferences(
  userId: string,
  input: UpdateUserPreferencesInput
) {
  // Prepare update data
  const updateData: any = {
    ...(input.displayName !== undefined && { displayName: input.displayName }),
    ...(input.isPremium !== undefined && { isPremium: input.isPremium }),
    ...(input.onboardingCompleted !== undefined && {
      onboardingCompleted: input.onboardingCompleted,
    }),
    ...(input.onboardingRestartedAt !== undefined && {
      onboardingRestartedAt: input.onboardingRestartedAt,
    }),
    ...(input.theme !== undefined && { theme: input.theme }),
    ...(input.baseCurrency !== undefined && { baseCurrency: input.baseCurrency }),
    ...(input.locale !== undefined && { locale: input.locale }),
    ...(input.country !== undefined && { country: input.country }),
    ...(input.referralCode !== undefined && { referralCode: input.referralCode }),
    ...(input.dashboardPreferences !== undefined && {
      dashboardPreferences: input.dashboardPreferences as any,
    }),
    ...(input.lastRecurringProcessedMonth !== undefined && {
      lastRecurringProcessedMonth: input.lastRecurringProcessedMonth,
    }),
    ...(input.lastRecurringProcessedAt !== undefined && {
      lastRecurringProcessedAt: input.lastRecurringProcessedAt,
    }),
    preferencesUpdatedAt: new Date(),
  };

  const user = await prisma.user.update({
    where: { id: userId },
    data: updateData,
    select: {
      id: true,
      firebaseUid: true,
      email: true,
      displayName: true,
      isPremium: true,
      onboardingCompleted: true,
      onboardingRestartedAt: true,
      theme: true,
      baseCurrency: true,
      locale: true,
      country: true,
      referralCode: true,
      dashboardPreferences: true,
      lastRecurringProcessedMonth: true,
      lastRecurringProcessedAt: true,
      preferencesUpdatedAt: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  return user;
}

/**
 * Get or create referral code for user
 */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true, firebaseUid: true },
  });

  if (!user) {
    throw new NotFoundError('User');
  }

  // If referral code exists, return it
  if (user.referralCode) {
    return user.referralCode;
  }

  // Generate referral code from Firebase UID (local users fall back to userId)
  const rawId = user.firebaseUid ?? userId;
  const cleanId = rawId.replace(/-/g, '');
  const referralCode = cleanId.slice(0, 8).toUpperCase();

  // Save and return
  await prisma.user.update({
    where: { id: userId },
    data: { referralCode },
  });

  return referralCode;
}

/**
 * Reset user account - delete all data but keep user
 * This will:
 * 1. Delete all households where user is the only member (which cascades to accounts, transactions, budgets, savings goals, etc.)
 * 2. Remove user's membership from households with other members
 * 3. Reset user preferences (onboardingCompleted: false, etc.)
 * Note: User remains in the database and Firebase Auth - this is for resetting data only
 */
export async function resetUserData(userId: string): Promise<void> {
  // Verify user exists and get all household memberships
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      householdMembers: {
        include: {
          household: {
            include: {
              members: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new NotFoundError('User');
  }

  // Delete in transaction to ensure atomicity
  await prisma.$transaction(async (tx) => {
    // Process each household the user is a member of
    for (const membership of user.householdMembers) {
      const household = membership.household;
      
      // If user is the only member, delete the entire household
      // This will cascade delete: accounts, transactions, budgets, savings goals, recurring transactions
      // and also delete the HouseholdMember entry
      if (household.members.length === 1) {
        await tx.household.delete({
          where: { id: household.id },
        });
      } else {
        // If there are other members, just remove this user's membership
        // This must be done before resetting preferences to maintain referential integrity
        await tx.householdMember.delete({
          where: { id: membership.id },
        });
      }
    }

    // Reset user preferences (reset onboarding, clear preferences, etc.)
    await tx.user.update({
      where: { id: userId },
      data: {
        onboardingCompleted: false,
        onboardingRestartedAt: new Date(),
        displayName: null,
        country: null,
        locale: null,
        baseCurrency: null,
        theme: null,
        dashboardPreferences: Prisma.DbNull,
        preferencesUpdatedAt: new Date(),
      },
    });
  });
}

/**
 * Delete user and all related data (cascade deletion)
 * This will:
 * 1. For households where user is the only member, delete the household (which cascades to accounts, transactions, budgets, savings goals, etc.)
 * 2. For households with other members, remove the user's membership
 * 3. Finally, delete the user itself (remaining HouseholdMember entries will be deleted automatically via onDelete: Cascade)
 */
export async function deleteUser(userId: string): Promise<void> {
  // Verify user exists and get all household memberships
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      householdMembers: {
        include: {
          household: {
            include: {
              members: true,
            },
          },
        },
      },
    },
  });

  if (!user) {
    throw new NotFoundError('User');
  }

  // Delete in transaction to ensure atomicity
  await prisma.$transaction(async (tx) => {
    // Process each household the user is a member of
    for (const membership of user.householdMembers) {
      const household = membership.household;
      
      // If user is the only member, delete the entire household
      // This will cascade delete: accounts, transactions, budgets, savings goals, recurring transactions
      // and also delete the HouseholdMember entry
      if (household.members.length === 1) {
        await tx.household.delete({
          where: { id: household.id },
        });
      } else {
        // If there are other members, just remove this user's membership
        // This must be done before deleting the user to maintain referential integrity
        await tx.householdMember.delete({
          where: { id: membership.id },
        });
      }
    }

    // Finally, delete the user
    // Any remaining HouseholdMember entries (though there shouldn't be any at this point)
    // would be deleted automatically via onDelete: Cascade
    await tx.user.delete({
      where: { id: userId },
    });
  });
}





