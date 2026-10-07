import type { FastifyError, FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  requireEditor,
  getUserByFirebaseUid,
} from '../../shared/middleware/authorization.middleware.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { getAccount } from '../accounts/accounts.service.js';
import {
  parseImportBuffer,
  buildImportPreview,
  confirmImport,
  MAX_IMPORT_ROWS,
} from './import.service.js';
import { MAX_CENTS, MAX_DESCRIPTION_LENGTH, buildUtcDate } from './parsers/statement.common.js';

/** Multipart limits for the statement upload; the app registers the plugin with them. */
export const IMPORT_MULTIPART_LIMITS = {
  fileSize: 5 * 1024 * 1024,
  files: 1,
  fields: 4,
  fieldSize: 1024,
  parts: 6,
} as const;

// Error shape mirrors auth.routes.ts `errorResponseSchema`
// ({ success, error: { code, message } }) and the central error-handler output.
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

const previewRowSchema = {
  type: 'object',
  properties: {
    index: { type: 'number' },
    date: { type: 'string', format: 'date-time' },
    description: { type: 'string' },
    amount: { type: 'number' },
    type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
    duplicate: { type: 'boolean' },
  },
} as const;

const skippedRowSchema = {
  type: 'object',
  properties: {
    line: { type: 'number' },
    reason: { type: 'string' },
  },
} as const;

const confirmImportBodySchema = z.object({
  accountId: z.string().uuid(),
  rows: z
    .array(
      z.object({
        // Only the calendar day matters: normalise to 00:00 UTC so a client in another zone cannot shift it.
        date: z.coerce.date().transform((value, ctx) => {
          const day = buildUtcDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
          if (!day) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
          return day ?? value;
        }),
        description: z.string().trim().min(1).max(MAX_DESCRIPTION_LENGTH),
        // Cents: the column holds two decimals, anything finer would not survive the round trip.
        amount: z
          .number()
          .positive()
          .max(MAX_CENTS / 100)
          // toFixed rounds the shortest decimal form of the double, so this holds for large values too, where
          // value * 100 is no longer exact.
          .refine((value) => Number(value.toFixed(2)) === value, 'At most 2 decimal places'),
        type: z.enum(['INCOME', 'EXPENSE']),
      }),
    )
    .max(MAX_IMPORT_ROWS),
});

/**
 * Fastify's own 4xx errors (file over the limit, body over 1 MB, too many parts) would otherwise reach the global
 * handler as unknown errors and answer 500.
 */
export function importErrorHandler(error: FastifyError | Error, request: Parameters<typeof errorHandler>[1], reply: Parameters<typeof errorHandler>[2]) {
  const fastifyError = error as FastifyError;
  const status = fastifyError.statusCode;
  if (typeof fastifyError.code === 'string' && fastifyError.code.startsWith('FST_') && status && status >= 400 && status < 500) {
    reply.status(status).send({
      success: false,
      error: {
        code: status === 413 ? 'PAYLOAD_TOO_LARGE' : 'BAD_REQUEST',
        message: status === 413 ? 'The upload is too large (files up to 5 MB, JSON bodies up to 1 MB).' : error.message,
      },
    });
    return;
  }
  errorHandler(error, request, reply);
}

export async function importRoutes(app: FastifyInstance) {
  app.setErrorHandler(importErrorHandler);

  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * POST /transactions/import/preview — multipart/form-data ONLY.
   * Fields: `accountId` (uuid text field) + `file` (.ofx or .csv, max 5MB).
   * Parses the statement and flags duplicates without persisting anything.
   * A credit card invoice (CCSTMTRS) is parsed too but answers with the `card-statement` warning: invoices have
   * their own flow.
   */
  app.post('/import/preview', {
    schema: {
      description:
        'Preview a bank statement import (multipart/form-data only: text field `accountId` + file field `file` with a .ofx or .csv file, max 5MB, up to 1500 rows). Returns parsed rows flagged as duplicate/new, the lines that could not be read (`skipped`) and a `card-statement` warning for credit card invoices. Requires EDITOR+ on the account household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                rows: { type: 'array', items: previewRowSchema },
                total: { type: 'number' },
                duplicateCount: { type: 'number' },
                newCount: { type: 'number' },
                skipped: { type: 'array', items: skippedRowSchema },
                skippedCount: { type: 'number' },
                warnings: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    let accountIdRaw: unknown;
    let filename = 'upload';
    let buffer: Buffer | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        // First file part wins; must be consumed so the request stream drains.
        if (!buffer) {
          filename = part.filename ?? 'upload';
          buffer = await part.toBuffer();
        } else {
          await part.toBuffer();
        }
      } else if (part.fieldname === 'accountId') {
        accountIdRaw = part.value;
      }
    }

    const accountId = z.string().uuid().parse(accountIdRaw);

    if (!buffer) {
      throw new BadRequestError(
        'A statement file (.ofx or .csv) is required in the "file" field.',
      );
    }

    // Fetch account first to resolve the household for authorization.
    const account = await getAccount(accountId);
    await requireEditor(request, account.householdId);

    if (!account.isActive) throw new BadRequestError('This account is inactive; reactivate it to import into it.');

    const parsed = parseImportBuffer(filename, buffer);
    const preview = await buildImportPreview(accountId, account.householdId, parsed);

    return reply.send({ success: true, data: preview });
  });

  /**
   * POST /transactions/import/confirm — application/json ONLY.
   * Body: { accountId, rows: [{ date, description, amount, type }] }.
   * Persists non-duplicate rows (duplicates are re-checked and skipped).
   */
  app.post('/import/confirm', {
    schema: {
      description:
        'Confirm a bank statement import (application/json only: { accountId, rows: [{ date, description, amount, type }] }). Re-validates duplicates at write time; duplicates are skipped. A second confirm on the same account while one runs answers 409. If a row fails after others were saved the answer carries `stoppedAt` and `error`; sending the same rows again continues. Requires EDITOR+ on the account household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['accountId', 'rows'],
        properties: {
          accountId: { type: 'string', format: 'uuid' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              required: ['date', 'description', 'amount', 'type'],
              properties: {
                date: { type: 'string', format: 'date-time' },
                description: { type: 'string' },
                amount: { type: 'number' },
                type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
              },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                imported: { type: 'number' },
                skipped: { type: 'number' },
                ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
                stoppedAt: { type: 'number' },
                error: { type: 'string' },
              },
            },
          },
        },
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const input = confirmImportBodySchema.parse(request.body);

    // Fetch account first to resolve the household for authorization.
    const account = await getAccount(input.accountId);
    await requireEditor(request, account.householdId);
    if (!account.isActive) throw new BadRequestError('This account is inactive; reactivate it to import into it.');

    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const result = await confirmImport(
      account.id,
      account.householdId,
      input.rows,
      user.id,
    );

    return reply.status(201).send({ success: true, data: result });
  });
}
