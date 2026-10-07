import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { BadRequestError, ConflictError, ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { buildCardOfxPreview, resolveCardAccount } from './card-ofx-import.service.js';
import { confirmCardOfxImport } from './card-ofx-confirm.service.js';
import { IMPORT_MULTIPART_LIMITS } from './import.routes.js';
import { cardOfxImportRoutes } from './card-ofx-import.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  getUserByFirebaseUid: vi.fn(async () => ({ id: 'user-1' })),
}));
vi.mock('./card-ofx-confirm.service.js', () => ({ confirmCardOfxImport: vi.fn() }));
vi.mock('./card-ofx-import.service.js', () => ({
  MAX_CARD_OFX_LINES: 1000,
  resolveCardAccount: vi.fn(),
  buildCardOfxPreview: vi.fn(),
}));

const CARD_ID = '33333333-3333-4333-8333-333333333333';
const RESOLVED = { id: CARD_ID, householdId: 'household-1', type: 'CREDIT' };

const mockedRequireEditor = vi.mocked(requireEditor);
const mockedResolve = vi.mocked(resolveCardAccount);
const mockedPreview = vi.mocked(buildCardOfxPreview);
const mockedConfirm = vi.mocked(confirmCardOfxImport);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: IMPORT_MULTIPART_LIMITS });
  app.setErrorHandler(errorHandler);
  await app.register(cardOfxImportRoutes, { prefix: '/transactions' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedRequireEditor.mockResolvedValue({} as never);
  // The real resolution authorizes the card's household before checking the account type; mimic that contract.
  mockedResolve.mockImplementation((async (_id: string, authorize?: (householdId: string) => Promise<unknown>) => {
    await authorize?.('household-1');
    return RESOLVED;
  }) as never);
  mockedPreview.mockResolvedValue({ lines: [] } as never);
  mockedConfirm.mockResolvedValue({ created: 1, linked: 0, skipped: [], ids: ['t1'] } as never);
});

interface UploadFile {
  name: string;
  content: Buffer;
}

function multipartBody(fields: Record<string, string>, file?: UploadFile) {
  const boundary = `----vitest${Math.random().toString(16).slice(2)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  if (file) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: application/x-ofx\r\n\r\n`,
      ),
      file.content,
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { payload: Buffer.concat(chunks), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

function preview(fields: Record<string, string>, file?: UploadFile) {
  const { payload, headers } = multipartBody(fields, file);
  return app.inject({ method: 'POST', url: '/transactions/import/card-ofx/preview', payload, headers });
}

const OFX: UploadFile = { name: 'Fatura_2026-11-09.ofx', content: Buffer.from('<OFX><CCSTMTRS></CCSTMTRS></OFX>') };

describe('POST /transactions/import/card-ofx/preview', () => {
  it('authorizes the card household before building the preview, and passes the file and options', async () => {
    const options = { monthOverride: { year: 2026, month: 11 } };

    const res = await preview({ accountId: CARD_ID, options: JSON.stringify(options) }, OFX);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: { lines: [] } });
    expect(mockedResolve).toHaveBeenCalledWith(CARD_ID, expect.any(Function));
    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
    expect(mockedRequireEditor.mock.invocationCallOrder[0]!).toBeLessThan(mockedPreview.mock.invocationCallOrder[0]!);
    expect(mockedPreview).toHaveBeenCalledWith({ account: RESOLVED, buffer: OFX.content, options });
  });

  it('passes empty options when the field is absent and accepts the extension in any case', async () => {
    const res = await preview({ accountId: CARD_ID }, { ...OFX, name: 'FATURA.OFX' });

    expect(res.statusCode).toBe(200);
    expect(mockedPreview).toHaveBeenCalledWith(expect.objectContaining({ options: {} }));
  });

  it('answers 403 and never reads the invoice when the caller cannot edit the household', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await preview({ accountId: CARD_ID }, OFX);

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'FORBIDDEN' } });
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('answers 400 when the account is not a credit card', async () => {
    mockedResolve.mockRejectedValue(new BadRequestError('Account "Conta" is not a credit card'));

    const res = await preview({ accountId: CARD_ID }, OFX);

    expect(res.statusCode).toBe(400);
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('rejects a request without a file before touching the account', async () => {
    const res = await preview({ accountId: CARD_ID });

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('rejects files that are not .ofx', async () => {
    const res = await preview({ accountId: CARD_ID }, { name: 'fatura.csv', content: OFX.content });

    expect(res.statusCode).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed accountId', async () => {
    const cases: Array<Record<string, string>> = [{}, { accountId: 'abc' }];
    for (const fields of cases) {
      const res = await preview(fields, OFX);
      expect(res.statusCode, JSON.stringify(fields)).toBe(400);
      expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    }
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ['not JSON', '{month'],
    ['a month out of range', JSON.stringify({ monthOverride: { year: 2026, month: 13 } })],
    ['a year out of range', JSON.stringify({ monthOverride: { year: 1999, month: 1 } })],
  ])('rejects options that are %s before resolving anything', async (_label, options) => {
    const res = await preview({ accountId: CARD_ID, options }, OFX);

    expect(res.statusCode).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
  });

  it('answers 413 (not 500) when the file is over the 5 MB limit', async () => {
    const big = { name: 'big.ofx', content: Buffer.alloc(5 * 1024 * 1024 + 4096, 97) };

    const res = await preview({ accountId: CARD_ID }, big);

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
    expect(mockedPreview).not.toHaveBeenCalled();
  });
});

const LINE = {
  ref: 'ofx:fit-1:0a1b2c3d',
  fitid: 'fit-1',
  date: '2025-11-03',
  amount: 50,
  type: 'EXPENSE',
  kind: 'purchase',
  memo: 'Shoe store - Parcela 4/10',
  merchant: 'Shoe store',
  installment: { number: 4, total: 10 },
};

function confirmBody(overrides: Record<string, unknown> = {}) {
  return { accountId: CARD_ID, lines: [LINE], selectedRefs: [LINE.ref], ...overrides };
}

function confirm(body: unknown) {
  return app.inject({ method: 'POST', url: '/transactions/import/card-ofx/confirm', payload: body as object });
}

describe('POST /transactions/import/card-ofx/confirm', () => {
  it('authorizes the card household, then confirms for the user and answers 201 with defaults filled in', async () => {
    const res = await confirm(confirmBody());

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ success: true, data: { created: 1, linked: 0, skipped: [], ids: ['t1'] } });
    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
    expect(mockedConfirm).toHaveBeenCalledWith({
      account: RESOLVED,
      userId: 'user-1',
      request: { ...confirmBody(), createDespiteDuplicate: [], links: [], categoryMap: [] },
    });
  });

  it('passes links, duplicates and categories through', async () => {
    const extra = {
      createDespiteDuplicate: [LINE.ref],
      links: [{ ref: 'ofx:x:00000001', transactionId: '44444444-4444-4444-8444-444444444444' }],
      categoryMap: [{ merchant: 'Shoe store', type: 'EXPENSE', categoryName: 'SHOPPING' }],
    };

    const res = await confirm(confirmBody(extra));

    expect(res.statusCode).toBe(201);
    expect(mockedConfirm).toHaveBeenCalledWith(expect.objectContaining({ request: expect.objectContaining(extra) }));
  });

  it('answers 403 and confirms nothing when the caller cannot edit the household', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await confirm(confirmBody());

    expect(res.statusCode).toBe(403);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('answers 409 when an import of the card is already running', async () => {
    mockedConfirm.mockRejectedValue(new ConflictError('An import of this card invoice is already running'));

    const res = await confirm(confirmBody());

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });

  it('answers 400 when the account is not a credit card', async () => {
    mockedResolve.mockRejectedValue(new BadRequestError('Account "Conta" is not a credit card'));

    expect((await confirm(confirmBody())).statusCode).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it.each<[string, Record<string, unknown>]>([
    ['a malformed accountId', { accountId: 'abc' }],
    ['no lines', { lines: [] }],
    ['more than 1000 lines', { lines: Array.from({ length: 1001 }, () => LINE) }],
    ['a line with a bad date', { lines: [{ ...LINE, date: '03/11/2025' }] }],
    ['a negative amount', { lines: [{ ...LINE, amount: -1 }] }],
    ['an unknown kind', { lines: [{ ...LINE, kind: 'gift' }] }],
    ['a link without a uuid', { links: [{ ref: LINE.ref, transactionId: 'abc' }] }],
    ['a category entry without a type', { categoryMap: [{ merchant: 'x', categoryName: 'FOOD' }] }],
  ])('rejects %s before resolving anything', async (_label, overrides) => {
    const res = await confirm(confirmBody(overrides));

    expect(res.statusCode).toBe(400);
    expect(mockedResolve).not.toHaveBeenCalled();
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('rejects a body without selectedRefs', async () => {
    const { selectedRefs: _omit, ...body } = confirmBody();

    expect((await confirm(body)).statusCode).toBe(400);
  });
});
