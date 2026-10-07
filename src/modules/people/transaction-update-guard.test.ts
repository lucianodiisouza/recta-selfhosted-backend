import { readdirSync, readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { transactionRoutes } from '../transactions/transactions.routes.js';
import * as transactionsService from '../transactions/transactions.service.js';
import { resetStore, seedPerson, seedShare, seedTransaction } from './__fixtures__/people-fake-db.js';
import { assertUpdateKeepsShares, updateKeepingShares } from './shares.service.js';

const lock = vi.hoisted(() => ({ events: [] as string[] }));
vi.mock('../../shared/db/advisory-lock.js', () => ({
  withAdvisoryLock: async (_namespace: number, key: string, work: () => Promise<unknown>) => {
    lock.events.push(`lock ${key}`);
    try {
      return await work();
    } finally {
      lock.events.push(`unlock ${key}`);
    }
  },
}));
vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/people-fake-db.js')).fakePrisma,
}));
vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async () => undefined,
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
  getUserByFirebaseUid: vi.fn(),
}));
vi.mock('../transactions/transactions.service.js', () => ({
  getTransaction: vi.fn(),
  updateTransaction: vi.fn(),
}));

// Invented data only.
const HH = 'hh-1';
const TX = '11111111-1111-4111-8111-111111111111';

const mockedGet = vi.mocked(transactionsService.getTransaction);
const mockedUpdate = vi.mocked(transactionsService.updateTransaction);

function error(message: RegExp) {
  return expect.objectContaining({ statusCode: 400, message: expect.stringMatching(message) });
}

function setup(type: 'EXPENSE' | 'INCOME' = 'EXPENSE') {
  const bia = seedPerson({ householdId: HH, name: 'Bia' });
  const caio = seedPerson({ householdId: HH, name: 'Caio' });
  const tx = seedTransaction({ id: TX, householdId: HH, type, amount: 100 });
  seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 40 });
  seedShare({ householdId: HH, transactionId: tx.id, personId: caio.id, amount: 20 });
  seedShare({ householdId: HH, transactionId: tx.id, personId: caio.id, amount: 70, direction: 'I_OWE_THEM' });
  return tx;
}

beforeEach(() => {
  lock.events = [];
  resetStore();
  vi.clearAllMocks();
});

describe('assertUpdateKeepsShares', () => {
  it('lets the amount stay at or above the sum of each direction', async () => {
    setup();
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, { amount: 70 })).resolves.toBeUndefined();
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, { amount: 500 })).resolves.toBeUndefined();
  });

  it('refuses an amount below the shares they owe me, naming the sum', async () => {
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 60 });
    await expect(assertUpdateKeepsShares(HH, tx.id, { type: 'EXPENSE' }, { amount: 59.99 })).rejects.toEqual(
      error(/59\.99.*60\.00 that people owe you.*Reduce the shares first/),
    );
  });

  it('refuses an amount below the shares I owe, in either direction', async () => {
    setup();
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, { amount: 69 })).rejects.toEqual(
      error(/69\.00.*70\.00 that you owe people/),
    );
  });

  it('refuses turning an expense with shares into an income, but not the other way or without shares', async () => {
    setup();
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, { type: 'INCOME' })).rejects.toEqual(error(/cannot become an income/));
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'INCOME' }, { type: 'EXPENSE' })).resolves.toBeUndefined();
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, { type: 'EXPENSE' })).resolves.toBeUndefined();
    const bare = seedTransaction({ householdId: HH, amount: 10 });
    await expect(assertUpdateKeepsShares(HH, bare.id, { type: 'EXPENSE' }, { type: 'INCOME', amount: 1 })).resolves.toBeUndefined();
  });

  it('ignores other fields and does not read anything when neither amount nor type changes', async () => {
    setup();
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, {})).resolves.toBeUndefined();
  });

  it('only looks at the shares of this household', async () => {
    setup();
    await expect(assertUpdateKeepsShares('hh-2', TX, { type: 'EXPENSE' }, { amount: 1 })).resolves.toBeUndefined();
  });
});

describe('PATCH /transactions/:transactionId', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(transactionRoutes, { prefix: '/transactions' });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.mocked(requireEditor).mockResolvedValue({} as never);
    mockedGet.mockResolvedValue({ id: TX, householdId: HH, type: 'EXPENSE', amount: 100 } as never);
    mockedUpdate.mockResolvedValue({ id: TX } as never);
  });

  const patch = (payload: unknown) =>
    app.inject({ method: 'PATCH', url: `/transactions/${TX}`, payload: payload as never, headers: { authorization: 'Bearer t' } });

  it('answers 400 and does not update when the new amount is below the shares', async () => {
    setup();
    const res = await patch({ amount: 50 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toMatch(/50\.00.*60\.00.*Reduce the shares first/);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('answers 400 when an expense with shares becomes an income', async () => {
    setup();
    const res = await patch({ type: 'INCOME' });
    expect(res.statusCode).toBe(400);
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it('updates normally when the shares still fit, or when nothing relevant changes', async () => {
    setup();
    expect((await patch({ amount: 80 })).statusCode).toBe(200);
    expect((await patch({ description: 'x', notes: 'y' })).statusCode).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledTimes(2);
  });

  it('checks the role first: a viewer gets 403, not the shares message', async () => {
    setup();
    const { ForbiddenError } = await import('../../shared/errors/app-error.js');
    vi.mocked(requireEditor).mockRejectedValue(new ForbiddenError());
    expect((await patch({ amount: 1 })).statusCode).toBe(403);
  });

  it('leaves a transaction without shares alone', async () => {
    seedTransaction({ id: TX, householdId: HH, amount: 100 });
    expect((await patch({ amount: 1 })).statusCode).toBe(200);
  });
});

describe('updateKeepingShares', () => {
  it('runs the check and the update inside the lock of that transaction, in that order', async () => {
    setup();
    const update = vi.fn(async () => {
      lock.events.push('update');
      return 'updated';
    });
    await expect(updateKeepingShares(HH, TX, { type: 'EXPENSE' }, { amount: 80 }, update)).resolves.toBe('updated');
    expect(lock.events).toEqual([`lock ${TX}`, 'update', `unlock ${TX}`]);
  });

  it('does not update, and still releases the lock, when the guard refuses', async () => {
    setup();
    const update = vi.fn(async () => 'updated');
    await expect(updateKeepingShares(HH, TX, { type: 'EXPENSE' }, { amount: 10 }, update)).rejects.toEqual(error(/Reduce the shares first/));
    expect(update).not.toHaveBeenCalled();
    expect(lock.events).toEqual([`lock ${TX}`, `unlock ${TX}`]);
  });

  it('releases the lock when the update fails', async () => {
    setup();
    await expect(updateKeepingShares(HH, TX, { type: 'EXPENSE' }, { amount: 80 }, async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(lock.events).toEqual([`lock ${TX}`, `unlock ${TX}`]);
  });

  it('takes no lock for an update that touches neither the amount nor the type', async () => {
    setup();
    await expect(updateKeepingShares(HH, TX, { type: 'EXPENSE' }, {}, async () => 'ok')).resolves.toBe('ok');
    expect(lock.events).toEqual([]);
  });
});

describe('the internal service path is not guarded', () => {
  it('transactions.service does not know about shares: the guard lives in the route only', () => {
    const service = readFileSync(new URL('../transactions/transactions.service.ts', import.meta.url), 'utf8');
    expect(service).not.toMatch(/people\/|assertUpdateKeepsShares|transactionShare/);
    const routes = readFileSync(new URL('../transactions/transactions.routes.ts', import.meta.url), 'utf8');
    expect(routes).toContain('updateKeepingShares');
  });

  it('no other file of the transactions module calls the guard, so imports and internal flows keep updating amounts freely', () => {
    const dir = new URL('../transactions/', import.meta.url);
    const callers = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))
      .filter((file) => readFileSync(new URL(file, dir), 'utf8').includes('updateKeepingShares'));
    expect(callers).toEqual(['transactions.routes.ts']);
  });
});

describe('assertUpdateKeepsShares: signed amounts', () => {
  it('compares the signed amount: a negative amount is below any share', async () => {
    setup();
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, { amount: -70 })).rejects.toEqual(error(/-70\.00.*Reduce the shares first/));
    await expect(assertUpdateKeepsShares(HH, TX, { type: 'EXPENSE' }, { amount: -1000 })).rejects.toEqual(error(/lower than the shares/));
    // without shares a negative amount is the transaction service's business
    const bare = seedTransaction({ householdId: HH, amount: 10 });
    await expect(assertUpdateKeepsShares(HH, bare.id, { type: 'EXPENSE' }, { amount: -5 })).resolves.toBeUndefined();
  });
});
