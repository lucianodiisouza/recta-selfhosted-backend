import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  requireHouseholdMember,
  requireEditor,
  ensurePersonalHousehold,
  getUserByFirebaseUid,
} from '../../shared/middleware/authorization.middleware.js';
import { BadRequestError } from '../../shared/errors/index.js';
import {
  createAccountSchema,
  updateAccountSchema,
  accountIdParamSchema,
  listAccountsQuerySchema,
  transferSchema,
  adjustBalanceSchema,
} from './accounts.schema.js';
import * as accountsService from './accounts.service.js';

export async function accountRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * GET /accounts
   * List accounts for a household
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/', {
    schema: {
      description: 'List accounts for a household',
      tags: ['Accounts'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            // IMPORTANT: allow data payload fields through Fastify serializer
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = listAccountsQuerySchema.parse(request.query);
    
    // Get authenticated user
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const result = await accountsService.listAccounts({ ...query, householdId }, user.id);

    return reply.send({
      success: true,
      data: result,
    });
  });

  /**
   * GET /accounts/available
   * List available accounts for creating a transaction in a household
   * Returns accounts from the household + personal accounts (if in shared household)
   */
  app.get('/available', {
    schema: {
      description: 'List available accounts for creating a transaction (includes personal accounts in shared households)',
      tags: ['Accounts'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          includeInactive: { type: 'boolean' },
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
  }, async (request, reply) => {
    const query = listAccountsQuerySchema.parse(request.query);
    
    // Get authenticated user
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    
    // householdId is required for this endpoint
    if (!query.householdId) {
      throw new BadRequestError('householdId is required');
    }
    
    await requireHouseholdMember(request, query.householdId);

    const result = await accountsService.listAvailableAccounts(
      query.householdId,
      user.id,
      query.includeInactive
    );

    return reply.send({
      success: true,
      data: result,
    });
  });

  /**
   * GET /accounts/summary
   * Get account summary for a household
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/summary', {
    schema: {
      description: 'Get account summary for a household',
      tags: ['Accounts'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
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
  }, async (request, reply) => {
    const query = listAccountsQuerySchema
      .pick({ householdId: true })
      .parse(request.query);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const summary = await accountsService.getAccountsSummary(householdId);

    return reply.send({
      success: true,
      data: summary,
    });
  });

  /**
   * POST /accounts
   * Create a new account (EDITOR+)
   * If householdId is not provided, creates a personal household automatically
   */
  app.post('/', {
    schema: {
      description: 'Create a new account (EDITOR+)',
      tags: ['Accounts'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          balance: { type: 'number' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = createAccountSchema.parse(request.body);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = input.householdId || await ensurePersonalHousehold(request);
    
    // Verify user has access to the household
    await requireEditor(request, householdId);

    const account = await accountsService.createAccount({
      ...input,
      householdId,
    });

    return reply.status(201).send({
      success: true,
      data: account,
    });
  });

  /**
   * GET /accounts/:accountId
   * Get account details
   */
  app.get<{ Params: { accountId: string } }>(
    '/:accountId',
    {
      schema: {
        description: 'Get account details',
        tags: ['Accounts'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
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
    },
    async (request, reply) => {
      const { accountId } = accountIdParamSchema.parse(request.params);
      const account = await accountsService.getAccount(accountId);

      // Verify user has access to the household
      await requireHouseholdMember(request, account.householdId);

      return reply.send({
        success: true,
        data: account,
      });
    }
  );

  /**
   * PATCH /accounts/:accountId
   * Update account (EDITOR+)
   */
  app.patch<{ Params: { accountId: string } }>(
    '/:accountId',
    {
      schema: {
        description: 'Update account (EDITOR+)',
        tags: ['Accounts'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
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
    },
    async (request, reply) => {
      const { accountId } = accountIdParamSchema.parse(request.params);
      const input = updateAccountSchema.parse(request.body);

      // Get account to verify household access
      const existingAccount = await accountsService.getAccount(accountId);
      await requireEditor(request, existingAccount.householdId);

      const account = await accountsService.updateAccount(accountId, existingAccount.householdId, input);

      return reply.send({
        success: true,
        data: account,
      });
    }
  );

  /**
   * DELETE /accounts/:accountId
   * Delete account permanently from database (EDITOR+)
   */
  app.delete<{ Params: { accountId: string }; Querystring: { deleteTransactions?: boolean } }>(
    '/:accountId',
    {
      schema: {
        description: 'Delete account permanently from database (EDITOR+)',
        tags: ['Accounts'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            deleteTransactions: {
              type: 'boolean',
              default: false,
              description: 'Also permanently delete every transaction linked to this account',
            },
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
    },
    async (request, reply) => {
      const { accountId } = accountIdParamSchema.parse(request.params);
      const deleteTransactions = request.query.deleteTransactions === true;

      // Get account to verify household access
      const existingAccount = await accountsService.getAccount(accountId);
      await requireEditor(request, existingAccount.householdId);

      const result = await accountsService.deleteAccount(accountId, deleteTransactions);

      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  /**
   * POST /accounts/transfer
   * Transfer money between accounts (EDITOR+)
   */
  app.post('/transfer', {
    schema: {
      description: 'Transfer money between accounts (EDITOR+)',
      tags: ['Accounts'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          fromAccountId: { type: 'string', format: 'uuid' },
          toAccountId: { type: 'string', format: 'uuid' },
          amount: { type: 'number' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = transferSchema.parse(request.body);

    // Get source account to get household
    const fromAccount = await accountsService.getAccount(input.fromAccountId);
    await requireEditor(request, fromAccount.householdId);

    const result = await accountsService.transferBetweenAccounts(
      fromAccount.householdId,
      input
    );

    return reply.status(201).send({
      success: true,
      data: result,
    });
  });

  /**
   * POST /accounts/:accountId/adjust-balance
   * Manually adjust account balance (EDITOR+)
   */
  app.post<{ Params: { accountId: string } }>(
    '/:accountId/adjust-balance',
    {
      schema: {
        description: 'Manually adjust account balance (EDITOR+)',
        tags: ['Accounts'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['accountId'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['newBalance'],
          properties: {
            // No `type` here: Ajv would coerce null/false to 0 before zod runs. adjustBalanceSchema validates it.
            newBalance: { description: 'Target balance: a number or a numeric string with at most two decimals' },
            date: { type: 'string', description: 'YYYY-MM-DD, not in the future (default: today)' },
            reason: { type: 'string' },
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
    },
    async (request, reply) => {
      const { accountId } = accountIdParamSchema.parse(request.params);
      const input = adjustBalanceSchema.parse(request.body);

      // Get account to verify household access
      const existingAccount = await accountsService.getAccount(accountId);
      await requireEditor(request, existingAccount.householdId);

      const result = await accountsService.adjustBalance(
        accountId,
        existingAccount.householdId,
        input
      );

      return reply.send({
        success: true,
        data: result,
      });
    }
  );
}






