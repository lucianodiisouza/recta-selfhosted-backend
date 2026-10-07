import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, any>;
const db: { category: Row[]; transaction: Row[]; recurringTransaction: Row[]; budget: Row[]; rawCalls: string[]; failNextCreate: unknown } = {
  category: [], transaction: [], recurringTransaction: [], budget: [], rawCalls: [], failNextCreate: null,
};
const HOUSEHOLD = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const CAT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SIBLING = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const match = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && 'not' in v) return row[k] !== v.not;
    return row[k] === v;
  });

vi.mock('../../shared/db/prisma.js', () => {
  const client: Row = {
    category: {
      findFirst: async ({ where }: { where: Row }) => db.category.find((r) => match(r, where)) ?? null,
      findMany: async ({ where }: { where: Row }) => db.category.filter((r) => match(r, where)),
      create: async ({ data }: { data: Row }) => {
        if (db.failNextCreate) throw db.failNextCreate;
        const row = { id: `new-${db.category.length}`, ...data };
        db.category.push(row);
        return row;
      },
      update: async ({ where, data }: { where: Row; data: Row }) => {
        const row = db.category.find((r) => match(r, where))!;
        Object.assign(row, data);
        return row;
      },
      delete: async ({ where }: { where: Row }) => {
        db.category = db.category.filter((r) => !match(r, where));
      },
    },
    transaction: {
      count: async ({ where }: { where: Row }) => db.transaction.filter((r) => match(r, where)).length,
      groupBy: async () => groups(db.transaction),
    },
    recurringTransaction: {
      count: async ({ where }: { where: Row }) => db.recurringTransaction.filter((r) => match(r, where)).length,
      groupBy: async () => groups(db.recurringTransaction),
    },
    budget: {
      count: async ({ where }: { where: Row }) => db.budget.filter((r) => match(r, where)).length,
      groupBy: async () => groups(db.budget),
    },
    $queryRaw: async (strings: TemplateStringsArray, id: string, householdId: string) => {
      db.rawCalls.push(strings.join('?'));
      return db.category.some((c) => c.id === id && c.householdId === householdId) ? [{ id }] : [];
    },
  };
  client.$transaction = async (fn: (tx: Row) => unknown) => fn(client);
  return { prisma: client };
});

function groups(rows: Row[]) {
  const counts = new Map<string, number>();
  for (const r of rows) if (r.categoryName) counts.set(r.categoryName, (counts.get(r.categoryName) ?? 0) + 1);
  return [...counts.entries()].map(([categoryName, n]) => ({ categoryName, _count: { _all: n } }));
}

const { createCategory, updateCategory, deleteCategory, getCategoryUsage } = await import('./categories.service.js');
const { Prisma } = await import('../../generated/prisma/client.js');

beforeEach(() => {
  db.rawCalls = [];
  db.failNextCreate = null;
  db.category = [
    { id: CAT, householdId: HOUSEHOLD, name: 'Despesa X', type: 'EXPENSE', icon: null, color: null },
    { id: SIBLING, householdId: HOUSEHOLD, name: 'Outra', type: 'EXPENSE', icon: null, color: null },
    { id: 'other-household', householdId: OTHER, name: 'Spare', type: 'EXPENSE', icon: null, color: null },
  ];
  db.transaction = [];
  db.recurringTransaction = [];
  db.budget = [];
});

const code = async (fn: () => Promise<unknown>): Promise<string | undefined> =>
  ((await fn().then(() => null, (e: { code?: string }) => e)) as { code?: string } | null)?.code;

describe('createCategory name rules', () => {
  it('refuses a name that another custom category of the household and type already has, ignoring case, accents and spaces', async () => {
    expect(await code(() => createCategory({ householdId: HOUSEHOLD, name: ' DESPESA   x ', type: 'EXPENSE' } as never))).toBe('CATEGORY_NAME_TAKEN');
  });

  it('refuses a name equal to a system category of the same type', async () => {
    expect(await code(() => createCategory({ householdId: HOUSEHOLD, name: 'alimentacao', type: 'EXPENSE' } as never))).toBe('CATEGORY_NAME_TAKEN');
    expect(await code(() => createCategory({ householdId: HOUSEHOLD, name: 'investimentos', type: 'INCOME' } as never))).toBe('CATEGORY_NAME_TAKEN');
  });

  it('allows the same name on the other type, in another household, and a genuinely new name', async () => {
    expect(await code(() => createCategory({ householdId: HOUSEHOLD, name: 'Despesa X', type: 'INCOME' } as never))).toBeUndefined();
    expect(await code(() => createCategory({ householdId: OTHER, name: 'Despesa X', type: 'EXPENSE' } as never))).toBeUndefined();
    expect(await code(() => createCategory({ householdId: HOUSEHOLD, name: 'Presentes', type: 'EXPENSE' } as never))).toBeUndefined();
  });

  it('turns the unique-index violation of a racing create into the same CATEGORY_NAME_TAKEN', async () => {
    db.failNextCreate = new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });
    expect(await code(() => createCategory({ householdId: HOUSEHOLD, name: 'Presentes', type: 'EXPENSE' } as never))).toBe('CATEGORY_NAME_TAKEN');
  });

  it('lets any other database error through untouched', async () => {
    db.failNextCreate = new Error('connection lost');
    await expect(createCategory({ householdId: HOUSEHOLD, name: 'Presentes', type: 'EXPENSE' } as never)).rejects.toThrow('connection lost');
  });
});

describe('updateCategory (rename, colour, icon)', () => {
  it('renames by id and changes colour and icon without checking the name when it did not change', async () => {
    const renamed = await updateCategory(CAT, HOUSEHOLD, { name: 'Despesa Y', color: '#112233', icon: 'tag' } as never);
    expect(renamed).toMatchObject({ name: 'Despesa Y', color: '#112233', icon: 'tag' });
    const recolored = await updateCategory(CAT, HOUSEHOLD, { name: 'Despesa Y', color: '#445566' } as never);
    expect(recolored.color).toBe('#445566');
  });

  it('allows changing only the letter case of its own name', async () => {
    expect((await updateCategory(CAT, HOUSEHOLD, { name: 'despesa x' } as never)).name).toBe('despesa x');
  });

  it('refuses a rename onto a sibling name (case and accents ignored) or a system name', async () => {
    expect(await code(() => updateCategory(CAT, HOUSEHOLD, { name: 'OUTRA' } as never))).toBe('CATEGORY_NAME_TAKEN');
    expect(await code(() => updateCategory(CAT, HOUSEHOLD, { name: 'Alimentacao' } as never))).toBe('CATEGORY_NAME_TAKEN');
  });

  it('is 404 for a category of another household', async () => {
    expect(await code(() => updateCategory(CAT, OTHER, { name: 'Z' } as never))).toBe('NOT_FOUND');
  });
});

describe('deleteCategory', () => {
  it('takes the row lock first, refuses while the category is referenced anywhere, and deletes an unused one', async () => {
    db.transaction.push({ householdId: HOUSEHOLD, categoryName: `CUSTOM:${CAT}` });
    expect(await code(() => deleteCategory(CAT, HOUSEHOLD))).toBe('CATEGORY_IN_USE');
    expect(db.rawCalls[0]).toContain('FOR UPDATE');
    expect(db.category.some((c) => c.id === CAT)).toBe(true);

    db.transaction = [];
    db.budget.push({ householdId: HOUSEHOLD, categoryName: `CUSTOM:${CAT}` });
    expect(await code(() => deleteCategory(CAT, HOUSEHOLD))).toBe('CATEGORY_IN_USE');

    db.budget = [];
    db.recurringTransaction.push({ householdId: HOUSEHOLD, categoryName: `CUSTOM:${CAT}` });
    expect(await code(() => deleteCategory(CAT, HOUSEHOLD))).toBe('CATEGORY_IN_USE');

    db.recurringTransaction = [];
    await deleteCategory(CAT, HOUSEHOLD);
    expect(db.category.some((c) => c.id === CAT)).toBe(false);
  });

  it('is 404 for a category that is gone or belongs to another household, and deletes nothing', async () => {
    expect(await code(() => deleteCategory(CAT, OTHER))).toBe('NOT_FOUND');
    expect(db.category.some((c) => c.id === CAT)).toBe(true);
  });
});

describe('getCategoryUsage', () => {
  it('counts transactions, recurring transactions and budgets per stored category name', async () => {
    const ref = `CUSTOM:${CAT}`;
    db.transaction.push({ categoryName: ref }, { categoryName: ref }, { categoryName: 'FOOD' });
    db.recurringTransaction.push({ categoryName: ref });
    db.budget.push({ categoryName: ref }, { categoryName: 'FOOD' });

    const usage = await getCategoryUsage(HOUSEHOLD);

    expect(usage.get(ref)).toEqual({ transactions: 2, recurringTransactions: 1, budgets: 1 });
    expect(usage.get('FOOD')).toEqual({ transactions: 1, recurringTransactions: 0, budgets: 1 });
    expect(usage.get('SALARY')).toBeUndefined();
  });
});
