import type { FastifyInstance, FastifyRequest } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  getUserByFirebaseUid,
  getUserHouseholds,
} from '../../shared/middleware/authorization.middleware.js';
import { getOrCreatePersonalHousehold } from '../households/households.service.js';
import { processReferralCode } from '../users/referrals.service.js';
import { prisma } from '../../shared/db/prisma.js';
import { env, isLocalAuth } from '../../shared/config/env.js';
import { PASSWORD_MAX_BYTES, discardRegisteredUser, login, register } from './local.service.js';

const errorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

const credentialsBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  properties: {
    // The email format and the 72-byte password limit are checked by local.service (zod), after the email is
    // trimmed and lowercased; the lengths here are the cheap upper bounds (a character is at least one byte).
    email: { type: 'string', maxLength: 254 },
    password: { type: 'string', minLength: 8, maxLength: PASSWORD_MAX_BYTES },
  },
} as const;

// Credential routes are the one place a password can be guessed, so they get their own, tighter limit per IP
// (the global limit is far higher). Behind a reverse proxy, trustProxy makes the IP the proxy's X-Forwarded-For.
const credentialsRateLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } } as const;

export async function authRoutes(app: FastifyInstance) {
  /**
   * GET /auth/me
   * Get current user info
   * Returns user's households (if any)
   */
  app.get(
    '/me',
    {
      schema: {
        description: 'Get current authenticated user info',
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  email: { type: 'string', format: 'email' },
                  firebaseUid: { type: ['string', 'null'] },
                  createdAt: { type: 'string', format: 'date-time' },
                  households: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', format: 'uuid' },
                        name: { type: 'string' },
                        role: { type: 'string' },
                        joinedAt: { type: 'string', format: 'date-time' },
                        createdAt: { type: 'string', format: 'date-time' },
                        updatedAt: { type: 'string', format: 'date-time' },
                      },
                      // IMPORTANT: without declaring properties (or allowing additionalProperties),
                      // Fastify's serializer may strip fields and return `{}` objects.
                      additionalProperties: true,
                    },
                  },
                },
              },
            },
          },
          401: errorResponseSchema,
        },
      },
      preHandler: authMiddleware(),
    },
    async (request, reply) => {
      const authUser = getAuthUser(request);
      const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

      // Get user's households (may be empty)
      const households = await getUserHouseholds(user.id);

      return reply.send({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          firebaseUid: user.firebaseUid,
          createdAt: user.createdAt,
          households,
        },
      });
    }
  );

  /**
   * POST /auth/sync
   * Sync Firebase user with database
   * Called after successful Firebase authentication
   * Optionally accepts referralCode in body to process referral
   */
  app.post(
    '/sync',
    {
      schema: {
        description: 'Sync Firebase user with database. Called after successful Firebase authentication. Optionally accepts referralCode in body.',
        tags: ['Auth'],
        security: [{ bearerAuth: [] }],
        body: {
          type: 'object',
          properties: {
            referralCode: { type: 'string', maxLength: 20 },
          },
          // Allow empty object when no referralCode is provided
          additionalProperties: false,
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  email: { type: 'string', format: 'email' },
                  emailVerified: { type: 'boolean' },
                  createdAt: { type: 'string', format: 'date-time' },
                  householdId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
          401: errorResponseSchema,
        },
      },
      preHandler: authMiddleware({ requireEmailVerified: false }),
    },
    async (request, reply) => {
      const authUser = getAuthUser(request);
      const body = request.body as { referralCode?: string } | undefined;
      const referralCode = body?.referralCode;

      // Create or get user
      const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

      // Process referral code if provided (only for users without existing referral record)
      // The processReferralCode function already handles duplicate checks and validation
      if (referralCode) {
        // Check if user already has a referral record
        const existingReferral = await prisma.referral.findUnique({
          where: {
            referredId: user.id,
          },
        });

        // Process referral if user doesn't have one yet
        // Also check if user was created recently (within 5 minutes) to avoid processing for very old users
        const hasNoReferralRecord = !existingReferral;
        const wasCreatedRecently = user.createdAt && 
          new Date().getTime() - new Date(user.createdAt).getTime() < 300000; // 5 minutes threshold
        
        if (hasNoReferralRecord && wasCreatedRecently) {
          try {
            console.log(`[Referral] Processing referral code ${referralCode} for user ${user.id}`);
            const referrerId = await processReferralCode(referralCode, user.id);
            if (referrerId) {
              console.log(`[Referral] Successfully processed referral: ${referrerId} -> ${user.id}`);
            } else {
              console.log(`[Referral] Referral code ${referralCode} is invalid or already processed`);
            }
          } catch (error) {
            // Log error but don't fail signup - referral is not critical
            console.error('[Referral] Error processing referral code:', error);
          }
        } else {
          if (existingReferral) {
            console.log(`[Referral] User ${user.id} already has a referral record (referrer: ${existingReferral.referrerId}), skipping`);
          } else if (!wasCreatedRecently) {
            console.log(`[Referral] User ${user.id} was created more than 5 minutes ago, skipping referral processing`);
          }
        }
      }

      // Create personal household automatically if it doesn't exist
      // This ensures users always have a household from the first login
      const household = await getOrCreatePersonalHousehold(user.id, user.email);

      return reply.send({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          emailVerified: authUser.emailVerified,
          createdAt: user.createdAt,
          householdId: household.id, // Return household ID so frontend can save it
        },
      });
    }
  );

  /**
   * POST /auth/register
   * Register with email + password (local auth mode only)
   */
  app.post(
    '/register',
    {
      config: credentialsRateLimit,
      schema: {
        description: 'Register a new user with email and password. Only available when AUTH_MODE=local.',
        tags: ['Auth'],
        body: credentialsBodySchema,
        response: {
          201: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  id: { type: 'string', format: 'uuid' },
                  email: { type: 'string', format: 'email' },
                  householdId: { type: 'string', format: 'uuid' },
                },
              },
            },
          },
          400: errorResponseSchema,
          403: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!isLocalAuth) {
        return reply.code(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Local registration is not available in firebase auth mode' },
        });
      }

      if (!env.AUTH_ALLOW_REGISTRATION) {
        return reply.code(403).send({
          success: false,
          error: { code: 'REGISTRATION_DISABLED', message: 'Registration is disabled on this server' },
        });
      }

      const body = request.body as { email: string; password: string };
      const user = await register(body.email, body.password);

      // The household helper does not take a transaction, so undo the registration if it fails: a user without a
      // household could sign in but could not use the app, and could never register again (the email is taken).
      let household;
      try {
        household = await getOrCreatePersonalHousehold(user.id, user.email);
      } catch (error) {
        // Best effort: if the cleanup fails too, the original error is the one worth reporting.
        await discardRegisteredUser(user.id).catch(() => undefined);
        throw error;
      }

      return reply.code(201).send({
        success: true,
        data: {
          id: user.id,
          email: user.email,
          householdId: household.id,
        },
      });
    }
  );

  /**
   * POST /auth/login
   * Login with email + password (local auth mode only)
   */
  app.post(
    '/login',
    {
      config: credentialsRateLimit,
      schema: {
        description: 'Login with email and password. Only available when AUTH_MODE=local.',
        tags: ['Auth'],
        body: credentialsBodySchema,
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  token: { type: 'string' },
                  id: { type: 'string', format: 'uuid' },
                  email: { type: 'string', format: 'email' },
                },
              },
            },
          },
          401: errorResponseSchema,
          404: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      if (!isLocalAuth) {
        return reply.code(404).send({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Local login is not available in firebase auth mode' },
        });
      }

      const body = request.body as { email: string; password: string };
      const { user, token } = await login(body.email, body.password);

      return reply.send({
        success: true,
        data: {
          token,
          id: user.id,
          email: user.email,
        },
      });
    }
  );

  /**
   * GET /auth/config
   * Public auth-mode discovery for dual-mode frontend
   */
  app.get(
    '/config',
    {
      schema: {
        description: 'Get auth mode configuration. Used by the frontend to select local or firebase auth flow.',
        tags: ['Auth'],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  authMode: { type: 'string', enum: ['local', 'firebase'] },
                  firebaseWebApiKey: { type: ['string', 'null'] },
                  registrationEnabled: { type: 'boolean' },
                },
              },
            },
          },
        },
      },
    },
    async (_request: FastifyRequest, reply) => {
      return reply.send({
        success: true,
        data: {
          authMode: env.AUTH_MODE,
          firebaseWebApiKey: env.AUTH_FIREBASE_WEB_API_KEY ?? null,
          registrationEnabled: !isLocalAuth || env.AUTH_ALLOW_REGISTRATION,
        },
      });
    }
  );
}






