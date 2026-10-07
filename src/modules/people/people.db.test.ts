import { execSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-Postgres tests of the people module: what the unit tests cannot see because they run on a fake database (the
 * SQL itself, the foreign keys and cascades, and above all the locks). A mock cannot tell a lock from no lock, so the
 * race tests are the proof that shares never end up above the amount when an amount update and a PUT of shares
 * coincide, and that deleting a person never loses a share. It is skipped unless TEST_DATABASE_ADMIN_URL is set, so
 * `npm test` and CI never need a database:
 *
 *   TEST_DATABASE_ADMIN_URL=postgresql://user:password@localhost:5432/postgres npm test -- people.db
 *
 * It CREATES a scratch database named recta_test_people_<timestamp> on that server, applies the migrations to it, runs
 * and DROPS it. It never touches any other database.
 */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;
const ROUNDS = 40;

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!ADMIN_URL)('the people module against a real database', { timeout: 120_000 }, () => {
  const scratch = `recta_test_people_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  let pool: pg.Pool;
  // Loaded after DATABASE_URL points at the scratch database (the prisma client reads it when imported).
  let prisma: any;
  let sharesSvc: any;
  let settlementsSvc: any;
  let peopleSvc: any;
  let txSvc: any;
  let lock: any;
  let household: { id: string };
  let account: { id: string };

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
    lock = await import('../../shared/db/advisory-lock.js');
    sharesSvc = await import('./shares.service.js');
    settlementsSvc = await import('./settlements.service.js');
    peopleSvc = await import('./people.service.js');
    txSvc = await import('../transactions/transactions.service.js');
    household = await prisma.household.create({ data: { name: 'People test' } });
    account = await prisma.account.create({ data: { householdId: household.id, name: 'Bank', type: 'CHECKING', balance: 0 } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await lock?.closeAdvisoryLockPool();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.end();
  }, 60_000);

  const newTransaction = (description: string) =>
    txSvc.createTransaction({
      householdId: household.id,
      accountId: account.id,
      type: 'EXPENSE',
      categoryName: 'OTHER_EXPENSES',
      amount: 100,
      description,
      date: new Date(2026, 9, 5),
      paid: true,
      isSplit: false,
    });

  it('an amount update and a PUT of shares that coincide never leave shares above the amount', async () => {
    const bia = await peopleSvc.createPerson({ householdId: household.id, name: 'Bia' });
    let violations = 0;
    const outcomes = { amountLowered: 0, sharesKept: 0 };

    for (let round = 0; round < ROUNDS; round += 1) {
      const tx = await newTransaction(`Race ${round}`);
      // Alternate which request starts first, and by how much, so both orders and the overlaps in between happen
      const updateFirst = round % 2 === 0;
      const lag = (round % 9) * 5;
      const update = pause(updateFirst ? 0 : lag).then(() =>
        sharesSvc.updateKeepingShares(household.id, tx.id, { type: 'EXPENSE' }, { amount: 30 }, () =>
          txSvc.updateTransaction(tx.id, household.id, { amount: 30 }),
        ),
      );
      const put = pause(updateFirst ? lag : 0).then(() =>
        sharesSvc.putTransactionShares(household.id, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 80 }] }),
      );
      await Promise.allSettled([update, put]);

      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: tx.id } });
      const shares = await prisma.transactionShare.findMany({ where: { transactionId: tx.id } });
      const sum = shares.reduce((total: number, share: { amount: { toNumber(): number } }) => total + share.amount.toNumber(), 0);
      if (sum > row.amount.toNumber()) violations += 1;
      if (row.amount.toNumber() === 30) outcomes.amountLowered += 1;
      else outcomes.sharesKept += 1;
    }

    expect(violations).toBe(0);
    // Both orders happen, so the test did exercise the two sides of the race
    expect(outcomes.amountLowered, JSON.stringify(outcomes)).toBeGreaterThan(0);
    expect(outcomes.sharesKept, JSON.stringify(outcomes)).toBeGreaterThan(0);
  });

  it('the advisory lock lets one holder in at a time and is free again after a failure', async () => {
    let inside = 0;
    let most = 0;
    const work = async () => {
      inside += 1;
      most = Math.max(most, inside);
      await pause(15);
      inside -= 1;
    };
    await Promise.all(Array.from({ length: 6 }, () => lock.withAdvisoryLock(17, 'same-key', work)));
    expect(most).toBe(1);

    // Different keys do not wait for each other
    inside = 0;
    most = 0;
    await Promise.all(['a', 'b', 'c'].map((key) => lock.withAdvisoryLock(17, key, work)));
    expect(most).toBeGreaterThan(1);

    await expect(lock.withAdvisoryLock(17, 'same-key', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(lock.withAdvisoryLock(17, 'same-key', async () => 'free')).resolves.toBe('free');
  });

  it('applies the migration: people, aliases, shares and settlements work end to end with household scoping', async () => {
    const other = await prisma.household.create({ data: { name: 'Other household' } });
    const ana = await peopleSvc.createPerson({ householdId: household.id, name: 'Ana', aliases: ['Aninha'] });
    await expect(peopleSvc.createPerson({ householdId: household.id, name: 'aninha' })).rejects.toMatchObject({ statusCode: 409 });
    // the same name is free in another household
    await expect(peopleSvc.createPerson({ householdId: other.id, name: 'Ana' })).resolves.toBeTruthy();
    await expect(peopleSvc.updatePerson(other.id, ana.id, { name: 'X' })).rejects.toMatchObject({ statusCode: 404 });

    const tx = await newTransaction('Dinner');
    const put = await sharesSvc.putTransactionShares(household.id, tx.id, {
      direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: ana.id }],
    });
    expect(put.shares.map((s: { amount: number }) => s.amount)).toEqual([50]);
    expect(put.myPart).toBe(50);
    await expect(
      sharesSvc.putTransactionShares(other.id, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: ana.id }] }),
    ).rejects.toMatchObject({ statusCode: 404 });

    // a settlement row is written directly: this module reads settlements, another change writes them
    await prisma.settlement.create({
      data: { householdId: household.id, personId: ana.id, direction: 'RECEIVED', amount: 20, date: new Date('2026-10-06T00:00:00Z') },
    });
    const balances = await peopleSvc.listBalances(household.id);
    expect(balances.find((b: { person: { id: string } }) => b.person.id === ana.id)).toMatchObject({ owedToMe: 50, received: 20, balance: 30 });
    const page = await peopleSvc.getLedger(household.id, ana.id, { limit: 1, order: 'desc' });
    expect(page.pagination).toMatchObject({ total: 2, hasMore: true });
    const next = await peopleSvc.getLedger(household.id, ana.id, { limit: 1, order: 'desc', cursor: page.pagination.nextCursor });
    expect(next.data).toHaveLength(1);
    expect(next.pagination.hasMore).toBe(false);
  });

  it('deleting a transaction removes its shares and only unlinks its settlement; a person with history is deactivated', async () => {
    const cleo = await peopleSvc.createPerson({ householdId: household.id, name: 'Cleo' });
    const tx = await newTransaction('Lunch');
    await sharesSvc.putTransactionShares(household.id, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: cleo.id }] });
    const settlement = await prisma.settlement.create({
      data: { householdId: household.id, personId: cleo.id, transactionId: tx.id, direction: 'RECEIVED', amount: 10, date: new Date('2026-10-06T00:00:00Z') },
    });

    await txSvc.deleteTransaction(tx.id, household.id);

    expect(await prisma.transactionShare.count({ where: { transactionId: tx.id } })).toBe(0);
    expect((await prisma.settlement.findUniqueOrThrow({ where: { id: settlement.id } })).transactionId).toBeNull();
    await expect(peopleSvc.deletePerson(household.id, cleo.id)).resolves.toMatchObject({ deleted: false });
    const dora = await peopleSvc.createPerson({ householdId: household.id, name: 'Dora' });
    await expect(peopleSvc.deletePerson(household.id, dora.id)).resolves.toEqual({ deleted: true });
  });

  it('deleting a person while a share is written for them never loses the share or leaves one without a person', async () => {
    let inconsistent = 0;
    for (let round = 0; round < 20; round += 1) {
      const person = await peopleSvc.createPerson({ householdId: household.id, name: `Racer ${round}` });
      const tx = await newTransaction(`Delete race ${round}`);
      const [removal, write] = await Promise.allSettled([
        peopleSvc.deletePerson(household.id, person.id),
        pause(round % 4).then(() =>
          sharesSvc.putTransactionShares(household.id, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: person.id }] }),
        ),
      ]);
      const row = await prisma.person.findUnique({ where: { id: person.id } });
      const shares = await prisma.transactionShare.count({ where: { transactionId: tx.id } });
      const shareWon = write.status === 'fulfilled' && !!row && !row.isActive && shares === 1;
      const deleteWon = write.status === 'rejected' && !row && shares === 0 && removal.status === 'fulfilled';
      if (!shareWon && !deleteWon) inconsistent += 1;
    }
    expect(inconsistent).toBe(0);
  });

  it('renaming a person many times keeps the most recent aliases, in order, on a real database', async () => {
    const person = await peopleSvc.createPerson({ householdId: household.id, name: 'Rename 0' });
    let last = person;
    for (let i = 1; i <= 25; i += 1) last = await peopleSvc.updatePerson(household.id, person.id, { name: `Rename ${i}` });
    expect(last.aliases).toEqual(Array.from({ length: 20 }, (_, i) => `Rename ${i + 5}`));
  });

  it('a lock connection killed while the work runs does not crash the process, hands the lock to a waiter and leaves no lock behind', async () => {
    const uncaught: Error[] = [];
    const onUncaught = (error: Error) => uncaught.push(error);
    process.on('uncaughtException', onUncaught);
    try {
      let started: () => void = () => undefined;
      const hasStarted = new Promise<void>((resolve) => { started = resolve; });
      let finish: () => void = () => undefined;
      const mayFinish = new Promise<void>((resolve) => { finish = resolve; });
      const holder = lock.withAdvisoryLock(17, 'kill-key', async () => {
        started();
        await mayFinish;
        return 'holder done';
      });
      await hasStarted;
      const waiter = lock.withAdvisoryLock(17, 'kill-key', async () => 'waiter ran');
      await pause(200);

      const dbOid = (await admin.query('SELECT oid FROM pg_database WHERE datname = $1', [scratch])).rows[0].oid;
      const holderPid = (
        await admin.query("SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND database = $1", [dbOid])
      ).rows[0].pid;
      await admin.query('SELECT pg_terminate_backend($1)', [holderPid]);

      // The server released the dead session's lock: the waiter gets it while the holder's work is still going
      await expect(waiter).resolves.toBe('waiter ran');
      finish();
      await expect(holder).resolves.toBe('holder done');
      await pause(100);

      expect(uncaught).toHaveLength(0);
      const left = await admin.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND database = $1", [dbOid]);
      expect(left.rows[0].n).toBe(0);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  });

  it('a request that cannot get a lock connection fails after the timeout instead of waiting forever', async () => {
    let release: () => void = () => undefined;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    // Ten holders on ten keys take every connection of the lock pool
    const holders = Array.from({ length: 10 }, (_, i) => lock.withAdvisoryLock(17, `busy-${i}`, () => hold));
    await pause(300);
    const started = Date.now();
    await expect(lock.withAdvisoryLock(17, 'eleventh', async () => 'never')).rejects.toThrow(/timeout/i);
    expect(Date.now() - started).toBeGreaterThanOrEqual(lock.LOCK_CONNECT_TIMEOUT_MS - 500);
    release();
    await Promise.all(holders);
    await expect(lock.withAdvisoryLock(17, 'eleventh', async () => 'ok')).resolves.toBe('ok');
  });

  it('a settlement creates the real transaction and moves the account, links once, and keeps its transaction when deleted', async () => {
    const eva = await peopleSvc.createPerson({ householdId: household.id, name: 'Eva' });
    const before = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).balance.toNumber();
    const created = await settlementsSvc.createSettlement(household.id, eva.id, {
      householdId: household.id, direction: 'RECEIVED', amount: 25, date: '2026-10-07', createTransaction: { accountId: account.id },
    });
    expect(created.transactionId).toBeTruthy();
    const after = (await prisma.account.findUniqueOrThrow({ where: { id: account.id } })).balance.toNumber();
    expect(Math.round((after - before) * 100)).toBe(2500);

    // the same transaction cannot back two settlements, and a paid settlement cannot link an income
    const again = { householdId: household.id, direction: 'RECEIVED', amount: 25, date: '2026-10-07', transactionId: created.transactionId };
    await expect(settlementsSvc.createSettlement(household.id, eva.id, again)).rejects.toMatchObject({ statusCode: 409 });
    await expect(settlementsSvc.createSettlement(household.id, eva.id, { ...again, direction: 'PAID' })).rejects.toMatchObject({ statusCode: 400 });
    // the type a settled transaction needs is protected against an update that would change it
    await expect(
      sharesSvc.assertUpdateKeepsShares(household.id, created.transactionId, { type: 'INCOME' }, { type: 'EXPENSE' }),
    ).rejects.toMatchObject({ statusCode: 400 });

    await settlementsSvc.deleteSettlement(household.id, created.id);
    expect(await prisma.transaction.findUnique({ where: { id: created.transactionId } })).not.toBeNull();
    await expect(settlementsSvc.deleteSettlement(household.id, created.id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it('linking a transaction to a settlement and changing its type at the same time never leave a received settlement on an expense', async () => {
    const fay = await peopleSvc.createPerson({ householdId: household.id, name: 'Fay' });
    let violations = 0;
    const outcomes = { linked: 0, retyped: 0 };

    for (let round = 0; round < 60; round += 1) {
      const income = await txSvc.createTransaction({
        householdId: household.id, accountId: account.id, type: 'INCOME', categoryName: 'OTHER_INCOME', amount: 40,
        description: `Link race ${round}`, date: new Date(2026, 9, 5), paid: true, isSplit: false,
      });
      // Alternate which request starts first, and by how much
      const linkFirst = round % 2 === 0;
      const lag = (round % 10) * 4;
      const link = pause(linkFirst ? 0 : lag).then(() =>
        settlementsSvc.createSettlement(household.id, fay.id, {
          householdId: household.id, direction: 'RECEIVED', amount: 40, date: '2026-10-07', transactionId: income.id,
        }),
      );
      const retype = pause(linkFirst ? lag : 0).then(() =>
        sharesSvc.updateKeepingShares(household.id, income.id, { type: 'INCOME' }, { type: 'EXPENSE' }, () =>
          txSvc.updateTransaction(income.id, household.id, { type: 'EXPENSE', categoryName: 'OTHER_EXPENSES' }),
        ),
      );
      await Promise.allSettled([link, retype]);

      const row = await prisma.transaction.findUniqueOrThrow({ where: { id: income.id } });
      const settlement = await prisma.settlement.findFirst({ where: { transactionId: income.id } });
      if (settlement && row.type !== 'INCOME') violations += 1;
      if (settlement) outcomes.linked += 1;
      else outcomes.retyped += 1;
    }

    expect(violations).toBe(0);
    // Both orders happen, so the test did exercise the two sides of the race
    expect(outcomes.linked, JSON.stringify(outcomes)).toBeGreaterThan(0);
    expect(outcomes.retyped, JSON.stringify(outcomes)).toBeGreaterThan(0);
  });
});
