import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import { buildCardOfxPreview, resolveCardAccount } from './card-ofx-import.service.js';
import { importErrorHandler } from './import.routes.js';

// Error shape mirrors the other import routes and the central error handler.
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

const okResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: { type: 'object', additionalProperties: true },
  },
} as const;

export const cardOfxOptionsSchema = z.object({
  monthOverride: z
    .object({
      year: z.number().int().min(2000).max(2100),
      month: z.number().int().min(1).max(12),
    })
    .optional(),
});

/** The `options` multipart field is a JSON string; a client that already parsed it may send the object. */
function parseJsonField(name: string, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError(`Field "${name}" must be a JSON string.`);
  }
}

interface CardOfxUpload {
  filename: string | undefined;
  buffer: Buffer | null;
  accountIdRaw: unknown;
  optionsRaw: unknown;
}

/** Reads the multipart body of a preview: the first `file` part, `accountId` and `options`. */
async function readCardOfxUpload(request: FastifyRequest): Promise<CardOfxUpload> {
  const upload: CardOfxUpload = { filename: undefined, buffer: null, accountIdRaw: undefined, optionsRaw: undefined };
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      // First file part wins; others must still be consumed so the stream drains.
      if (!upload.buffer) {
        upload.filename = part.filename ?? undefined;
        upload.buffer = await part.toBuffer();
      } else {
        await part.toBuffer();
      }
    } else if (part.fieldname === 'accountId') {
      upload.accountIdRaw = part.value;
    } else if (part.fieldname === 'options') {
      upload.optionsRaw = part.value;
    }
  }
  return upload;
}

export async function cardOfxImportRoutes(app: FastifyInstance) {
  // The multipart limits answer 413 instead of 500, as in the statement import.
  app.setErrorHandler(importErrorHandler);

  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * POST /transactions/import/card-ofx/preview — multipart/form-data ONLY.
   * Fields: `file` (.ofx card invoice, max 5MB), `accountId` (the card), `options` (JSON, optional: monthOverride).
   * Reads the invoice, works out its month and compares its payment lines with what is recorded. Nothing is persisted.
   */
  app.post('/import/card-ofx/preview', {
    schema: {
      description:
        'Preview a credit card invoice OFX import (multipart/form-data: file field `file` (.ofx, max 5MB) + text fields `accountId` (the credit card) and optional `options` (JSON { monthOverride?: { year, month } })). Returns the invoice month (due month, from DTEND and the card due/closing days unless overridden), every line of the file with its status (new, or payment for a "Pagamento recebido" line), the first 100 lines that could not be read (`skipped`; `totals.skipped` has the count), how the "Pagamento recebido" lines compare with the payments already recorded for the previous invoice, and warning codes. Nothing is saved. Requires EDITOR+ on the card household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      response: {
        200: okResponseSchema,
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const { filename = 'upload.ofx', buffer, accountIdRaw, optionsRaw } = await readCardOfxUpload(request);

    if (!buffer) {
      throw new BadRequestError('A card invoice (.ofx) is required in the "file" field.');
    }
    if (!filename.toLowerCase().endsWith('.ofx')) {
      throw new BadRequestError('Only .ofx card invoices are accepted here.');
    }

    const accountId = z.string().uuid().parse(accountIdRaw);
    const options = cardOfxOptionsSchema.parse(parseJsonField('options', optionsRaw) ?? {});

    // Authorization runs on the card's household before the account type is checked or the file is read.
    const account = await resolveCardAccount(accountId, (householdId) => requireEditor(request, householdId));

    const preview = await buildCardOfxPreview({ account, buffer, options });
    return reply.send({ success: true, data: preview });
  });
}
