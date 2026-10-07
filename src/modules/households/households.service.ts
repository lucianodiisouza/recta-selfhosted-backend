import type { HouseholdRole } from '../../generated/prisma/client.js';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, ConflictError, BadRequestError } from '../../shared/errors/index.js';
import type { CreateHouseholdInput, UpdateHouseholdInput, InviteMemberInput } from './households.schema.js';
import { CategoryName, CategoryType, getDefaultCategoriesByType, getCategoryColor } from '../../shared/enums/index.js';

/**
 * Create a new household with the creator as OWNER
 */
export async function createHousehold(userId: string, input: CreateHouseholdInput) {
  // Check how many households the user is a member of
  const userMemberships = await prisma.householdMember.findMany({
    where: { userId },
    include: {
      household: {
        include: {
          _count: {
            select: { members: true },
          },
        },
      },
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  // The first household (oldest) is considered the personal one
  // All others are considered shared households
  // Limit to 1 shared household (in addition to personal household)
  if (userMemberships.length > 1) {
    throw new BadRequestError(
      'Você já possui uma household compartilhada. Por enquanto, é permitido apenas uma household compartilhada por usuário.'
    );
  }

  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Create household
    const household = await tx.household.create({
      data: {
        name: input.name,
      },
    });

    // Add creator as owner
    await tx.householdMember.create({
      data: {
        householdId: household.id,
        userId,
        role: 'OWNER',
      },
    });

    // Categories are now ENUMs, no longer stored in database
    // No need to create categories

    return household;
  });
}

/**
 * Get household by ID with member count
 */
export async function getHousehold(householdId: string) {
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    include: {
      _count: {
        select: {
          members: true,
          accounts: true,
          transactions: true,
        },
      },
    },
  });

  if (!household) {
    throw new NotFoundError('Household');
  }

  return household;
}

/**
 * Update household details
 */
export async function updateHousehold(householdId: string, input: UpdateHouseholdInput) {
  return await prisma.household.update({
    where: { id: householdId },
    data: input,
  });
}

/**
 * Delete household and all related data.
 *
 * O que é removido em cascata (onDelete: Cascade no schema):
 * - HouseholdMember, HouseholdInvite
 * - Account (contas e cartões; os saldos vão junto)
 * - Transaction (e TransactionSplit)
 * - Budget, SavingsGoal, RecurringTransaction
 *
 * Isso "reverte" as transações daquela household no sentido de removê-las;
 * os saldos das contas são excluídos com as contas. Nenhuma recalculação
 * de saldo é necessária em outras households.
 *
 * Notificações que referenciam esta household (metadata.householdId) são
 * removidas explicitamente, pois não há FK.
 */
export async function deleteHousehold(householdId: string) {
  await prisma.$transaction(async (tx) => {
    // Notificações não têm FK para Household; metadata é JSON. Remover para não deixar links quebrados.
    await tx.$executeRaw`
      DELETE FROM notifications
      WHERE (metadata->>'householdId') = ${householdId}
    `;
    await tx.household.delete({
      where: { id: householdId },
    });
  });
}

/**
 * Get all members of a household
 */
export async function getHouseholdMembers(householdId: string) {
  return await prisma.householdMember.findMany({
    where: { householdId },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          createdAt: true,
        },
      },
    },
    orderBy: [{ role: 'asc' }, { createdAt: 'asc' }],
  });
}

/**
 * Invite a user to household by email (creates pending invite)
 */
export async function inviteMember(householdId: string, inviterId: string, input: InviteMemberInput) {
  // Find user by email, ignoring case: stored emails may have capitals (Firebase keeps what the provider sent)
  const user = await prisma.user.findFirst({
    where: { email: { equals: input.email.trim(), mode: 'insensitive' } },
  });

  if (!user) {
    throw new NotFoundError('User');
  }

  // Check if already a member
  const existingMember = await prisma.householdMember.findUnique({
    where: {
      householdId_userId: {
        householdId,
        userId: user.id,
      },
    },
  });

  if (existingMember) {
    throw new ConflictError('User is already a member of this household');
  }

  // Check if there's already a pending invite
  const existingInvite = await prisma.householdInvite.findFirst({
    where: {
      householdId,
      email: user.email,
      status: 'PENDING',
      expiresAt: {
        gt: new Date(),
      },
    },
  });

  if (existingInvite) {
    throw new ConflictError('User already has a pending invite for this household');
  }

  // Check member limit: plan supports up to 2 active members per household (family plan)
  const MAX_MEMBERS = 2;
  const activeMembersCount = await prisma.householdMember.count({
    where: { householdId },
  });

  if (activeMembersCount >= MAX_MEMBERS) {
    throw new BadRequestError(`O limite é de ${MAX_MEMBERS} membros por household. Esta household já possui ${activeMembersCount} ${activeMembersCount === 1 ? 'membro' : 'membros'} ativo${activeMembersCount === 1 ? '' : 's'}.`);
  }

  // Create pending invite (expires in 7 days)
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + 7);

  // Get household and inviter info for notification
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { id: true, name: true },
  });

  const inviter = await prisma.user.findUnique({
    where: { id: inviterId },
    select: { id: true, email: true, displayName: true },
  });

  if (!household) {
    throw new NotFoundError('Household');
  }

  // Create invite
  const invite = await prisma.householdInvite.create({
    data: {
      householdId,
      inviterId,
      inviteeId: user.id,
      email: user.email,
      role: input.role,
      status: 'PENDING',
      expiresAt,
    },
    include: {
      household: {
        select: {
          id: true,
          name: true,
          createdAt: true,
        },
      },
      inviter: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
  });

  // Create notification for the invitee (async, don't block invite creation)
  // Dynamic import to avoid circular dependency
  try {
    const { createHouseholdInviteNotification } = await import('../notifications/notifications.service.js');
    
    await createHouseholdInviteNotification({
      inviteId: invite.id,
      inviteeId: user.id,
      householdId: household.id,
      householdName: household.name,
      inviterName: inviter?.displayName || inviter?.email || 'Usuário',
      role: input.role,
      expiresAt,
    });
  } catch (error) {
    // Log error but don't fail invite creation if notification fails
    console.error('[inviteMember] Error creating notification:', error);
  }

  return invite;
}

/**
 * Update member role
 */
export async function updateMemberRole(
  householdId: string,
  memberId: string,
  role: HouseholdRole
) {
  // Get the member
  const member = await prisma.householdMember.findFirst({
    where: {
      id: memberId,
      householdId,
    },
  });

  if (!member) {
    throw new NotFoundError('Member');
  }

  // Cannot change owner's role directly
  if (member.role === 'OWNER') {
    throw new BadRequestError('Cannot change the role of the household owner');
  }

  // Cannot promote to owner (transfer ownership is a separate action)
  if (role === 'OWNER') {
    throw new BadRequestError('Use transfer ownership instead');
  }

  return await prisma.householdMember.update({
    where: { id: memberId },
    data: { role },
  });
}

/**
 * Update member's personal account access permission
 * Users can only update their own permission
 */
export async function updatePersonalAccountAccess(
  householdId: string,
  userId: string,
  allowPersonalAccountAccess: boolean
) {
  // Find the member
  const member = await prisma.householdMember.findUnique({
    where: {
      householdId_userId: {
        householdId,
        userId,
      },
    },
  });

  if (!member) {
    throw new NotFoundError('Membership');
  }

  // Users can only update their own permission
  if (member.userId !== userId) {
    throw new BadRequestError('You can only update your own personal account access permission');
  }

  return await prisma.householdMember.update({
    where: { id: member.id },
    data: { allowPersonalAccountAccess },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          createdAt: true,
        },
      },
    },
  });
}

/**
 * Update shared account IDs for a member
 * Allows a member to specify which of their personal accounts can be used in a shared household
 * Members can only update their own sharedAccountIds
 */
export async function updateSharedAccountIds(
  householdId: string,
  userId: string,
  sharedAccountIds: string[]
) {
  // Find the member
  const member = await prisma.householdMember.findUnique({
    where: {
      householdId_userId: {
        householdId,
        userId,
      },
    },
  });

  if (!member) {
    throw new NotFoundError('Membership');
  }

  // Users can only update their own sharedAccountIds
  if (member.userId !== userId) {
    throw new BadRequestError('You can only update your own shared account IDs');
  }

  // Validate that all account IDs belong to the user's personal household
  // Get user's personal household (oldest household)
  const userMemberships = await prisma.householdMember.findMany({
    where: { userId },
    include: { household: true },
    orderBy: { createdAt: 'asc' },
    take: 1,
  });

  const personalHousehold = userMemberships[0]?.household;
  if (!personalHousehold) {
    throw new BadRequestError('User does not have a personal household');
  }

  // Validate that all provided account IDs exist and belong to the user's personal household
  if (sharedAccountIds.length > 0) {
    const accounts = await prisma.account.findMany({
      where: {
        id: { in: sharedAccountIds },
        householdId: personalHousehold.id,
      },
      select: { id: true },
    });

    if (accounts.length !== sharedAccountIds.length) {
      throw new BadRequestError('One or more account IDs are invalid or do not belong to your personal household');
    }
  }

  // Update sharedAccountIds (store as JSON array)
  // Store as empty array [] if no accounts selected, otherwise store the array of IDs
  // Prisma JSONB fields accept arrays directly
  return await prisma.householdMember.update({
    where: { id: member.id },
    data: { 
      sharedAccountIds: sharedAccountIds.length > 0 ? sharedAccountIds : [],
    },
    include: {
      user: {
        select: {
          id: true,
          email: true,
          displayName: true,
          createdAt: true,
        },
      },
    },
  });
}

/**
 * Remove a member from household
 */
export async function removeMember(householdId: string, memberId: string) {
  const member = await prisma.householdMember.findFirst({
    where: {
      id: memberId,
      householdId,
    },
  });

  if (!member) {
    throw new NotFoundError('Member');
  }

  // Cannot remove owner
  if (member.role === 'OWNER') {
    throw new BadRequestError('Cannot remove the household owner');
  }

  await prisma.householdMember.delete({
    where: { id: memberId },
  });
}

/**
 * Transfer ownership to another member
 */
export async function transferOwnership(
  householdId: string,
  currentOwnerId: string,
  newOwnerId: string
) {
  // Verify new owner is a member
  const newOwnerMember = await prisma.householdMember.findFirst({
    where: {
      id: newOwnerId,
      householdId,
    },
  });

  if (!newOwnerMember) {
    throw new NotFoundError('Member');
  }

  if (newOwnerMember.role === 'OWNER') {
    throw new BadRequestError('User is already the owner');
  }

  // Get current owner membership
  const currentOwnerMember = await prisma.householdMember.findFirst({
    where: {
      userId: currentOwnerId,
      householdId,
      role: 'OWNER',
    },
  });

  if (!currentOwnerMember) {
    throw new BadRequestError('You are not the owner');
  }

  // Transfer ownership in a transaction
  await prisma.$transaction([
    // Demote current owner to editor
    prisma.householdMember.update({
      where: { id: currentOwnerMember.id },
      data: { role: 'EDITOR' },
    }),
    // Promote new owner
    prisma.householdMember.update({
      where: { id: newOwnerId },
      data: { role: 'OWNER' },
    }),
  ]);
}

/**
 * Leave a household (for non-owners)
 */
export async function leaveHousehold(householdId: string, userId: string) {
  const member = await prisma.householdMember.findUnique({
    where: {
      householdId_userId: {
        householdId,
        userId,
      },
    },
  });

  if (!member) {
    throw new NotFoundError('Membership');
  }

  if (member.role === 'OWNER') {
    throw new BadRequestError('Owner cannot leave. Transfer ownership first or delete the household.');
  }

  await prisma.householdMember.delete({
    where: { id: member.id },
  });
}

/**
 * Create a personal household for a user
 * Used for lazy creation when user needs a household (e.g., first transaction/account)
 */
export async function createPersonalHousehold(userId: string, email: string) {
  // Check if user already has a household
  const existingMembership = await prisma.householdMember.findFirst({
    where: { userId },
    include: { household: true },
  });

  if (existingMembership) {
    return existingMembership.household;
  }

  // Create personal household with user as owner
  const defaultName = email.split('@')[0] || 'My Finances';

  return await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const household = await tx.household.create({
      data: {
        name: `${defaultName}'s Finances`,
      },
    });

    await tx.householdMember.create({
      data: {
        householdId: household.id,
        userId: userId,
        role: 'OWNER',
      },
    });

    // Categories are now ENUMs, no need to create them in the database
    // They are available by default via the CategoryName enum

    return household;
  });
}

/**
 * Get or create a personal household for a user
 * Returns the oldest household (personal) if exists, otherwise creates a new one
 * IMPORTANT: Always returns the oldest household by household.createdAt (personal household)
 * This ensures consistency - users always get their personal household, not a shared one
 */
export async function getOrCreatePersonalHousehold(userId: string, email: string) {
  // Find all household memberships and sort by household creation date
  // The oldest household (by createdAt) is the personal one
  const allMemberships = await prisma.householdMember.findMany({
    where: { userId },
    include: { household: true },
  });

  if (allMemberships.length > 0) {
    // Find the oldest household by household.createdAt
    // This ensures we return the personal household (first one created)
    const oldestMembership = allMemberships.reduce((oldest, current) => {
      const oldestDate = new Date(oldest.household.createdAt).getTime();
      const currentDate = new Date(current.household.createdAt).getTime();
      return currentDate < oldestDate ? current : oldest;
    });
    
    return oldestMembership.household;
  }

  return await createPersonalHousehold(userId, email);
}

/**
 * Get pending invites for a user
 */
export async function getPendingInvites(userId: string) {
  return await prisma.householdInvite.findMany({
    where: {
      inviteeId: userId,
      status: 'PENDING',
      expiresAt: {
        gt: new Date(),
      },
    },
    include: {
      household: {
        select: {
          id: true,
          name: true,
          createdAt: true,
        },
      },
      inviter: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}

/**
 * Accept a household invite
 */
export async function acceptInvite(inviteId: string, userId: string) {
  const invite = await prisma.householdInvite.findUnique({
    where: { id: inviteId },
  });

  if (!invite) {
    throw new NotFoundError('Invite');
  }

  if (invite.inviteeId !== userId) {
    throw new BadRequestError('You are not authorized to accept this invite');
  }

  if (invite.status !== 'PENDING') {
    throw new BadRequestError('Invite is not pending');
  }

  if (invite.expiresAt < new Date()) {
    throw new BadRequestError('Invite has expired');
  }

  // Check if already a member
  const existingMember = await prisma.householdMember.findUnique({
    where: {
      householdId_userId: {
        householdId: invite.householdId,
        userId,
      },
    },
  });

  if (existingMember) {
    // User is already a member, just mark invite as accepted
    // Remover outros convites (household_id, email, ACCEPTED) para não violar @@unique([householdId, email, status])
    await prisma.householdInvite.deleteMany({
      where: {
        householdId: invite.householdId,
        email: invite.email,
        status: 'ACCEPTED',
        id: { not: inviteId },
      },
    });
    await prisma.householdInvite.update({
      where: { id: inviteId },
      data: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });
    return existingMember;
  }

  // Accept invite and add member in a transaction
  const member = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // Remover outros convites (household_id, email, ACCEPTED) para não violar @@unique([householdId, email, status])
    await tx.householdInvite.deleteMany({
      where: {
        householdId: invite.householdId,
        email: invite.email,
        status: 'ACCEPTED',
        id: { not: inviteId },
      },
    });
    // Add member
    const newMember = await tx.householdMember.create({
      data: {
        householdId: invite.householdId,
        userId,
        role: invite.role,
      },
      include: {
        user: {
          select: {
            id: true,
            email: true,
            createdAt: true,
          },
        },
      },
    });

    // Update invite status
    await tx.householdInvite.update({
      where: { id: inviteId },
      data: {
        status: 'ACCEPTED',
        acceptedAt: new Date(),
      },
    });

    return newMember;
  });

  // Mark related notification as read (async, don't block - after transaction)
  try {
    const { markNotificationAsRead } = await import('../notifications/notifications.service.js');
    // Find notification by inviteId in metadata
    const notifications = await prisma.notification.findMany({
      where: {
        userId,
        type: 'HOUSEHOLD_INVITE',
      },
    });
    
    // Filter in memory to find notification with matching inviteId in metadata
    const notification = notifications.find(
      (n) => n.metadata && typeof n.metadata === 'object' && 'inviteId' in n.metadata && n.metadata.inviteId === inviteId
    );
    
    if (notification) {
      await markNotificationAsRead(notification.id, userId);
      const meta = (notification.metadata as Record<string, unknown>) || {};
      await prisma.notification.update({
        where: { id: notification.id },
        data: {
          metadata: { ...meta, acceptedByMe: true } as Prisma.InputJsonValue,
        },
      });
    }
  } catch (error) {
    // Log error but don't fail invite acceptance if notification update fails
    console.error('[acceptInvite] Error updating notification:', error);
  }

  return member;
}

/**
 * Reject a household invite
 */
export async function rejectInvite(inviteId: string, userId: string) {
  const invite = await prisma.householdInvite.findUnique({
    where: { id: inviteId },
  });

  if (!invite) {
    throw new NotFoundError('Invite');
  }

  if (invite.inviteeId !== userId) {
    throw new BadRequestError('You are not authorized to reject this invite');
  }

  if (invite.status !== 'PENDING') {
    throw new BadRequestError('Invite is not pending');
  }

  const updatedInvite = await prisma.householdInvite.update({
    where: { id: inviteId },
    data: {
      status: 'REJECTED',
      rejectedAt: new Date(),
    },
  });

  // Mark related notification as archived (async, don't block)
  try {
    const { archiveNotification } = await import('../notifications/notifications.service.js');
    // Find notification by inviteId in metadata (using JSONB query)
    const notifications = await prisma.notification.findMany({
      where: {
        userId,
        type: 'HOUSEHOLD_INVITE',
      },
    });
    
    // Filter in memory to find notification with matching inviteId in metadata
    const notification = notifications.find(
      (n) => n.metadata && typeof n.metadata === 'object' && 'inviteId' in n.metadata && n.metadata.inviteId === inviteId
    );
    
    if (notification) {
      await archiveNotification(notification.id, userId);
    }
  } catch (error) {
    // Log error but don't fail invite rejection if notification update fails
    console.error('[rejectInvite] Error updating notification:', error);
  }

  return updatedInvite;
}

/**
 * Cancel an invite (by inviter)
 */
export async function cancelInvite(inviteId: string, inviterId: string) {
  const invite = await prisma.householdInvite.findUnique({
    where: { id: inviteId },
  });

  if (!invite) {
    throw new NotFoundError('Invite');
  }

  if (invite.inviterId !== inviterId) {
    throw new BadRequestError('You are not authorized to cancel this invite');
  }

  if (invite.status !== 'PENDING') {
    throw new BadRequestError('Invite is not pending');
  }

  const updatedInvite = await prisma.householdInvite.update({
    where: { id: inviteId },
    data: {
      status: 'REJECTED',
      rejectedAt: new Date(),
    },
  });

  // Atualizar a notificação do convidado para exibir "Removido" (convite cancelado por quem convidou)
  try {
    if (invite.inviteeId) {
      const notifications = await prisma.notification.findMany({
        where: { userId: invite.inviteeId, type: 'HOUSEHOLD_INVITE' },
      });
      const notif = notifications.find(
        (n) =>
          n.metadata &&
          typeof n.metadata === 'object' &&
          (n.metadata as Record<string, unknown>).inviteId === inviteId
      );
      if (notif) {
        const meta = (notif.metadata as Record<string, unknown>) || {};
        await prisma.notification.update({
          where: { id: notif.id },
          data: {
            status: 'ARCHIVED',
            archivedAt: new Date(),
            metadata: { ...meta, cancelledByInviter: true } as Prisma.InputJsonValue,
          },
        });
      }
    }
  } catch (e) {
    console.error('[cancelInvite] Error updating notification:', e);
  }

  return updatedInvite;
}

/**
 * Get invites sent by a user for a household
 */
export async function getHouseholdInvites(householdId: string) {
  return await prisma.householdInvite.findMany({
    where: { householdId },
    include: {
      inviter: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
      invitee: {
        select: {
          id: true,
          email: true,
          displayName: true,
        },
      },
    },
    orderBy: {
      createdAt: 'desc',
    },
  });
}





