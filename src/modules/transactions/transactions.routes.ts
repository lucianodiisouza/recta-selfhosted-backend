import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  requireHouseholdMember,
  requireEditor,
  ensurePersonalHousehold,
  getUserByFirebaseUid,
} from '../../shared/middleware/authorization.middleware.js';
import {
  createTransactionSchema,
  updateTransactionSchema,
  transactionIdParamSchema,
  listTransactionsQuerySchema,
  transactionSummaryQuerySchema,
  batchCreateTransactionsSchema,
  batchDeleteTransactionsSchema,
  payInvoiceSchema,
  creditCardInvoiceParamsSchema,
  undoPaymentParamsSchema,
  createTransferSchema,
  createAllocationSchema,
  createDeallocationSchema,
  monthlyRecapQuerySchema,
  heatmapQuerySchema,
} from './transactions.schema.js';
import { updateTransactionSplitSchema } from './transaction-splits.schema.js';
import * as transactionsService from './transactions.service.js';
import { updateKeepingShares } from '../people/shares.service.js';
import * as transactionSplitsService from './transaction-splits.service.js';

export async function transactionRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * GET /transactions
   * List transactions with pagination and filters
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/', {
    schema: {
      description: 'List transactions with pagination and filters',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          limit: { type: 'number', minimum: 1, maximum: 100 },
          cursor: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pagination: {
              type: 'object',
              properties: {
                nextCursor: { type: ['string', 'null'] },
                hasMore: { type: 'boolean' },
                total: { type: 'number' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = listTransactionsQuerySchema.parse(request.query);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const result = await transactionsService.listTransactions({ ...query, householdId });

    return reply.send({
      success: true,
      ...result,
    });
  });

  /**
   * GET /transactions/summary
   * Get income/expense summary for a period
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/summary', {
    schema: {
      description: 'Get income/expense summary for a period',
      tags: ['Transactions'],
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
    const query = transactionSummaryQuerySchema.parse(request.query);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const summary = await transactionsService.getTransactionSummary({ ...query, householdId });

    return reply.send({
      success: true,
      data: summary,
    });
  });

  /**
   * GET /transactions/by-category
   * Get spending breakdown by category
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/by-category', {
    schema: {
      description: 'Get spending breakdown by category',
      tags: ['Transactions'],
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
    const query = transactionSummaryQuerySchema.parse(request.query);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const breakdown = await transactionsService.getSpendingByCategory({ ...query, householdId });

    return reply.send({
      success: true,
      data: breakdown,
    });
  });

  /**
   * GET /transactions/monthly-recap
   * Get monthly recap with insights and statistics
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/monthly-recap', {
    schema: {
      description: 'Get monthly recap with insights and statistics',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
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
    const query = monthlyRecapQuerySchema.parse(request.query);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const recap = await transactionsService.getMonthlyRecap({ 
      householdId, 
      month: query.month 
    });

    return reply.send({
      success: true,
      data: recap,
    });
  });

  /**
   * GET /transactions/heatmap
   * Get daily spending heatmap data for a month
   * Optimized endpoint that returns aggregated spending by day
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/heatmap', {
    schema: {
      description: 'Get daily spending heatmap data for a month (aggregated)',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                month: { type: 'string' },
                data: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      day: { type: 'number' },
                      amount: { type: 'number' },
                    },
                  },
                },
                total: { type: 'number' },
                daysInMonth: { type: 'number' },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = heatmapQuerySchema.parse(request.query);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const heatmapData = await transactionsService.getSpendingHeatmap(
      householdId,
      query.month
    );

    return reply.send({
      success: true,
      data: heatmapData,
    });
  });

  /**
   * POST /transactions
   * Create a new transaction (EDITOR+)
   * If householdId is not provided, creates a personal household automatically
   */
  app.post('/', {
    schema: {
      description: 'Create a new transaction (EDITOR+)',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          amount: { type: 'number' },
          category: { type: 'string' },
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
    const input = createTransactionSchema.parse(request.body);
    
    // Get authenticated user
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = input.householdId || await ensurePersonalHousehold(request);
    
    // Verify user has access to the household
    await requireEditor(request, householdId);

    // Pass userId to allow using personal accounts in shared household
    const transaction = await transactionsService.createTransaction({
      ...input,
      householdId,
    }, user.id);

    return reply.status(201).send({
      success: true,
      data: transaction,
    });
  });

  /**
   * POST /transactions/batch
   * Create multiple transactions at once (EDITOR+)
   * If householdId is not provided, creates a personal household automatically
   */
  app.post('/batch', {
    schema: {
      description: 'Create multiple transactions at once (EDITOR+)',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          transactions: { type: 'array', items: { type: 'object' } },
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
    const input = batchCreateTransactionsSchema.parse(request.body);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = input.householdId || await ensurePersonalHousehold(request);
    
    // Verify user has access to the household
    await requireEditor(request, householdId);

    const result = await transactionsService.batchCreateTransactions({
      ...input,
      householdId,
    });

    return reply.status(201).send({
      success: true,
      data: result,
    });
  });

  /**
   * DELETE /transactions/batch
   * Delete multiple transactions at once (EDITOR+)
   */
  app.delete('/batch', {
    schema: {
      description: 'Delete multiple transactions at once (EDITOR+)',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          transactionIds: { type: 'array', items: { type: 'string' } },
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
    const input = batchDeleteTransactionsSchema.parse(request.body);
    await requireEditor(request, input.householdId);

    const result = await transactionsService.batchDeleteTransactions(input);

    return reply.send({
      success: true,
      data: result,
    });
  });

  /**
   * GET /transactions/:transactionId
   * Get transaction details
   */
  app.get<{ Params: { transactionId: string } }>(
    '/:transactionId',
    {
      schema: {
        description: 'Get transaction details',
        tags: ['Transactions'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['transactionId'],
          properties: {
            transactionId: { type: 'string', format: 'uuid' },
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
      const { transactionId } = transactionIdParamSchema.parse(request.params);
      const transaction = await transactionsService.getTransaction(transactionId);

      // Verify user has access to the household
      await requireHouseholdMember(request, transaction.householdId);

      return reply.send({
        success: true,
        data: transaction,
      });
    }
  );

  /**
   * PATCH /transactions/:transactionId
   * Update transaction (EDITOR+)
   */
  app.patch<{ Params: { transactionId: string } }>(
    '/:transactionId',
    {
      schema: {
        description: 'Update transaction (EDITOR+)',
        tags: ['Transactions'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['transactionId'],
          properties: {
            transactionId: { type: 'string', format: 'uuid' },
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
      const { transactionId } = transactionIdParamSchema.parse(request.params);
      const input = updateTransactionSchema.parse(request.body);

      // Get transaction to verify household access
      const existingTransaction = await transactionsService.getTransaction(transactionId);
      await requireEditor(request, existingTransaction.householdId);

      // Shares of other people must keep fitting the transaction (route-level: internal flows are not blocked)
      const transaction = await updateKeepingShares(
        existingTransaction.householdId,
        transactionId,
        existingTransaction,
        input,
        () => transactionsService.updateTransaction(transactionId, existingTransaction.householdId, input),
      );

      return reply.send({
        success: true,
        data: transaction,
      });
    }
  );

  /**
   * DELETE /transactions/:transactionId
   * Delete transaction (EDITOR+)
   */
  app.delete<{ Params: { transactionId: string } }>(
    '/:transactionId',
    {
      schema: {
        description: 'Delete transaction (EDITOR+)',
        tags: ['Transactions'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['transactionId'],
          properties: {
            transactionId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          204: { type: 'null' },
        },
      },
    },
    async (request, reply) => {
      const { transactionId } = transactionIdParamSchema.parse(request.params);

      // Get transaction to verify household access
      const existingTransaction = await transactionsService.getTransaction(transactionId);
      await requireEditor(request, existingTransaction.householdId);

      await transactionsService.deleteTransaction(transactionId, existingTransaction.householdId);

      return reply.status(204).send();
    }
  );

  // ============================================================================
  // CREDIT CARD INVOICE ROUTES
  // ============================================================================

  /**
   * GET /transactions/credit-cards/:accountId/invoice/:month
   * Get credit card invoice details for a specific month
   * Format: month = "YYYY-MM"
   */
  app.get<{ Params: { accountId: string; month: string } }>(
    '/credit-cards/:accountId/invoice/:month',
    {
      schema: {
        description: 'Get credit card invoice details for a specific month',
        tags: ['Transactions'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['accountId', 'month'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
          },
        },
        querystring: {
          type: 'object',
          properties: {
            householdId: { type: 'string', format: 'uuid' },
            limit: { type: 'number', minimum: 1, maximum: 100 },
            cursor: { type: 'string' },
          },
        },
        response: {
         200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
              pagination: {
                type: 'object',
                properties: {
                  nextCursor: { type: ['string', 'null'] },
                  hasMore: { type: 'boolean' },
                  total: { type: 'number' },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const params = creditCardInvoiceParamsSchema.parse(request.params);
      const query = request.query as any;
      
      // If no householdId provided, ensure user has a personal household
      const householdId = query.householdId || await ensurePersonalHousehold(request);
      
      await requireHouseholdMember(request, householdId);

      const invoice = await transactionsService.calculateCreditCardInvoice(
        params.accountId,
        params.month,
        householdId,
        {
          limit: query.limit ? Number(query.limit) : undefined,
          cursor: query.cursor,
        }
      );

      return reply.send({
        success: true,
        data: invoice.data,
        pagination: invoice.pagination,
      });
    }
  );

  /**
   * POST /transactions/credit-cards/:accountId/pay-invoice
   * Pay credit card invoice for a specific month
   */
  app.post<{ Params: { accountId: string } }>(
    '/credit-cards/:accountId/pay-invoice',
    {
      schema: {
        description: 'Pay credit card invoice for a specific month',
        tags: ['Transactions'],
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
          required: ['sourceAccountId', 'month'],
          properties: {
            sourceAccountId: { type: 'string', format: 'uuid' },
            amount: { type: 'number' },
            month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
            description: { type: 'string' },
            householdId: { type: 'string', format: 'uuid' },
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
    },
    async (request, reply) => {
      const { accountId } = request.params;
      const body = payInvoiceSchema.parse({
        ...(request.body as any),
        accountId, // Add accountId from params
      });
      
      // If no householdId provided, ensure user has a personal household
      const householdId = body.householdId || await ensurePersonalHousehold(request);
      
      await requireEditor(request, householdId);

      const result = await transactionsService.payCreditCardInvoice({
        ...body,
        accountId,
        householdId,
      });

      return reply.status(201).send({
        success: true,
        data: result,
      });
    }
  );

  /**
   * DELETE /transactions/credit-cards/:accountId/undo-payment/:transactionId
   * Undo a credit card invoice payment
   */
  app.delete<{ Params: { accountId: string; transactionId: string } }>(
    '/credit-cards/:accountId/undo-payment/:transactionId',
    {
      schema: {
        description: 'Undo a credit card invoice payment',
        tags: ['Transactions'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['accountId', 'transactionId'],
          properties: {
            accountId: { type: 'string', format: 'uuid' },
            transactionId: { type: 'string', format: 'uuid' },
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
      const params = undoPaymentParamsSchema.parse(request.params);
      
      // Get transaction to verify household access
      const paymentTransaction = await transactionsService.getTransaction(params.transactionId);
      await requireEditor(request, paymentTransaction.householdId);

      const result = await transactionsService.undoCreditCardPayment(
        params,
        paymentTransaction.householdId
      );

      return reply.send({
        success: true,
        data: result,
      });
    }
  );

  // ============================================================================
  // TRANSFER ROUTES
  // ============================================================================

  /**
   * POST /transactions/transfers
   * Create a transfer between accounts (EDITOR+)
   * If householdId is not provided, uses personal household automatically
   */
  app.post('/transfers', {
    schema: {
      description: 'Create a transfer between accounts (EDITOR+)',
      tags: ['Transactions'],
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
    const input = createTransferSchema.parse(request.body);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = input.householdId || await ensurePersonalHousehold(request);
    
    // Verify user has access to the household
    await requireEditor(request, householdId);

    const transaction = await transactionsService.createTransfer({
      ...input,
      householdId,
    });

    return reply.status(201).send({
      success: true,
      data: transaction,
    });
  });

  // ============================================================================
  // ALLOCATION ROUTES
  // ============================================================================

  /**
   * POST /transactions/allocations
   * Allocate balance to credit card limit (EDITOR+)
   * If householdId is not provided, uses personal household automatically
   */
  app.post('/allocations', {
    schema: {
      description: 'Allocate balance to credit card limit (EDITOR+)',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          accountId: { type: 'string', format: 'uuid' },
          creditCardId: { type: 'string', format: 'uuid' },
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
    const input = createAllocationSchema.parse(request.body);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = input.householdId || await ensurePersonalHousehold(request);
    
    // Verify user has access to the household
    await requireEditor(request, householdId);

    const transaction = await transactionsService.createAllocation({
      ...input,
      householdId,
    });

    return reply.status(201).send({
      success: true,
      data: transaction,
    });
  });

  /**
   * POST /transactions/deallocations
   * Deallocate balance from credit card limit (EDITOR+)
   * If householdId is not provided, uses personal household automatically
   */
  app.post('/deallocations', {
    schema: {
      description: 'Deallocate balance from credit card limit (EDITOR+)',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          accountId: { type: 'string', format: 'uuid' },
          creditCardId: { type: 'string', format: 'uuid' },
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
    const input = createDeallocationSchema.parse(request.body);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = input.householdId || await ensurePersonalHousehold(request);
    
    // Verify user has access to the household
    await requireEditor(request, householdId);

    const transaction = await transactionsService.createDeallocation({
      ...input,
      householdId,
    });

    return reply.status(201).send({
      success: true,
      data: transaction,
    });
  });

  /**
   * GET /transactions/:transactionId/splits
   * Get splits for a transaction
   */
  app.get<{ Params: { transactionId: string } }>(
    '/:transactionId/splits',
    {
      schema: {
        description: 'Get transaction splits',
        tags: ['Transactions'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['transactionId'],
          properties: {
            transactionId: { type: 'string', format: 'uuid' },
          },
        },
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
              data: { type: 'array', items: { type: 'object', additionalProperties: true } },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { transactionId } = transactionIdParamSchema.parse(request.params);
      
      // Get householdId from query or use personal household
      const queryParams = request.query as { householdId?: string } | undefined;
      const queryHouseholdId = queryParams?.householdId;
      const householdId = queryHouseholdId || await ensurePersonalHousehold(request);
      
      // Verify user is a member of the household
      await requireHouseholdMember(request, householdId);

      const splits = await transactionSplitsService.getTransactionSplits(transactionId, householdId);

      return reply.send({
        success: true,
        data: splits,
      });
    }
  );

  /**
   * PATCH /transactions/splits/:splitId
   * Update a transaction split (mark as paid/unpaid)
   * Users can only update their own splits
   */
  app.patch<{ Params: { splitId: string } }>(
    '/splits/:splitId',
    {
      schema: {
        description: 'Update transaction split (mark as paid/unpaid)',
        tags: ['Transactions'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['splitId'],
          properties: {
            splitId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          required: ['paid'],
          properties: {
            paid: { type: 'boolean' },
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
      const { splitId } = request.params;
      const authUser = getAuthUser(request);
      const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
      
      const input = updateTransactionSplitSchema.parse(request.body);

      const split = await transactionSplitsService.updateTransactionSplit(splitId, user.id, input);

      return reply.send({
        success: true,
        data: split,
      });
    }
  );
}






