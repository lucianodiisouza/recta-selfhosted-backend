import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { prisma } from '../../shared/db/prisma.js';
import { createTransaction, deleteTransaction, isDeadlock, updateTransaction } from './transactions.service.js';

/**
 * The write hooks of the transaction service against a real Postgres: whatever a hook writes commits or rolls back
 * together with the transaction row and its balance effect, and updates and deletes take their locks in one order.
 * Skipped unless DB_TEST_URL (or IMPORT_DB_TEST_URL) points at a SCRATCH database that already has the migrations
 * applied, with DATABASE_URL set to the same URL (see CONTRIBUTING):
 *
 *   DATABASE_URL=<url> DB_TEST_URL=<url> npx vitest run src/modules/transactions/transactions.hooks.integration.test.ts
 *
 * Never point it at a database that holds real data: it creates a household and removes it afterwards, but it writes.
 */
const testUrl = process.env.DB_TEST_URL ?? process.env.IMPORT_DB_TEST_URL;
const enabled = Boolean(testUrl);
const DAY = new Date('2025-11-10T00:00:00Z');

describe.skipIf(!enabled)('transaction write hooks on Postgres', { timeout: 30_000 }, () => {
  let householdId: string;
  const newAccount = async (name: string) =>
    (await prisma.account.create({ data: { householdId, name, type: 'CHECKING' } })).id;
  const balance = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).balance.toNumber();
  const expense = (accountId: string, extra: Record<string, unknown> = {}) =>
    createTransaction({ householdId, accountId, categoryName: 'OTHER_EXPENSES', amount: 10, date: DAY, ...extra } as never);
  /** A row a hook writes to, to see whether the hook's write committed or rolled back with the transaction. */
  const newWitness = async () => (await newAccount('witness')) as string;
  const touch = (tx: { account: { update: (args: { where: { id: string }; data: { name: string } }) => Promise<unknown> } }, id: string) =>
    tx.account.update({ where: { id }, data: { name: 'touched' } });
  const touched = async (id: string) => (await prisma.account.findUniqueOrThrow({ where: { id } })).name === 'touched';

  beforeAll(async () => {
    expect(process.env.DATABASE_URL).toBe(testUrl);
    householdId = (await prisma.household.create({ data: { name: 'Hooks test' } })).id;
  });
  afterAll(async () => {
    if (householdId) await prisma.household.delete({ where: { id: householdId } });
    await prisma.$disconnect();
  });

  describe('createTransaction', () => {
    it('commits the hook writes with the row, handing the hook the created row', async () => {
      const accountId = await newAccount('create ok');
      const witness = await newWitness();
      let seen: string | undefined;
      const created = await createTransaction(
        { householdId, accountId, categoryName: 'OTHER_EXPENSES', amount: 5, date: DAY, paid: true, isSplit: false },
        undefined,
        { inTransaction: async (tx, row) => { seen = row.id; await touch(tx, witness); } },
      );

      expect(seen).toBe(created.id);
      expect(await touched(witness)).toBe(true);
      expect(await balance(accountId)).toBe(-5);
    });

    it('rolls the row, its balance effect and the hook writes back when the hook throws', async () => {
      const accountId = await newAccount('create rollback');
      const witness = await newWitness();

      await expect(
        createTransaction({ householdId, accountId, categoryName: 'OTHER_EXPENSES', amount: 10, date: DAY, paid: true, isSplit: false }, undefined, {
          inTransaction: async (tx) => {
            await touch(tx, witness);
            throw new Error('refused');
          },
        }),
      ).rejects.toThrow('refused');

      expect(await prisma.transaction.count({ where: { accountId } })).toBe(0);
      expect(await touched(witness)).toBe(false);
      expect(await balance(accountId)).toBe(0);
    });

    it('creates as before without hooks', async () => {
      const accountId = await newAccount('create plain');

      await expense(accountId);

      expect(await balance(accountId)).toBe(-10);
    });
  });

  describe('updateTransaction', () => {
    it('commits inTransaction writes with the update', async () => {
      const accountId = await newAccount('update ok');
      const witness = await newWitness();
      const row = await expense(accountId);

      await updateTransaction(row.id, householdId, { amount: 25 }, { inTransaction: async (tx) => void (await touch(tx, witness)) });

      expect(await touched(witness)).toBe(true);
      expect(await balance(accountId)).toBe(-25);
    });

    it('writes nothing when beforeWrite throws: no balance moved, no field changed, earlier hook writes undone', async () => {
      const accountId = await newAccount('update before');
      const other = await newAccount('update before target');
      const witness = await newWitness();
      const row = await expense(accountId);

      await expect(
        updateTransaction(row.id, householdId, { accountId: other, amount: 40 }, {
          beforeWrite: async (tx) => {
            await touch(tx, witness);
            throw new Error('refused');
          },
        }),
      ).rejects.toThrow('refused');

      const after = await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } });
      expect([after.accountId, after.amount.toNumber()]).toEqual([accountId, 10]);
      expect(await touched(witness)).toBe(false);
      expect([await balance(accountId), await balance(other)]).toEqual([-10, 0]);
    });

    it('rolls the update back when inTransaction throws after the write', async () => {
      const accountId = await newAccount('update after');
      const row = await expense(accountId);

      await expect(
        updateTransaction(row.id, householdId, { amount: 99 }, { inTransaction: async () => Promise.reject(new Error('refused')) }),
      ).rejects.toThrow('refused');

      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).amount.toNumber()).toBe(10);
      expect(await balance(accountId)).toBe(-10);
    });

    it('serialises two moves that cross (A to B and B to A) without a deadlock error', async () => {
      const a = await newAccount('cross a');
      const b = await newAccount('cross b');
      const first = await expense(a);
      const second = await expense(b);

      const results = await Promise.allSettled([
        updateTransaction(first.id, householdId, { accountId: b }),
        updateTransaction(second.id, householdId, { accountId: a }),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      expect([await balance(a), await balance(b)]).toEqual([-10, -10]);
    });

    it('answers 409 to the loser of two concurrent amount changes and applies the winner once', async () => {
      const accountId = await newAccount('race');
      const row = await expense(accountId);

      const results = await Promise.allSettled([
        updateTransaction(row.id, householdId, { amount: 30 }),
        updateTransaction(row.id, householdId, { amount: 50 }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected[0]?.reason).toMatchObject({ statusCode: 409 });
      const stored = (await prisma.transaction.findUniqueOrThrow({ where: { id: row.id } })).amount.toNumber();
      expect([30, 50]).toContain(stored);
      expect(await balance(accountId)).toBe(-stored);
    });
  });

  describe('deleteTransaction guard', () => {
    it('runs inside the delete and aborts it, paid or not, leaving row and balance untouched', async () => {
      const accountId = await newAccount('guard');
      const paid = await expense(accountId);
      const unpaid = await expense(accountId, { paid: false });
      let ran = 0;
      const guard = async () => {
        ran += 1;
        throw new Error('refused');
      };

      await expect(deleteTransaction(paid.id, householdId, { guard })).rejects.toThrow('refused');
      await expect(deleteTransaction(unpaid.id, householdId, { guard })).rejects.toThrow('refused');

      expect(ran).toBe(2);
      expect(await prisma.transaction.count({ where: { accountId } })).toBe(2);
      expect(await balance(accountId)).toBe(-10);
    });

    it('lets the delete through when the guard returns, reverting the balance', async () => {
      const accountId = await newAccount('guard ok');
      const row = await expense(accountId);
      let sawRow = false;

      await deleteTransaction(row.id, householdId, {
        guard: async (tx) => {
          sawRow = (await tx.transaction.count({ where: { id: row.id } })) === 1;
        },
      });

      expect(sawRow).toBe(true);
      expect(await prisma.transaction.count({ where: { accountId } })).toBe(0);
      expect(await balance(accountId)).toBe(0);
    });

    it('deletes as before without options', async () => {
      const accountId = await newAccount('guard none');
      const row = await expense(accountId);

      await deleteTransaction(row.id, householdId);

      expect(await balance(accountId)).toBe(0);
    });
  });

  describe('deadlocks and the order of the locks', () => {
    /** Both callers hold their first lock before either asks for the second: a deadlock for sure. */
    const barrier = (parties: number) => {
      let waiting = 0;
      let release!: () => void;
      const opened = new Promise<void>((resolve) => (release = resolve));
      return () => {
        waiting += 1;
        if (waiting >= parties) release();
        return opened;
      };
    };
    type Tx = { $queryRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };
    const lockAccount = (tx: Tx, id: string) => tx.$queryRaw`SELECT id FROM accounts WHERE id = ${id}::uuid FOR UPDATE`;

    it('retries the update that Postgres chose as the deadlock victim, and both succeed', async () => {
      const a = await newAccount('dead a');
      const b = await newAccount('dead b');
      const rowA = await expense(a);
      const rowB = await expense(b);
      const meet = barrier(2);
      const attempts = { a: 0, b: 0 };
      // The hooks take the two accounts in opposite orders, but only on the first attempt of each call.
      const crossing = (key: 'a' | 'b', first: string, second: string) => async (tx: Tx) => {
        attempts[key] += 1;
        if (attempts[key] > 1) return;
        await lockAccount(tx, first);
        await meet();
        await lockAccount(tx, second);
      };

      const results = await Promise.allSettled([
        updateTransaction(rowA.id, householdId, { description: 'a' }, { beforeWrite: crossing('a', a, b) }),
        updateTransaction(rowB.id, householdId, { description: 'b' }, { beforeWrite: crossing('b', b, a) }),
      ]);

      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
      // The victim ran its hook twice: the retry is real, and the hook runs on every attempt.
      expect(attempts.a + attempts.b).toBe(3);
    });

    it('recognizes the raw error the driver gives for a real deadlock', async () => {
      const a = await newAccount('raw a');
      const b = await newAccount('raw b');
      const meet = barrier(2);
      const take = (first: string, second: string) =>
        prisma.$transaction(async (tx) => {
          await lockAccount(tx, first);
          await meet();
          await lockAccount(tx, second);
        });

      const results = await Promise.allSettled([take(a, b), take(b, a)]);

      const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(failed).toHaveLength(1);
      expect(isDeadlock(failed[0]!.reason)).toBe(true);
    });

    it('updates and deletes of the same rows, on one account, never deadlock and leave the balance right', async () => {
      const accountId = await newAccount('stress');
      let unexpected: unknown[] = [];
      for (let round = 0; round < 40; round++) {
        const rows = await Promise.all([1, 2, 3, 4].map(() => expense(accountId)));
        const results = await Promise.allSettled(
          rows.flatMap((row) => [updateTransaction(row.id, householdId, { amount: 30 }), deleteTransaction(row.id, householdId)]),
        );
        unexpected = unexpected.concat(
          results
            .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
            .map((r) => r.reason)
            .filter((e) => ![404, 409].includes((e as { statusCode?: number }).statusCode ?? 0)),
        );
        for (const row of rows) await deleteTransaction(row.id, householdId).catch(() => undefined);
      }

      expect(unexpected).toEqual([]);
      expect(await prisma.transaction.count({ where: { accountId } })).toBe(0);
      expect(await balance(accountId)).toBe(0);
    });

    it('a delete that races an update of the same row ends with the row gone and the balance at zero', async () => {
      for (let i = 0; i < 10; i++) {
        const accountId = await newAccount(`race ${i}`);
        const row = await expense(accountId);

        const results = await Promise.allSettled([updateTransaction(row.id, householdId, { amount: 40 }), deleteTransaction(row.id, householdId)]);

        expect(await prisma.transaction.findUnique({ where: { id: row.id } })).toBeNull();
        expect(await balance(accountId)).toBe(0);
        expect(results.filter((r) => r.status === 'fulfilled').length).toBeGreaterThanOrEqual(1);
      }
    });

    it('runs the guard on the row this transaction has locked, and not for a paid transfer', async () => {
      const a = await newAccount('guard transfer a');
      const b = await newAccount('guard transfer b');
      // Reversing a transfer takes the money back from the destination, which must have it.
      await prisma.account.update({ where: { id: b }, data: { balance: 10, totalBalance: 10, availableBalance: 10 } });
      const transfer = await prisma.transaction.create({
        data: { householdId, type: 'TRANSFER', fromAccountId: a, toAccountId: b, amount: 5, date: DAY, paid: true, categoryName: 'TRANSFER' },
      });
      let ran = 0;

      await deleteTransaction(transfer.id, householdId, { guard: async () => void (ran += 1) });

      expect(ran).toBe(0);
      expect(await prisma.transaction.count({ where: { id: transfer.id } })).toBe(0);

      // An unpaid transfer takes the generic path: the guard runs there.
      const unpaid = await prisma.transaction.create({
        data: { householdId, type: 'TRANSFER', fromAccountId: a, toAccountId: b, amount: 5, date: DAY, paid: false, categoryName: 'TRANSFER' },
      });
      let ranUnpaid = 0;
      await deleteTransaction(unpaid.id, householdId, { guard: async () => void (ranUnpaid += 1) });
      expect(ranUnpaid).toBe(1);

      const accountId = await newAccount('guard locked');
      const row = await expense(accountId);
      let locked = false;
      await deleteTransaction(row.id, householdId, {
        guard: async () => {
          // Another connection cannot take the row meanwhile: the guard runs on the locked row.
          const other = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM transactions WHERE id = ${row.id}::uuid FOR UPDATE SKIP LOCKED`;
          locked = other.length === 0;
        },
      });
      expect(locked).toBe(true);
    });
  });
});
