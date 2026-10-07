import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import { findExistingUser, getUserByFirebaseUid } from '../../shared/middleware/authorization.middleware.js';
import { NotFoundError } from '../../shared/errors/index.js';
import {
  getUserById,
  updateUserPreferences,
  getOrCreateReferralCode,
  deleteUser,
  resetUserData,
} from './users.service.js';
import { updateUserPreferencesSchema } from './users.schema.js';
import { getReferralCount } from './referrals.service.js';

export async function userRoutes(app: FastifyInstance) {
  /**
   * GET /users/me
   * Get current user info and preferences
   */
  app.get(
    '/me',
    {
      schema: {
        description: 'Get current user info and preferences',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      preHandler: authMiddleware(),
    },
    async (request, reply) => {
      const authUser = getAuthUser(request);
      const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

      return reply.send({
        success: true,
        data: user,
      });
    }
  );

  /**
   * PUT /users/me/preferences
   * Update user preferences
   */
  app.put(
    '/me/preferences',
    {
      schema: {
        description: 'Update user preferences',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            currency: { type: 'string' },
            language: { type: 'string' },
            timezone: { type: 'string' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
      preHandler: authMiddleware(),
    },
    async (request, reply) => {
      const authUser = getAuthUser(request);
      const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
      const input = updateUserPreferencesSchema.parse(request.body);

      const updated = await updateUserPreferences(user.id, input);

      return reply.send({
        success: true,
        data: updated,
      });
    }
  );

  /**
   * GET /users/me/referral-code
   * Get or create referral code and count for current user
   */
  app.get(
    '/me/referral-code',
    {
      schema: {
        description: 'Get or create referral code and count for current user',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  referralCode: { type: 'string' },
                  referralCount: { type: 'number' },
                },
              },
            },
          },
        },
      },
      preHandler: authMiddleware(),
    },
    async (request, reply) => {
      const authUser = getAuthUser(request);
      const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
      const referralCode = await getOrCreateReferralCode(user.id);
      const referralCount = await getReferralCount(user.id);

      return reply.send({
        success: true,
        data: {
          referralCode,
          referralCount,
        },
      });
    }
  );

  /**
   * POST /users/me/reset
   * Reset user account - delete all data but keep user (for starting fresh)
   */
  app.post(
    '/me/reset',
    {
      schema: {
        description: 'Reset user account - delete all data but keep user. This will delete all households where the user is the only member, along with all accounts, transactions, budgets, savings goals, and recurring transactions. For households with other members, only the user membership will be removed. The user will remain in the database and Firebase Auth, but onboarding will be reset.',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
        },
      },
      preHandler: authMiddleware(),
    },
    async (request, reply) => {
      const authUser = getAuthUser(request);
      const user = await findExistingUser(authUser.uid);
      
      if (!user) {
        throw new NotFoundError('User');
      }
      
      await resetUserData(user.id);

      return reply.send({
        success: true,
        message: 'User account reset successfully',
      });
    }
  );

  /**
   * DELETE /users/me
   * Delete current user and all related data (cascade deletion)
   */
  app.delete(
    '/me',
    {
      schema: {
        description: 'Delete current user and all related data. This will delete all households where the user is the only member, along with all accounts, transactions, budgets, savings goals, and recurring transactions. For households with other members, only the user membership will be removed.',
        tags: ['Users'],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              message: { type: 'string' },
            },
          },
        },
      },
      preHandler: authMiddleware(),
    },
    async (request, reply) => {
      const authUser = getAuthUser(request);
      const user = await findExistingUser(authUser.uid);
      
      if (!user) {
        throw new NotFoundError('User');
      }
      
      await deleteUser(user.id);

      return reply.send({
        success: true,
        message: 'User and all related data deleted successfully',
      });
    }
  );
}



