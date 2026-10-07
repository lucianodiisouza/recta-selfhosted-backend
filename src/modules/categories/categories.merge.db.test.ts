import { execSync } from 'node:child_process';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Real-Postgres test of the category merge, rename and delete rules and of the locks every category writer takes. It is
 * skipped unless TEST_DATABASE_ADMIN_URL is set, so `npm test` and CI never need a database.
 *
 *   TEST_DATABASE_ADMIN_URL=postgresql://user:password@localhost:5432/postgres npm test -- categories.merge.db
 *
 * It CREATES a scratch database named recta_test_category_<timestamp> on that server, applies the migrations to it, runs
 * and DROPS it. It never touches any other database. The mocked tests next to it cover the logic; this one covers what a
 * mock cannot: row locks, concurrent merges, deadlock-free lock order and orphan references after a race.
 */
const ADMIN_URL = process.env.TEST_DATABASE_ADMIN_URL;

describe.skipIf(!ADMIN_URL)('category merge against a real database', { timeout: 60_000 }, () => {
  const scratch = `recta_test_category_${Date.now()}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  let pool: pg.Pool;
  // Loaded after DATABASE_URL points at the scratch database (the prisma client reads it when imported).
  let prisma: any;
  let catSvc: any;
  let txSvc: any;
  let recSvc: any;
  let budSvc: any;
  let detSvc: any;
  let mergeCategory: (householdId: string, input: any) => Promise<any>;
  let household: { id: string };
  let other: { id: string };
  let cash: { id: string };
  let otherCash: { id: string };

  const mk = (householdId: string, name: string, type: 'INCOME' | 'EXPENSE') => prisma.category.create({ data: { householdId, name, type } });
  const month = (m: number) => new Date(Date.UTC(2026, m - 1, 1));
  const ref = (c: { id: string }) => `CUSTOM:${c.id}`;
  const counts = async (householdId: string, name: string) => ({
    tx: await prisma.transaction.count({ where: { householdId, categoryName: name } }),
    rec: await prisma.recurringTransaction.count({ where: { householdId, categoryName: name } }),
    bud: await prisma.budget.count({ where: { householdId, categoryName: name } }),
  });
  const addTx = (householdId: string, accountId: string, categoryName: string, amount = 10, type: 'INCOME' | 'EXPENSE' = 'INCOME') =>
    prisma.transaction.create({ data: { householdId, accountId, type, categoryName, amount, description: 'x', date: new Date(Date.UTC(2026, 0, 5)), paid: true } });
  const addRec = (householdId: string, accountId: string, categoryName: string, day = 1) =>
    prisma.recurringTransaction.create({ data: { householdId, accountId, categoryName, amount: 5, frequency: 'MONTHLY', startDate: new Date(Date.UTC(2026, 1, day)), nextRunAt: new Date(Date.UTC(2026, 1, day)) } });
  const status = async (p: Promise<unknown>): Promise<number> => ((await p.then(() => null, (e: { statusCode?: number }) => e)) as { statusCode?: number } | null)?.statusCode ?? 200;
  const errorCode = async (p: Promise<unknown>): Promise<string | undefined> => ((await p.then(() => null, (e: { code?: string }) => e)) as { code?: string } | null)?.code;
  const newTx = (categoryName: string, type: 'INCOME' | 'EXPENSE' = 'EXPENSE') =>
    txSvc.createTransaction({ householdId: household.id, accountId: cash.id, type, categoryName, amount: 1, description: 'race', date: new Date(Date.UTC(2026, 0, 6)), paid: true, isSplit: false });

  beforeAll(async () => {
    await admin.connect();
    await admin.query(`CREATE DATABASE "${scratch}"`);
    const url = new URL(ADMIN_URL!);
    url.pathname = `/${scratch}`;
    execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url.toString() } });
    process.env.DATABASE_URL = url.toString();
    // The app builds its client from DATABASE_URL on import and reuses globalThis.__prisma when it is set. Building it here
    // keeps hold of the pool, so it can be closed before the database is dropped.
    pool = new pg.Pool({ connectionString: url.toString() });
    const { PrismaClient } = await import('../../generated/prisma/client.js');
    const { PrismaPg } = await import('@prisma/adapter-pg');
    (globalThis as { __prisma?: unknown }).__prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
    ({ prisma } = await import('../../shared/db/prisma.js'));
    catSvc = await import('./categories.service.js');
    txSvc = await import('../transactions/transactions.service.js');
    recSvc = await import('../recurring-transactions/recurring-transactions.service.js');
    budSvc = await import('../budgets/budgets.service.js');
    detSvc = await import('../recurring-transactions/recurring-detect.service.js');
    ({ mergeCategory } = await import('./categories.merge.service.js'));
    household = await prisma.household.create({ data: { name: 'Merge test' } });
    other = await prisma.household.create({ data: { name: 'Merge test other' } });
    cash = await prisma.account.create({ data: { householdId: household.id, name: 'Cash', type: 'CHECKING' } });
    otherCash = await prisma.account.create({ data: { householdId: other.id, name: 'Cash', type: 'CHECKING' } });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await pool?.end();
    await admin.query(`DROP DATABASE IF EXISTS "${scratch}"`);
    await admin.end();
  }, 60_000);

  it('merges custom into custom across every table, adds budgets of a shared month and leaves another household alone', async () => {
    const a = await mk(household.id, 'Source A', 'INCOME');
    const b = await mk(household.id, 'Target B', 'INCOME');
    const foreign = await mk(other.id, 'Source A', 'INCOME');
    for (let i = 0; i < 5; i++) await addTx(household.id, cash.id, ref(a));
    await addTx(household.id, cash.id, ref(b));
    await addTx(other.id, otherCash.id, ref(foreign));
    await addRec(household.id, cash.id, ref(a));
    await addRec(household.id, cash.id, ref(a));
    await prisma.budget.create({ data: { householdId: household.id, categoryName: ref(a), monthlyLimit: 100, month: month(1), type: 'INCOME' } });
    await prisma.budget.create({ data: { householdId: household.id, categoryName: ref(a), monthlyLimit: 40, month: month(2), type: 'INCOME' } });
    await prisma.budget.create({ data: { householdId: household.id, categoryName: ref(b), monthlyLimit: 30, month: month(1), type: 'INCOME' } });

    const preview = await mergeCategory(household.id, { sourceId: a.id, targetCategoryId: b.id, preview: true });
    expect(preview.counts).toEqual({ transactions: 5, recurringTransactions: 2, budgets: 1, budgetsCombined: 1 });
    expect((await counts(household.id, ref(a))).tx).toBe(5);
    expect(await prisma.category.count({ where: { id: a.id } })).toBe(1);

    const done = await mergeCategory(household.id, { sourceId: a.id, targetCategoryId: b.id, preview: false });
    expect(done.counts).toEqual(preview.counts);
    expect(await counts(household.id, ref(b))).toEqual({ tx: 6, rec: 2, bud: 2 });
    const combined = await prisma.budget.findFirstOrThrow({ where: { householdId: household.id, categoryName: ref(b), month: month(1) } });
    expect(combined.monthlyLimit.toNumber()).toBe(130);
    expect(await prisma.category.count({ where: { id: a.id } })).toBe(0);
    expect(await counts(household.id, ref(a))).toEqual({ tx: 0, rec: 0, bud: 0 });
    expect((await counts(other.id, ref(foreign))).tx).toBe(1);
    expect(await prisma.category.count({ where: { id: foreign.id } })).toBe(1);

    // Idempotency: the same merge again is a 404 and moves nothing.
    expect(await status(mergeCategory(household.id, { sourceId: a.id, targetCategoryId: b.id, preview: false }))).toBe(404);
    expect((await counts(household.id, ref(b))).tx).toBe(6);
  });

  it('merges into a system category by rewriting references to the enum value', async () => {
    const inv = await mk(household.id, 'Investment', 'INCOME');
    await addTx(household.id, cash.id, ref(inv));
    await addRec(household.id, cash.id, ref(inv));
    const result = await mergeCategory(household.id, { sourceId: inv.id, targetSystemName: 'INVESTMENTS', preview: false });
    expect(result.target.isSystem).toBe(true);
    expect(await counts(household.id, 'INVESTMENTS')).toMatchObject({ tx: 1, rec: 1 });
  });

  it('refuses self merges, other types, other households and unknown sources without changing anything', async () => {
    const exp = await mk(household.id, 'Expense X', 'EXPENSE');
    const inc = await mk(household.id, 'Income Y', 'INCOME');
    const foreign = await mk(other.id, 'Foreign', 'INCOME');
    await addTx(household.id, cash.id, ref(inc));
    const refusal = (input: Record<string, unknown>) => errorCode(mergeCategory(household.id, { preview: false, ...input }));
    expect(await refusal({ sourceId: inc.id, targetCategoryId: inc.id })).toBe('CATEGORY_MERGE_SELF');
    expect(await refusal({ sourceId: inc.id, targetCategoryId: exp.id })).toBe('CATEGORY_MERGE_TYPE_MISMATCH');
    expect(await refusal({ sourceId: inc.id, targetSystemName: 'FOOD' })).toBe('CATEGORY_MERGE_TYPE_MISMATCH');
    expect(await refusal({ sourceId: '00000000-0000-4000-8000-000000000000', targetSystemName: 'SALARY' })).toBe('NOT_FOUND');
    expect(await refusal({ sourceId: inc.id, targetCategoryId: foreign.id })).toBe('NOT_FOUND');
    expect((await counts(household.id, ref(inc))).tx).toBe(1);
    expect(await prisma.category.count({ where: { id: inc.id } })).toBe(1);
  });

  it('serializes six identical concurrent merges: one wins, the rest are 404, rows move exactly once', async () => {
    const s1 = await mk(household.id, 'Race source', 'EXPENSE');
    const t1 = await mk(household.id, 'Race target', 'EXPENSE');
    for (let i = 0; i < 30; i++) await addTx(household.id, cash.id, ref(s1), 1, 'EXPENSE');
    await addRec(household.id, cash.id, ref(s1));
    const results = await Promise.allSettled(Array.from({ length: 6 }, () => mergeCategory(household.id, { sourceId: s1.id, targetCategoryId: t1.id, preview: false })));
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((r) => r.status === 'rejected' && (r.reason as { statusCode?: number }).statusCode === 404)).toHaveLength(5);
    expect(await counts(household.id, ref(t1))).toMatchObject({ tx: 30, rec: 1 });
  });

  it('opposite merges at once (A into B and B into A) never deadlock and always leave one survivor with every row', async () => {
    let unexpected = 0;
    let bad = 0;
    for (let round = 0; round < 10; round++) {
      const x = await mk(household.id, `X${round}`, 'EXPENSE');
      const y = await mk(household.id, `Y${round}`, 'EXPENSE');
      for (let i = 0; i < 3; i++) {
        await addTx(household.id, cash.id, ref(x), 1, 'EXPENSE');
        await addTx(household.id, cash.id, ref(y), 1, 'EXPENSE');
      }
      const res = await Promise.allSettled([
        mergeCategory(household.id, { sourceId: x.id, targetCategoryId: y.id, preview: false }),
        mergeCategory(household.id, { sourceId: y.id, targetCategoryId: x.id, preview: false }),
      ]);
      unexpected += res.filter((r) => r.status === 'rejected' && (r.reason as { statusCode?: number }).statusCode !== 404).length;
      const survivors = await prisma.category.findMany({ where: { id: { in: [x.id, y.id] } } });
      if (survivors.length !== 1 || (await counts(household.id, ref(survivors[0]))).tx !== 6) bad += 1;
    }
    expect(unexpected).toBe(0);
    expect(bad).toBe(0);
  });

  it('refuses to delete a category in use, deletes an unused one, and renames by id keeping every reference', async () => {
    const used = await mk(household.id, 'In use', 'EXPENSE');
    await addTx(household.id, cash.id, ref(used), 1, 'EXPENSE');
    expect(await errorCode(catSvc.deleteCategory(used.id, household.id))).toBe('CATEGORY_IN_USE');
    const unused = await mk(household.id, 'Unused', 'EXPENSE');
    await catSvc.deleteCategory(unused.id, household.id);
    expect(await prisma.category.count({ where: { id: unused.id } })).toBe(0);

    const ren = await mk(household.id, 'Old name', 'EXPENSE');
    const row = await addTx(household.id, cash.id, ref(ren), 3, 'EXPENSE');
    await catSvc.updateCategory(ren.id, household.id, { name: 'New name', color: '#112233' });
    const renamed = await prisma.category.findUniqueOrThrow({ where: { id: ren.id } });
    expect(renamed).toMatchObject({ name: 'New name', color: '#112233' });
    expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).categoryName).toBe(ref(ren));
  });

  it('keeps names unique per household and type (case, accents and system names included), also under concurrent creates', async () => {
    await mk(household.id, 'Taken name', 'EXPENSE');
    const ren = await mk(household.id, 'Will rename', 'EXPENSE');
    expect(await errorCode(catSvc.updateCategory(ren.id, household.id, { name: 'taken NAME' }))).toBe('CATEGORY_NAME_TAKEN');
    expect(await errorCode(catSvc.createCategory({ householdId: household.id, name: ' TAKEN   name ', type: 'EXPENSE' }))).toBe('CATEGORY_NAME_TAKEN');
    expect(await errorCode(catSvc.createCategory({ householdId: household.id, name: 'alimentacao', type: 'EXPENSE' }))).toBe('CATEGORY_NAME_TAKEN');
    expect(await errorCode(catSvc.createCategory({ householdId: household.id, name: 'Alimentação', type: 'INCOME' }))).toBeUndefined();
    const racing = await Promise.allSettled(Array.from({ length: 4 }, () => catSvc.createCategory({ householdId: household.id, name: 'Race name', type: 'EXPENSE' })));
    expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(racing.filter((r) => r.status === 'rejected' && (r.reason as { code?: string }).code === 'CATEGORY_NAME_TAKEN')).toHaveLength(3);
  });

  it('refuses every writer that names a merged category, with a clean 400 and no write', async () => {
    const gone = await mk(household.id, 'Merged away', 'EXPENSE');
    const keep = await mk(household.id, 'Merged into', 'EXPENSE');
    await mergeCategory(household.id, { sourceId: gone.id, targetCategoryId: keep.id, preview: false });
    expect(await status(newTx(ref(gone)))).toBe(400);
    const live = await newTx(ref(keep));
    expect(await status(txSvc.updateTransaction(live.id, household.id, { categoryName: ref(gone) }))).toBe(400);
    expect(await status(recSvc.createRecurringTransaction({ householdId: household.id, accountId: cash.id, categoryName: ref(gone), amount: 1, frequency: 'MONTHLY', startDate: new Date(Date.UTC(2026, 5, 1)), nextRunAt: new Date(Date.UTC(2026, 6, 1)), isActive: true, followLastAmount: false }))).toBe(400);
    expect(await status(budSvc.createBudget({ householdId: household.id, categoryName: ref(gone), monthlyLimit: 10, month: new Date(Date.UTC(2026, 5, 1)), type: 'EXPENSE' }))).toBe(400);
    const batch = (name: string) => txSvc.batchCreateTransactions({
      householdId: household.id,
      transactions: [
        { accountId: cash.id, categoryName: name, amount: 2, description: 'b1', date: new Date(Date.UTC(2026, 0, 7)), paid: true },
        { accountId: cash.id, categoryName: name, amount: 3, description: 'b2', date: new Date(Date.UTC(2026, 0, 8)), paid: true },
      ],
    });
    expect(await status(batch(ref(gone)))).toBe(400);
    expect((await counts(household.id, ref(gone))).tx).toBe(0);
  });

  it('merge racing creates: no orphan, every accepted row ends on the target, refusals are clean 400s', async () => {
    let orphans = 0;
    let unexpected = 0;
    for (let round = 0; round < 15; round++) {
      const src = await mk(household.id, `Race S${round}`, 'EXPENSE');
      const dst = await mk(household.id, `Race D${round}`, 'EXPENSE');
      const writers = Array.from({ length: 6 }, () => newTx(ref(src)));
      const [, ...results] = await Promise.allSettled([mergeCategory(household.id, { sourceId: src.id, targetCategoryId: dst.id, preview: false }), ...writers]);
      unexpected += results.filter((r) => r.status === 'rejected' && (r.reason as { statusCode?: number }).statusCode !== 400).length;
      orphans += await prisma.transaction.count({ where: { householdId: household.id, categoryName: ref(src) } });
      if ((await counts(household.id, ref(dst))).tx !== results.filter((r) => r.status === 'fulfilled').length) orphans += 1;
    }
    expect(orphans).toBe(0);
    expect(unexpected).toBe(0);
  });

  it('a delete racing six creates never leaves a row on a deleted category, and the refused creates are clean 400s', async () => {
    let orphans = 0;
    let unexpected = 0;
    for (let round = 0; round < 20; round++) {
      const cat = await mk(household.id, `Delete race ${round}`, 'EXPENSE');
      const writers = Array.from({ length: 6 }, () => newTx(ref(cat)));
      const [deleted, ...results] = await Promise.allSettled([catSvc.deleteCategory(cat.id, household.id), ...writers]);
      unexpected += results.filter((r) => r.status === 'rejected' && (r.reason as { statusCode?: number }).statusCode !== 400).length;
      const gone = (await prisma.category.count({ where: { id: cat.id } })) === 0;
      // Either the category survived (a create got there first and the delete was refused as in use), or it is gone and no
      // row points at it.
      if (gone && (await counts(household.id, ref(cat))).tx > 0) orphans += 1;
      if (!gone && deleted.status === 'fulfilled') orphans += 1;
    }
    expect(orphans).toBe(0);
    expect(unexpected).toBe(0);
  });

  it('batch create racing a merge leaves no orphan', async () => {
    const bs = await mk(household.id, 'Batch S', 'EXPENSE');
    const bd = await mk(household.id, 'Batch D', 'EXPENSE');
    const one = () => txSvc.batchCreateTransactions({
      householdId: household.id,
      transactions: [
        { accountId: cash.id, categoryName: ref(bs), amount: 2, description: 'b1', date: new Date(Date.UTC(2026, 0, 7)), paid: true },
        { accountId: cash.id, categoryName: ref(bs), amount: 3, description: 'b2', date: new Date(Date.UTC(2026, 0, 8)), paid: true },
      ],
    });
    const race = await Promise.allSettled([mergeCategory(household.id, { sourceId: bs.id, targetCategoryId: bd.id, preview: false }), ...Array.from({ length: 4 }, one)]);
    const accepted = race.slice(1).filter((r) => r.status === 'fulfilled').length;
    expect((await counts(household.id, ref(bs))).tx).toBe(0);
    expect((await counts(household.id, ref(bd))).tx).toBe(accepted * 2);
  });

  it('a recurrence executed while a merge commits between its read and its write is created on the target, never orphaned', async () => {
    const es = await mk(household.id, 'Exec S', 'EXPENSE');
    const ed = await mk(household.id, 'Exec D', 'EXPENSE');
    const rec = await addRec(household.id, cash.id, ref(es), 10);
    const delegate = prisma.recurringTransaction as { findFirst: (...args: unknown[]) => Promise<unknown> };
    const realFindFirst = delegate.findFirst.bind(delegate);
    let interleave = true;
    delegate.findFirst = async (...args: unknown[]) => {
      const row = await realFindFirst(...args);
      if (interleave) {
        interleave = false;
        await mergeCategory(household.id, { sourceId: es.id, targetCategoryId: ed.id, preview: false });
      }
      return row; // the stale read, from before the merge
    };
    try {
      const executed = await recSvc.executeRecurringTransaction(rec.id, household.id, { paid: false });
      expect(executed.transaction.categoryName).toBe(ref(ed));
      expect((await counts(household.id, ref(es))).tx).toBe(0);
    } finally {
      delegate.findFirst = realFindFirst;
    }
  });

  it('a merge racing four recurrence executions leaves no orphan and fails none of them', async () => {
    let orphans = 0;
    let failed = 0;
    for (let round = 0; round < 12; round++) {
      const rs = await mk(household.id, `ExecRace S${round}`, 'EXPENSE');
      const rd = await mk(household.id, `ExecRace D${round}`, 'EXPENSE');
      const recs = await Promise.all([1, 2, 3, 4].map((i) => addRec(household.id, cash.id, ref(rs), 10 + i)));
      const res = await Promise.allSettled([
        mergeCategory(household.id, { sourceId: rs.id, targetCategoryId: rd.id, preview: false }),
        ...recs.map((r: { id: string }) => recSvc.executeRecurringTransaction(r.id, household.id, { paid: false })),
      ]);
      failed += res.slice(1).filter((r) => r.status === 'rejected').length;
      const left = await counts(household.id, ref(rs));
      orphans += left.tx + left.rec;
    }
    expect(orphans).toBe(0);
    expect(failed).toBe(0);
  });

  it('detection apply racing a merge never deadlocks and leaves nothing on the merged category', async () => {
    const WORDS = ['Alfa', 'Beta', 'Gama', 'Delta', 'Epsilon', 'Zeta', 'Eta', 'Teta']; // digits are ignored by the matcher: letters keep the rounds apart
    let deadlocks = 0;
    let orphans = 0;
    for (let round = 0; round < WORDS.length; round++) {
      const ds = await mk(household.id, `Detect S${round}`, 'EXPENSE');
      const dd = await mk(household.id, `Detect D${round}`, 'EXPENSE');
      for (let m = 0; m < 4; m++) {
        await prisma.transaction.create({ data: { householdId: household.id, accountId: cash.id, type: 'EXPENSE', categoryName: ref(ds), amount: 31.9, description: `Subscription ${WORDS[round]}`, date: new Date(Date.UTC(2026, 3 + m, 12)), paid: true } });
      }
      const now = new Date(Date.UTC(2026, 7, 20));
      const found = await detSvc.detectRecurringTransactions({ householdId: household.id }, now);
      const mine = found.candidates.filter((c: { description: string }) => c.description.includes(WORDS[round]));
      expect(mine.length, `round ${round} detects its group`).toBeGreaterThan(0);
      const res = await Promise.allSettled([
        mergeCategory(household.id, { sourceId: ds.id, targetCategoryId: dd.id, preview: false }),
        detSvc.applyDetectedRecurrences({ householdId: household.id, items: mine.map((c: { id: string }) => ({ id: c.id })) }, now),
      ]);
      deadlocks += res.filter((r) => r.status === 'rejected' && String((r.reason as { message?: string }).message).includes('deadlock')).length;
      const left = await counts(household.id, ref(ds));
      orphans += left.tx + left.rec;
    }
    expect(deadlocks).toBe(0);
    expect(orphans).toBe(0);
  });
});
