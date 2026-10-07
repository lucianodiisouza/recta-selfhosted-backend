import { execSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-Postgres test of the two locks of the recurring-transactions module (the per-household lock of detect/apply and
 * the per-recurrence lock of the monthly execution guard). A mock cannot tell a lock from no lock, so this one is the proof
 * that simultaneous requests create each thing once. It is skipped unless TEST_DATABASE_ADMIN_URL is set, so `npm test`
 * and CI never need a database:
 *
 *   TEST_DATABASE_ADMIN_URL=postgresql://user:password@localhost:5432/postgres npm test -- recurring-concurrency.db
 *
 * It CREATES a scratch database named recta_test_recurring_<timestamp> on that server, applies the migrations to it, runs
 * and DROPS it. It never touches any other database.
 */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;

describe.skipIf(!ADMIN_URL)('recurring locks against a real database', { timeout: 60_000 }, () => {
  const scratch = `recta_test_recurring_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  let pool: pg.Pool;
  // Loaded after DATABASE_URL points at the scratch database (the prisma client reads it when imported).
  let prisma: any;
  let detSvc: any;
  let recSvc: any;
  let household: { id: string };
  let bank: { id: string };

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${scratch}`;
    execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url.toString() } });
    process.env.DATABASE_URL = url.toString();
    // Building the client here keeps hold of the pool, so it can be closed before the database is dropped.
    pool = new pg.Pool({ connectionString: url.toString() });
    const { PrismaClient } = await import('../../generated/prisma/client.js');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    (globalThis as { __prisma?: unknown }).__prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    ({ prisma } = await import('../../shared/db/prisma.js'));
    detSvc = await import('./recurring-detect.service.js');
    recSvc = await import('./recurring-transactions.service.js');
    household = await prisma.household.create({ data: { name: 'Locks test' } });
    bank = await prisma.account.create({ data: { householdId: household.id, name: 'Bank', type: 'CHECKING', balance: 1000 } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.end();
  }, 60_000);

  it('six simultaneous applies of the same two candidates create two recurrences, once each, and link the history once', async () => {
    const now = new Date(Date.UTC(2026, 7, 20));
    for (const name of ['Streaming Alfa', 'Gym Beta']) {
      for (let m = 0; m < 5; m++) {
        await prisma.transaction.create({
          data: { householdId: household.id, accountId: bank.id, type: 'EXPENSE', categoryName: 'ENTERTAINMENT', amount: 30, description: name, date: new Date(Date.UTC(2026, 2 + m, 8)), paid: true },
        });
      }
    }
    const found = await detSvc.detectRecurringTransactions({ householdId: household.id }, now);
    expect(found.candidates).toHaveLength(2);
    const items = found.candidates.map((c: { id: string }) => ({ id: c.id }));

    const results = await Promise.all(Array.from({ length: 6 }, () => detSvc.applyDetectedRecurrences({ householdId: household.id, items }, now)));

    expect(results.reduce((sum: number, r: { created: number }) => sum + r.created, 0)).toBe(2);
    expect(await prisma.recurringTransaction.count({ where: { householdId: household.id } })).toBe(2);
    expect(await prisma.transaction.count({ where: { householdId: household.id, recurringTransactionId: { not: null } } })).toBe(10);
    // Applying again afterwards is a no-op.
    const again = await detSvc.applyDetectedRecurrences({ householdId: household.id, items }, now);
    expect(again.created).toBe(0);
  });

  it('six simultaneous executions of a monthly recurrence create one occurrence for the month', async () => {
    const rec = await prisma.recurringTransaction.create({
      data: {
        householdId: household.id, accountId: bank.id, categoryName: 'UTILITIES', amount: 70, description: 'Power', frequency: 'MONTHLY',
        startDate: new Date(Date.UTC(2026, 9, 5)), nextRunAt: new Date(Date.UTC(2026, 9, 5)),
      },
    });

    const results = await Promise.all(Array.from({ length: 6 }, () => recSvc.executeRecurringTransaction(rec.id, household.id, { paid: false })));

    expect(results.filter((r: { skipped: boolean }) => !r.skipped)).toHaveLength(1);
    expect(await prisma.transaction.count({ where: { householdId: household.id, recurringTransactionId: rec.id } })).toBe(1);
  });
});
