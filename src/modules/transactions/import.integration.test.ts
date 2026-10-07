import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_IMPORT_ROWS } from './import.service.js';

import { prisma } from '../../shared/db/prisma.js';
import { buildImportPreview, confirmImport, flagDuplicates, parseImportBuffer } from './import.service.js';

/**
 * Statement import against a real Postgres. Skipped unless IMPORT_DB_TEST_URL points at a SCRATCH database that
 * already has the migrations applied (vitest.config.ts hands that URL to the app's Prisma client):
 *
 *   createdb up_s6 && DATABASE_URL=postgresql://.../up_s6 npx prisma migrate deploy
 *   IMPORT_DB_TEST_URL=postgresql://.../up_s6 npx vitest run src/modules/transactions/import.integration.test.ts
 *
 * Never point it at a database you care about: it creates a household and removes it afterwards, but it does write.
 */
const enabled = Boolean(process.env.IMPORT_DB_TEST_URL);

// CI must never skip this silently because the variable went missing.
it.runIf(process.env.CI)('is configured when running in CI', () => {
  expect(process.env.IMPORT_DB_TEST_URL).toBeTruthy();
});

const ofx = (entries: Array<[string, string, string, string]>) =>
  Buffer.from(
    `OFXHEADER:100\nDATA:OFXSGML\n<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS><BANKTRANLIST>\n` +
      entries
        .map(([id, date, amount, memo]) => `<STMTTRN><DTPOSTED>${date}\n<TRNAMT>${amount}\n<FITID>${id}\n<MEMO>${memo}\n</STMTTRN>\n`)
        .join('') +
      `</BANKTRANLIST></STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>\n`,
  );

/** What the frontend sends on confirm: every row of the preview (duplicates included), minus the preview-only fields. */
const confirmPayload = (preview: Awaited<ReturnType<typeof buildImportPreview>>) =>
  preview.rows.map(({ date, description, amount, type }) => ({ date, description, amount, type }));

describe.skipIf(!enabled)('statement import on Postgres', () => {
  let householdId: string;
  const newAccount = async (name: string) =>
    (await prisma.account.create({ data: { householdId, name, type: 'CHECKING' } })).id;
  const countRows = (accountId: string) => prisma.transaction.count({ where: { accountId } });
  const balance = async (accountId: string) => (await prisma.account.findUniqueOrThrow({ where: { id: accountId } })).balance.toNumber();

  beforeAll(async () => {
    householdId = (await prisma.household.create({ data: { name: 'Import test' } })).id;
  });

  afterAll(async () => {
    if (householdId) await prisma.household.delete({ where: { id: householdId } });
    await prisma.$disconnect();
  });

  it('keeps two identical entries of one file and agrees between preview, confirm and a second run', async () => {
    const accountId = await newAccount('Two coffees');
    const parsed = parseImportBuffer('a.ofx', ofx([['a1', '20261105', '-10.00', 'Coffee'], ['a2', '20261105', '-10.00', 'Coffee']]));

    const preview = await buildImportPreview(accountId, householdId, parsed);
    expect(preview).toMatchObject({ newCount: 2, duplicateCount: 0 });
    expect(await countRows(accountId)).toBe(0);

    expect(await confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 2, skipped: 0 });
    expect(await countRows(accountId)).toBe(2);
    expect(await balance(accountId)).toBe(-20);

    expect(await buildImportPreview(accountId, householdId, parsed)).toMatchObject({ newCount: 0, duplicateCount: 2 });
    expect(await confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 0, skipped: 2 });
    expect(await countRows(accountId)).toBe(2);
  });

  describe('preview then confirm with the payload the frontend builds', () => {
    const threeCoffees = () =>
      parseImportBuffer(
        'a.ofx',
        ofx([['c1', '20261105', '-10.00', 'Coffee'], ['c2', '20261105', '-10.00', 'Coffee'], ['c3', '20261105', '-10.00', 'Coffee']]),
      );

    it('3 identical rows in the file and 1 on the account: preview says 2 new and confirm adds exactly 2', async () => {
      const accountId = await newAccount('Three vs one');
      const parsed = threeCoffees();
      await confirmImport(accountId, householdId, parsed.rows.slice(0, 1));
      expect(await countRows(accountId)).toBe(1);

      const preview = await buildImportPreview(accountId, householdId, parsed);
      expect(preview).toMatchObject({ newCount: 2, duplicateCount: 1 });

      const result = await confirmImport(accountId, householdId, confirmPayload(preview));
      expect(result).toMatchObject({ imported: 2, skipped: 1 });
      expect(await countRows(accountId)).toBe(3);
    });

    it('deleting one of two imported coffees and importing the file again brings back exactly one', async () => {
      const accountId = await newAccount('Deleted one');
      const parsed = parseImportBuffer('a.ofx', ofx([['d1', '20261105', '-10.00', 'Coffee'], ['d2', '20261105', '-10.00', 'Coffee']]));
      await confirmImport(accountId, householdId, parsed.rows);
      const [first] = await prisma.transaction.findMany({ where: { accountId } });
      await prisma.transaction.delete({ where: { id: first!.id } });

      const preview = await buildImportPreview(accountId, householdId, parsed);
      expect(preview).toMatchObject({ newCount: 1, duplicateCount: 1 });

      expect(await confirmImport(accountId, householdId, confirmPayload(preview))).toMatchObject({ imported: 1, skipped: 1 });
      expect(await countRows(accountId)).toBe(2);
    });

    it('running the whole file again after an import stopped half way adds only the rows that are missing', async () => {
      const accountId = await newAccount('Resume');
      const parsed = threeCoffees();
      // Same state a failure at row 2 leaves behind: the first row is saved, the rest are not.
      await confirmImport(accountId, householdId, parsed.rows.slice(0, 1));

      const preview = await buildImportPreview(accountId, householdId, parsed);
      expect(await confirmImport(accountId, householdId, confirmPayload(preview))).toMatchObject({ imported: 2, skipped: 1 });
      expect(await countRows(accountId)).toBe(3);

      const again = await buildImportPreview(accountId, householdId, parsed);
      expect(again).toMatchObject({ newCount: 0, duplicateCount: 3 });
      expect(await confirmImport(accountId, householdId, confirmPayload(again))).toMatchObject({ imported: 0, skipped: 3 });
    });
  });

  it('stores the day the bank printed, whatever the time and the server zone', async () => {
    const accountId = await newAccount('Late night');
    const parsed = parseImportBuffer('a.ofx', ofx([['n1', '20261105235959', '-1.00', 'Late']]));

    await confirmImport(accountId, householdId, parsed.rows);

    const [stored] = await prisma.$queryRaw<Array<{ day: string }>>`SELECT date::text AS day FROM transactions WHERE account_id = ${accountId}::uuid`;
    expect(stored?.day).toBe('2026-11-05');
  });

  it('answers 409 to confirms that arrive while one is running, without holding a connection each', async () => {
    const accountId = await newAccount('Busy');
    const parsed = parseImportBuffer('a.ofx', ofx([['b1', '20261105', '-10.00', 'Coffee'], ['b2', '20261106', '-4.50', 'Bus']]));

    // Another import of this account is in progress: it holds the advisory lock.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const holder = prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${accountId}))`;
      locked();
      await held;
    });
    await lockTaken;

    // More waiters than the pool has connections (10): they must all fail fast instead of queueing on the lock.
    const started = Date.now();
    const attempts = await Promise.allSettled(Array.from({ length: 15 }, () => confirmImport(accountId, householdId, parsed.rows)));
    expect(attempts.every((a) => a.status === 'rejected' && (a.reason as { statusCode?: number }).statusCode === 409)).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(await countRows(accountId)).toBe(0);

    release();
    await holder;

    // Once the lock is free the same request goes through, and a repeat is all duplicates.
    expect(await confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 2 });
    expect(await confirmImport(accountId, householdId, parsed.rows)).toMatchObject({ imported: 0, skipped: 2 });
    expect(await balance(accountId)).toBe(-14.5);
  });

  it('flags a file of the maximum size against an account that already holds it in a single pass', async () => {
    const accountId = await newAccount('Big');
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => ({
      date: new Date(Date.UTC(2026, i % 12, 1 + (i % 28))),
      description: `Row ${i}`,
      amount: 1 + (i % 50),
      type: 'EXPENSE' as const,
    }));
    await prisma.transaction.createMany({
      data: rows.map((r) => ({ householdId, accountId, type: 'EXPENSE', categoryName: 'OTHER_EXPENSES', amount: r.amount, description: r.description, date: r.date })),
    });

    const started = Date.now();
    const flags = await flagDuplicates(accountId, householdId, rows);

    expect(flags.every(Boolean)).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
