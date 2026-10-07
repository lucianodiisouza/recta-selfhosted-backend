import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const db: { category: Row[]; transaction: Row[]; recurringTransaction: Row[]; budget: Row[]; locks: string[]; lockSql: string[] } = {
  category: [], transaction: [], recurringTransaction: [], budget: [], locks: [], lockSql: [],
};
const data = () => JSON.stringify({ ...db, locks: [], lockSql: [] });
const match = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'in' in v) return (v.in as unknown[]).some((x) => (x instanceof Date ? x.getTime() === row[k].getTime() : x === row[k]));
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });
const table = (name: 'category' | 'transaction' | 'recurringTransaction' | 'budget') => ({
  findFirst: async ({ where }: { where: Row }) => db[name].find((r) => match(r, where)) ?? null,
  findUnique: async ({ where }: { where: Row }) => db[name].find((r) => match(r, where)) ?? null,
  findMany: async ({ where }: { where: Row }) => db[name].filter((r) => match(r, where)),
  count: async ({ where }: { where: Row }) => db[name].filter((r) => match(r, where)).length,
  updateMany: async ({ where, data }: { where: Row; data: Row }) => {
    const rows = db[name].filter((r) => match(r, where));
    rows.forEach((r) => Object.assign(r, data));
    return { count: rows.length };
  },
  update: async ({ where, data }: { where: Row; data: Row }) => {
    const row = db[name].find((r) => match(r, where))!;
    for (const [k, v] of Object.entries(data)) row[k] = v && typeof v === 'object' && 'increment' in v ? row[k] + Number(v.increment) : v;
    return row;
  },
  delete: async ({ where }: { where: Row }) => {
    db[name] = db[name].filter((r) => !match(r, where));
  },
});

vi.mock('../../shared/db/prisma.js', () => {
  const client: Row = {
    category: table('category'), transaction: table('transaction'), recurringTransaction: table('recurringTransaction'), budget: table('budget'),
    $queryRaw: async (strings: TemplateStringsArray, id: string) => {
      const sql = strings.join('?');
      if (!sql.includes('FOR UPDATE')) throw new Error('unexpected raw query');
      db.locks.push(id);
      db.lockSql.push(sql);
      return [{ id }];
    },
  };
  client.$transaction = async (fn: (tx: Row) => unknown) => fn(client);
  return { prisma: client };
});

const { mergeCategory } = await import('./categories.merge.service.js');

const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const OTHER_HOUSEHOLD = '22222222-2222-4222-8222-222222222222';
const SRC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const DST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const EXP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const FOREIGN = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

beforeEach(() => {
  db.locks = [];
  db.lockSql = [];
  db.category = [
    { id: SRC, householdId: HOUSEHOLD, name: 'Teste Origem', type: 'INCOME' },
    { id: DST, householdId: HOUSEHOLD, name: 'Teste Destino', type: 'INCOME' },
    { id: EXP, householdId: HOUSEHOLD, name: 'Teste Despesa', type: 'EXPENSE' },
    { id: FOREIGN, householdId: OTHER_HOUSEHOLD, name: 'Teste Alheia', type: 'INCOME' },
  ];
  db.transaction = [
    { id: 't1', householdId: HOUSEHOLD, categoryName: `CUSTOM:${SRC}` },
    { id: 't2', householdId: HOUSEHOLD, categoryName: `CUSTOM:${SRC}` },
    { id: 't3', householdId: HOUSEHOLD, categoryName: `CUSTOM:${DST}` },
    { id: 't4', householdId: OTHER_HOUSEHOLD, categoryName: `CUSTOM:${SRC}` },
  ];
  db.recurringTransaction = [{ id: 'r1', householdId: HOUSEHOLD, categoryName: `CUSTOM:${SRC}` }];
  db.budget = [
    { id: 'b1', householdId: HOUSEHOLD, categoryName: `CUSTOM:${SRC}`, month: new Date('2026-01-01'), monthlyLimit: 100 },
    { id: 'b2', householdId: HOUSEHOLD, categoryName: `CUSTOM:${SRC}`, month: new Date('2026-02-01'), monthlyLimit: 50 },
    { id: 'b3', householdId: HOUSEHOLD, categoryName: `CUSTOM:${DST}`, month: new Date('2026-01-01'), monthlyLimit: 30 },
  ];
});

describe('mergeCategory', () => {
  it('moves transactions, recurrences and budgets to a custom target and deletes the source', async () => {
    const result = await mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: DST, preview: false });
    expect(result.counts).toEqual({ transactions: 2, recurringTransactions: 1, budgets: 1, budgetsCombined: 1 });
    expect(result.preview).toBe(false);
    expect(db.category.map((c) => c.id)).not.toContain(SRC);
    expect(db.transaction.filter((t) => t.categoryName === `CUSTOM:${DST}`).map((t) => t.id).sort()).toEqual(['t1', 't2', 't3']);
    expect(db.transaction.find((t) => t.id === 't4')!.categoryName).toBe(`CUSTOM:${SRC}`); // other household untouched
    expect(db.recurringTransaction[0].categoryName).toBe(`CUSTOM:${DST}`);
    expect(db.budget.find((b) => b.id === 'b3')!.monthlyLimit).toBe(130); // limits of a shared month are added
    expect(db.budget.find((b) => b.id === 'b2')!.categoryName).toBe(`CUSTOM:${DST}`);
    expect(db.budget.find((b) => b.id === 'b1')).toBeUndefined();
  });

  it('locks source and target in id order', async () => {
    await mergeCategory(HOUSEHOLD, { sourceId: DST, targetCategoryId: SRC, preview: false });
    expect(db.locks).toEqual([SRC, DST]);
  });

  it('locks only rows of the household: a category of another household is not even locked before the 404', async () => {
    await mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: DST, preview: false });
    expect(db.lockSql).toHaveLength(2);
    expect(db.lockSql.every((sql) => sql.includes('household_id = ?::uuid') && sql.includes('FOR UPDATE'))).toBe(true);
  });

  it('moves to a system category by enum value', async () => {
    const result = await mergeCategory(HOUSEHOLD, { sourceId: SRC, targetSystemName: 'INVESTMENTS' as never, preview: false });
    expect(result.target).toEqual({ id: 'INVESTMENTS', name: 'Investimentos', isSystem: true });
    expect(db.transaction.filter((t) => t.categoryName === 'INVESTMENTS')).toHaveLength(2);
    expect(db.recurringTransaction[0].categoryName).toBe('INVESTMENTS');
  });

  it('preview returns the counts and writes nothing', async () => {
    const before = data();
    const result = await mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: DST, preview: true });
    expect(result.preview).toBe(true);
    expect(result.counts).toEqual({ transactions: 2, recurringTransactions: 1, budgets: 1, budgetsCombined: 1 });
    expect(data()).toBe(before);
    expect(db.locks).toEqual([]);
  });

  it('a second merge of the same source is a 404 and moves nothing', async () => {
    await mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: DST, preview: false });
    const snapshot = data();
    await expect(mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: DST, preview: false })).rejects.toMatchObject({ statusCode: 404 });
    expect(data()).toBe(snapshot);
  });

  it('refuses a self merge', async () => {
    await expect(mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: SRC, preview: false })).rejects.toMatchObject({ code: 'CATEGORY_MERGE_SELF' });
  });

  it('refuses another type, custom or system, without changing anything', async () => {
    const snapshot = data();
    await expect(mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: EXP, preview: false })).rejects.toMatchObject({ code: 'CATEGORY_MERGE_TYPE_MISMATCH' });
    await expect(mergeCategory(HOUSEHOLD, { sourceId: SRC, targetSystemName: 'FOOD' as never, preview: false })).rejects.toMatchObject({ code: 'CATEGORY_MERGE_TYPE_MISMATCH' });
    expect(data()).toBe(snapshot);
  });

  it('refuses the movement markers as a target', async () => {
    await expect(mergeCategory(HOUSEHOLD, { sourceId: SRC, targetSystemName: 'TRANSFER' as never, preview: false })).rejects.toMatchObject({ code: 'CATEGORY_MERGE_TARGET_INVALID' });
  });

  it('a target of another household does not exist', async () => {
    await expect(mergeCategory(HOUSEHOLD, { sourceId: SRC, targetCategoryId: FOREIGN, preview: false })).rejects.toMatchObject({ statusCode: 404 });
    expect(db.category.map((c) => c.id)).toContain(SRC);
  });
});
