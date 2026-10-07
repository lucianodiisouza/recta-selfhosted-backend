import Fastify, { type FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ConflictError, ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { getAccount } from '../accounts/accounts.service.js';
import { MAX_IMPORT_ROWS, buildImportPreview, confirmImport } from './import.service.js';
import { IMPORT_MULTIPART_LIMITS, importRoutes } from './import.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  getUserByFirebaseUid: vi.fn(async () => ({ id: 'user-1' })),
}));
vi.mock('../accounts/accounts.service.js', () => ({ getAccount: vi.fn() }));
// The parser runs for real; only the database-bound steps are replaced.
vi.mock('./import.service.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./import.service.js')>()),
  buildImportPreview: vi.fn(),
  confirmImport: vi.fn(),
}));

const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

const OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20261105<TRNAMT>-10.00<FITID>b1<MEMO>Corner bakery
</STMTTRN>
</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>
`;
const CSV = 'date,description,amount\n2026-11-05,Corner bakery,-10.00\n';

const mockedGetAccount = vi.mocked(getAccount);
const mockedRequireEditor = vi.mocked(requireEditor);
const mockedPreview = vi.mocked(buildImportPreview);
const mockedConfirm = vi.mocked(confirmImport);

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(multipart, { limits: IMPORT_MULTIPART_LIMITS });
  app.setErrorHandler(errorHandler);
  await app.register(importRoutes, { prefix: '/transactions' });
  await app.ready();
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetAccount.mockResolvedValue({ id: ACCOUNT_ID, householdId: 'household-1', isActive: true } as never);
  mockedRequireEditor.mockResolvedValue({} as never);
  mockedPreview.mockResolvedValue({
    rows: [],
    total: 0,
    duplicateCount: 0,
    newCount: 0,
    skipped: [],
    skippedCount: 0,
    warnings: [],
  });
  mockedConfirm.mockResolvedValue({ imported: 1, skipped: 0, ids: ['tx-1'] });
});

function upload(filename: string | null, content: string, accountId: string = ACCOUNT_ID) {
  const boundary = '----vitestboundary';
  const file =
    filename === null
      ? ''
      : `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/octet-stream\r\n\r\n${content}\r\n`;
  const payload = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="accountId"\r\n\r\n${accountId}\r\n${file}--${boundary}--\r\n`,
  );
  return app.inject({
    method: 'POST',
    url: '/transactions/import/preview',
    payload,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
  });
}

describe('POST /transactions/import/preview', () => {
  it('parses an OFX upload and returns the preview', async () => {
    const res = await upload('extrato.ofx', OFX);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ success: true, data: { total: 0 } });
    expect(mockedPreview).toHaveBeenCalledWith(
      ACCOUNT_ID,
      'household-1',
      expect.objectContaining({
        rows: [expect.objectContaining({ description: 'Corner bakery', amount: 10, type: 'EXPENSE' })],
      }),
    );
  });

  it('accepts a CSV upload', async () => {
    const res = await upload('extrato.csv', CSV);

    expect(res.statusCode).toBe(200);
    expect(mockedPreview).toHaveBeenCalledTimes(1);
  });

  it('rejects an unsupported extension with 400 before touching the database', async () => {
    const res = await upload('extrato.pdf', 'x');

    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'BAD_REQUEST' } });
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('rejects a request without a file', async () => {
    const res = await upload(null, '');

    expect(res.statusCode).toBe(400);
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('rejects an accountId that is not a uuid', async () => {
    const res = await upload('extrato.ofx', OFX, 'not-a-uuid');

    expect(res.statusCode).toBe(400);
    expect(mockedGetAccount).not.toHaveBeenCalled();
  });

  it('requires editor access on the account household before parsing', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await upload('extrato.ofx', OFX);

    expect(res.statusCode).toBe(403);
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('authorises against the household that owns the account', async () => {
    await upload('extrato.ofx', OFX);

    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
  });

  it('refuses an inactive account before parsing', async () => {
    mockedGetAccount.mockResolvedValue({ id: ACCOUNT_ID, householdId: 'household-1', isActive: false } as never);

    const res = await upload('extrato.ofx', OFX);

    expect(res.statusCode).toBe(400);
    expect(mockedPreview).not.toHaveBeenCalled();
  });

  it('answers 413, not 500, for a file over 5 MB', async () => {
    const res = await upload('big.csv', `data;descricao;valor${String.fromCharCode(10)}${'x'.repeat(5 * 1024 * 1024 + 10)}`);

    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'PAYLOAD_TOO_LARGE' } });
  });

  it('answers 400 with the reason when the CSV header is unusable', async () => {
    const res = await upload('x.csv', ['a;b;c;d', '1;2;3;4'].join(String.fromCharCode(10)));

    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/header must name/);
  });
});

describe('POST /transactions/import/confirm', () => {
  const row = { date: '2026-11-05T00:00:00.000Z', description: 'Corner bakery', amount: 10, type: 'EXPENSE' };

  function confirm(body: unknown) {
    return app.inject({ method: 'POST', url: '/transactions/import/confirm', payload: body as object });
  }

  it('imports the rows and answers 201 with the counts', async () => {
    const res = await confirm({ accountId: ACCOUNT_ID, rows: [row] });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ success: true, data: { imported: 1, skipped: 0 } });
    expect(mockedConfirm).toHaveBeenCalledWith(ACCOUNT_ID, 'household-1', expect.any(Array), 'user-1');
  });

  it('normalises each date to the calendar day at 00:00 UTC', async () => {
    await confirm({ accountId: ACCOUNT_ID, rows: [{ ...row, date: '2026-11-05T23:30:00.000-03:00' }] });

    expect(mockedConfirm.mock.calls[0]?.[2][0]?.date.toISOString()).toBe('2026-11-06T00:00:00.000Z');
  });

  it.each([
    ['a non-positive amount', { amount: 0 }],
    ['an amount with more than two decimals', { amount: 10.123 }],
    ['an empty description', { description: '   ' }],
    ['a description over 255 characters', { description: 'x'.repeat(256) }],
    ['an unknown type', { type: 'TRANSFER' }],
  ])('refuses %s', async (_label, patch) => {
    const res = await confirm({ accountId: ACCOUNT_ID, rows: [{ ...row, ...patch }] });

    expect(res.statusCode).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('refuses more rows than the limit', async () => {
    const res = await confirm({ accountId: ACCOUNT_ID, rows: Array.from({ length: MAX_IMPORT_ROWS + 1 }, () => ({ ...row })) });

    expect(res.statusCode).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('accepts the biggest confirm: the row limit with 255-character descriptions fits in the 1 MB body', async () => {
    const big = { ...row, description: 'x'.repeat(255), date: '2026-11-05T00:00:00.000Z' };

    const res = await confirm({ accountId: ACCOUNT_ID, rows: Array.from({ length: MAX_IMPORT_ROWS }, () => big) });

    expect(res.statusCode).toBe(201);
  });

  it('refuses amounts that are not whole cents even when they are large', async () => {
    const res = await confirm({ accountId: ACCOUNT_ID, rows: [{ ...row, amount: 1_000_000_000.123 }] });

    expect(res.statusCode).toBe(400);
  });

  it('answers 409 when an import is already running for the account', async () => {
    mockedConfirm.mockRejectedValue(new ConflictError('An import is already running for this account.'));

    const res = await confirm({ accountId: ACCOUNT_ID, rows: [row] });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'CONFLICT' } });
  });

  it('answers 413, not 500, for a body over 1 MB', async () => {
    const res = await confirm({ accountId: ACCOUNT_ID, rows: [{ ...row, description: 'x'.repeat(255) }], padding: 'y'.repeat(1_100_000) });

    expect(res.statusCode).toBe(413);
  });

  it('passes a partial result through, so the client knows where it stopped', async () => {
    mockedConfirm.mockResolvedValue({ imported: 1, skipped: 0, ids: ['tx-1'], stoppedAt: 1, error: 'boom' });

    const res = await confirm({ accountId: ACCOUNT_ID, rows: [row, row] });

    expect(res.json().data).toMatchObject({ imported: 1, stoppedAt: 1, error: 'boom' });
  });

  it('refuses a non-positive amount', async () => {
    const res = await confirm({ accountId: ACCOUNT_ID, rows: [{ ...row, amount: 0 }] });

    expect(res.statusCode).toBe(400);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });

  it('requires editor access', async () => {
    mockedRequireEditor.mockRejectedValue(new ForbiddenError('not your household'));

    const res = await confirm({ accountId: ACCOUNT_ID, rows: [row] });

    expect(mockedRequireEditor).toHaveBeenCalledWith(expect.anything(), 'household-1');
    expect(res.statusCode).toBe(403);
    expect(mockedConfirm).not.toHaveBeenCalled();
  });
});
