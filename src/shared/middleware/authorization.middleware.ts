import type { FastifyRequest } from 'fastify';
import type { HouseholdRole, Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../db/prisma.js';
import { ForbiddenError, NotFoundError, InsufficientRoleError, UnauthorizedError } from '../errors/index.js';
import { getAuthUser } from './auth.middleware.js';
import { isLocalAuth } from '../config/env.js';
import * as householdsService from '../../modules/households/households.service.js';

/**
 * Household membership context
 */
export interface HouseholdMembership {
  memberId: string;
  householdId: string;
  userId: string;
  role: HouseholdRole;
}

/**
 * Role hierarchy for permission checks
 * Higher number = more permissions
 */
const ROLE_HIERARCHY: Record<HouseholdRole, number> = {
  VIEWER: 1,
  EDITOR: 2,
  OWNER: 3,
};

/**
 * Check if a role has at least the required level
 */
function hasRoleLevel(userRole: HouseholdRole, requiredRole: HouseholdRole): boolean {
  return ROLE_HIERARCHY[userRole] >= ROLE_HIERARCHY[requiredRole];
}

/**
 * Look up the signed-in user without creating one (reset and delete must not create a user just to remove it).
 * In local mode the token subject is the user id; in Firebase mode it is the Firebase UID.
 */
export async function findExistingUser(uid: string) {
  return prisma.user.findUnique({
    where: isLocalAuth ? { id: uid } : { firebaseUid: uid },
    select: { id: true },
  });
}

/**
 * Get user's database record from Firebase UID
 * Creates user if doesn't exist (for first login)
 * Handles case where user exists with same email but different firebaseUid
 *
 * In local auth mode the caller passes the user id (uuid) as firebaseUid: the lookup is by id only, and it
 * never creates a user or sets firebaseUid, which stays null for local users. The password hash is omitted
 * from every returned row.
 */
export async function getUserByFirebaseUid(firebaseUid: string, email: string) {
  if (isLocalAuth) {
    const user = await prisma.user.findUnique({
      where: { id: firebaseUid },
      omit: { passwordHash: true },
    });
    if (!user) {
      throw new UnauthorizedError('User not found');
    }
    return user;
  }
  // Validate email - must be a non-empty string
  if (!email || email.trim() === '') {
    throw new Error('Email is required to create user');
  }

  const trimmedEmail = email.trim();

  // First, try to find user by firebaseUid
  let user = await prisma.user.findUnique({
    where: { firebaseUid },
    omit: { passwordHash: true },
  });

  if (user) {
    return user;
  }

  // If not found by firebaseUid, check if user exists with same email
  // This can happen if Firebase UID changed or there's data inconsistency
  const existingUserByEmail = await prisma.user.findUnique({
    where: { email: trimmedEmail },
    select: { id: true },
  });

  if (existingUserByEmail) {
    // Update the existing user's firebaseUid to match current Firebase auth
    // This handles cases where Firebase UID changed or was updated
    user = await prisma.user.update({
      where: { id: existingUserByEmail.id },
      data: { firebaseUid },
      omit: { passwordHash: true },
    });
    return user;
  }

  // User doesn't exist, create new one
  user = await prisma.user.create({
    data: {
      firebaseUid,
      email: trimmedEmail,
    },
    omit: { passwordHash: true },
  });

  return user;
}

/**
 * Get household membership for the current user
 * Returns null if user is not a member
 */
export async function getHouseholdMembership(
  userId: string,
  householdId: string
): Promise<HouseholdMembership | null> {
  const member = await prisma.householdMember.findUnique({
    where: {
      householdId_userId: {
        householdId,
        userId,
      },
    },
  });

  if (!member) {
    return null;
  }

  return {
    memberId: member.id,
    householdId: member.householdId,
    userId: member.userId,
    role: member.role,
  };
}

/**
 * Require user to be a member of the specified household
 * Throws ForbiddenError if not a member
 */
export async function requireHouseholdMember(
  request: FastifyRequest,
  householdId: string
): Promise<HouseholdMembership> {
  const authUser = getAuthUser(request);
  const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

  // Verify household exists
  const household = await prisma.household.findUnique({
    where: { id: householdId },
    select: { id: true },
  });

  if (!household) {
    // Return generic "not found" to prevent enumeration
    throw new NotFoundError('Household');
  }

  // Check membership
  const membership = await getHouseholdMembership(user.id, householdId);
  if (!membership) {
    // Return generic "access denied" - don't reveal if household exists
    throw new ForbiddenError();
  }

  return membership;
}

/**
 * Require user to have at least the specified role in the household
 * Checks role hierarchy: OWNER > EDITOR > VIEWER
 */
export async function requireRole(
  request: FastifyRequest,
  householdId: string,
  requiredRole: HouseholdRole
): Promise<HouseholdMembership> {
  const membership = await requireHouseholdMember(request, householdId);

  if (!hasRoleLevel(membership.role, requiredRole)) {
    throw new InsufficientRoleError();
  }

  return membership;
}

/**
 * Require user to be the OWNER of the household
 */
export async function requireOwner(
  request: FastifyRequest,
  householdId: string
): Promise<HouseholdMembership> {
  return requireRole(request, householdId, 'OWNER');
}

/**
 * Require user to be at least an EDITOR
 */
export async function requireEditor(
  request: FastifyRequest,
  householdId: string
): Promise<HouseholdMembership> {
  return requireRole(request, householdId, 'EDITOR');
}

/**
 * Get user's accessible households
 */
export async function getUserHouseholds(userId: string) {
  const memberships = await prisma.householdMember.findMany({
    where: { userId },
    include: {
      household: true,
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  return memberships
    .map((m: Prisma.HouseholdMemberGetPayload<{ include: { household: true } }>) => {
      const household = m.household;
      if (!household || !household.id) {
        console.warn('[getUserHouseholds] Invalid household in membership:', { memberId: m.id, household });
        return null;
      }
      return {
        id: household.id,
        name: household.name,
        createdAt: household.createdAt,
        updatedAt: household.updatedAt,
        role: m.role,
        joinedAt: m.createdAt,
      };
    })
    .filter((h): h is NonNullable<typeof h> => h !== null);
}

/**
 * Ensure user has a personal household, creating one if needed
 * Returns the household ID
 */
export async function ensurePersonalHousehold(request: FastifyRequest): Promise<string> {
  const authUser = getAuthUser(request);
  const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

  const household = await householdsService.getOrCreatePersonalHousehold(user.id, user.email);
  return household.id;
}






