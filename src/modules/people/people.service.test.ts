import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakePrisma,
  resetStore,
  rowsOf,
  seedPerson,
  seedSettlement,
  seedShare,
  seedTransaction,
} from './__fixtures__/people-fake-db.js';
import { updatePersonSchema, type PutSharesInput } from './people.schema.js';
import { createPerson, deletePerson, getLedger, listBalances, listPeople, updatePerson } from './people.service.js';
import { getTransactionShares, previewTransactionShares, putTransactionShares } from './shares.service.js';

vi.mock('../../shared/db/advisory-lock.js', () => ({ withAdvisoryLock: (_namespace: number, _key: string, work: () => Promise<unknown>) => work() }));
vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/people-fake-db.js')).fakePrisma,
}));

// Invented data only: names, amounts and ids below are fictitious.

const HH = 'hh-1';
const OTHER = 'hh-2';

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

function error(statusCode: number, message?: string | RegExp) {
  return expect.objectContaining({
    statusCode,
    ...(message ? { message: typeof message === 'string' ? expect.stringContaining(message) : expect.stringMatching(message) } : {}),
  });
}

// ---------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------

describe('people: create, list, update, delete', () => {
  it('creates a person with aliases and lists it', async () => {
    const created = await createPerson({ householdId: HH, name: 'Bia Souza', aliases: ['Biazinha', 'B.'] });

    expect(created).toEqual({
      id: expect.any(String),
      householdId: HH,
      name: 'Bia Souza',
      aliases: ['Biazinha', 'B.'],
      userId: null,
      isActive: true,
    });
    expect(await listPeople(HH)).toEqual([created]);
  });

  it('drops an alias that repeats the name or another alias under normalization', async () => {
    const created = await createPerson({ householdId: HH, name: 'Ana', aliases: ['ANA', ' Aninha ', 'aninha', 'Ánia'] });
    expect(created.aliases).toEqual(['Aninha', 'Ánia']);
  });

  it('lists active people by name, and inactive ones only when asked', async () => {
    await createPerson({ householdId: HH, name: 'Zeca' });
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const caio = await createPerson({ householdId: HH, name: 'Caio' });
    await updatePerson(HH, caio.id, { isActive: false });

    expect((await listPeople(HH)).map((p) => p.name)).toEqual(['Bia', 'Zeca']);
    expect((await listPeople(HH, true)).map((p) => p.name)).toEqual(['Bia', 'Caio', 'Zeca']);
    expect(bia.isActive).toBe(true);
  });

  it('keeps households apart: another household lists none and can reuse a name', async () => {
    await createPerson({ householdId: HH, name: 'Bia' });
    expect(await listPeople(OTHER)).toEqual([]);
    await expect(createPerson({ householdId: OTHER, name: 'Bia' })).resolves.toMatchObject({ name: 'Bia' });
  });

  it('answers 409 for a name or alias already used, whatever the case or accents', async () => {
    await createPerson({ householdId: HH, name: 'João Lima', aliases: ['Jota'] });

    await expect(createPerson({ householdId: HH, name: 'joao lima' })).rejects.toEqual(error(409, 'João Lima'));
    await expect(createPerson({ householdId: HH, name: 'Outro', aliases: ['JOTA'] })).rejects.toEqual(error(409, 'Jota'));
    await expect(createPerson({ householdId: HH, name: 'Jota' })).rejects.toEqual(error(409));
    // nothing was left half created
    expect((await listPeople(HH)).map((p) => p.name)).toEqual(['João Lima']);
    expect(rowsOf('person')).toHaveLength(1);
  });

  it('answers 409 when the unique key is lost in a race (P2002)', async () => {
    fakePrisma.personAlias.createMany.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(createPerson({ householdId: HH, name: 'Bia' })).rejects.toEqual(error(409));
    expect(rowsOf('person')).toHaveLength(0);
  });

  it('renames, replaces the aliases and keeps the rest', async () => {
    const person = await createPerson({ householdId: HH, name: 'Bia', aliases: ['Biazinha'] });

    const renamed = await updatePerson(HH, person.id, { name: 'Beatriz' });
    // the old name keeps answering
    expect(renamed).toMatchObject({ name: 'Beatriz', aliases: ['Biazinha', 'Bia'] });

    const replaced = await updatePerson(HH, person.id, { aliases: ['Bê'] });
    expect(replaced).toMatchObject({ name: 'Beatriz', aliases: ['Bê'] });

    // the replaced aliases are free again
    await expect(createPerson({ householdId: HH, name: 'Biazinha' })).resolves.toMatchObject({ name: 'Biazinha' });
    await expect(createPerson({ householdId: HH, name: 'Bê' })).rejects.toEqual(error(409));
  });

  it('lets a person keep its own name and aliases on update, but not take another person\'s', async () => {
    const ana = await createPerson({ householdId: HH, name: 'Ana', aliases: ['Aninha'] });
    await createPerson({ householdId: HH, name: 'Bia', aliases: ['Biazinha'] });

    await expect(updatePerson(HH, ana.id, { name: 'Ana', aliases: ['Aninha', 'Ana Paula'] })).resolves.toMatchObject({ aliases: ['Aninha', 'Ana Paula'] });
    await expect(updatePerson(HH, ana.id, { aliases: ['biazinha'] })).rejects.toEqual(error(409));
    await expect(updatePerson(HH, ana.id, { name: 'BIA' })).rejects.toEqual(error(409));
    // a failed update changes nothing
    expect((await listPeople(HH)).find((p) => p.id === ana.id)).toMatchObject({ name: 'Ana', aliases: ['Aninha', 'Ana Paula'] });
  });

  it('deactivates and reactivates', async () => {
    const person = await createPerson({ householdId: HH, name: 'Bia' });
    expect(await updatePerson(HH, person.id, { isActive: false })).toMatchObject({ isActive: false });
    expect(await updatePerson(HH, person.id, { isActive: true })).toMatchObject({ isActive: true });
  });

  it('does not read or change a person of another household (404)', async () => {
    const person = await createPerson({ householdId: HH, name: 'Bia' });
    await expect(updatePerson(OTHER, person.id, { name: 'X' })).rejects.toEqual(error(404));
    await expect(deletePerson(OTHER, person.id)).rejects.toEqual(error(404));
    expect(rowsOf('person')).toHaveLength(1);
  });

  it('deletes a person without data', async () => {
    const person = await createPerson({ householdId: HH, name: 'Bia', aliases: ['B'] });
    expect(await deletePerson(HH, person.id)).toEqual({ deleted: true });
    expect(rowsOf('person')).toHaveLength(0);
    expect(rowsOf('personAlias')).toHaveLength(0);
  });

  it('only deactivates a person that has shares or settlements', async () => {
    const withShare = await createPerson({ householdId: HH, name: 'Bia' });
    const withSettlement = await createPerson({ householdId: HH, name: 'Caio' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    seedShare({ householdId: HH, transactionId: tx.id, personId: withShare.id, amount: 50 });
    seedSettlement({ householdId: HH, personId: withSettlement.id, amount: 10 });

    expect(await deletePerson(HH, withShare.id)).toEqual({ deleted: false, person: expect.objectContaining({ id: withShare.id, isActive: false }) });
    expect(await deletePerson(HH, withSettlement.id)).toMatchObject({ deleted: false });
    expect(rowsOf('person')).toHaveLength(2);
    expect(rowsOf('transactionShare')).toHaveLength(1);
    expect(rowsOf('settlement')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Shares of a transaction
// ---------------------------------------------------------------------------------------------------------------

describe('transaction shares', () => {
  async function setup() {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const caio = await createPerson({ householdId: HH, name: 'Caio' });
    const tx = seedTransaction({ householdId: HH, amount: 100, description: 'Jantar', date: '2026-10-03' });
    return { bia, caio, tx };
  }

  it('stores an exact split and reports my part', async () => {
    const { bia, caio, tx } = await setup();

    const result = await putTransactionShares(HH, tx.id, {
      direction: 'THEY_OWE_ME',
      strategy: 'exact',
      entries: [{ personId: bia.id, amount: 30.5, note: 'entrada' }, { personId: caio.id, amount: 20 }],
    });

    expect(result).toMatchObject({ transactionId: tx.id, transactionAmount: 100, myPart: 49.5 });
    expect(result.shares).toEqual([
      { id: expect.any(String), transactionId: tx.id, personId: bia.id, personName: 'Bia', direction: 'THEY_OWE_ME', amount: 30.5, note: 'entrada', source: 'manual' },
      { id: expect.any(String), transactionId: tx.id, personId: caio.id, personName: 'Caio', direction: 'THEY_OWE_ME', amount: 20, note: null, source: 'manual' },
    ]);
    expect(await getTransactionShares(HH, tx.id)).toEqual(result);
  });

  it('computes percent, shares and equal splits on the server, remainder to the first person', async () => {
    const { bia, caio, tx } = await setup();
    const entries = [{ personId: bia.id }, { personId: caio.id }];

    const equal = await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries });
    expect(equal.shares.map((s) => s.amount)).toEqual([33.34, 33.33]);
    expect(equal.myPart).toBe(33.33);

    const percent = await putTransactionShares(HH, tx.id, {
      direction: 'THEY_OWE_ME',
      strategy: 'percent',
      entries: [{ personId: bia.id, percent: 25 }, { personId: caio.id, percent: 10 }],
    });
    expect(percent.shares.map((s) => s.amount)).toEqual([25, 10]);
    expect(percent.myPart).toBe(65);

    const cotas = await putTransactionShares(HH, tx.id, {
      direction: 'THEY_OWE_ME',
      strategy: 'shares',
      myShares: 2,
      entries: [{ personId: bia.id, shares: 1 }, { personId: caio.id, shares: 2 }],
    });
    expect(cotas.shares.map((s) => s.amount)).toEqual([20, 40]);
    expect(cotas.myPart).toBe(40);
  });

  it('replaces only the shares of the same direction', async () => {
    const { bia, caio, tx } = await setup();
    await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 40 }] });
    await putTransactionShares(HH, tx.id, { direction: 'I_OWE_THEM', strategy: 'exact', entries: [{ personId: caio.id, amount: 10 }] });

    const replaced = await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 25 }] });

    expect(replaced.shares.map((s) => [s.personName, s.direction, s.amount])).toEqual([
      ['Caio', 'I_OWE_THEM', 10],
      ['Bia', 'THEY_OWE_ME', 25],
    ]);
    // my part only counts what they owe me
    expect(replaced.myPart).toBe(75);
  });

  it('removes the shares of a direction with an empty list, and only that direction', async () => {
    const { bia, caio, tx } = await setup();
    await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 40 }] });
    await putTransactionShares(HH, tx.id, { direction: 'I_OWE_THEM', strategy: 'exact', entries: [{ personId: caio.id, amount: 10 }] });

    const result = await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [] });

    expect(result.shares.map((s) => s.direction)).toEqual(['I_OWE_THEM']);
    expect(result.myPart).toBe(100);
  });

  it('previews without writing anything', async () => {
    const { bia, tx } = await setup();
    const preview = await previewTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] });

    expect(preview).toEqual({ shares: [{ personId: bia.id, amount: 50 }], myPart: 50 });
    expect(rowsOf('transactionShare')).toHaveLength(0);
    expect(fakePrisma.transactionShare.createMany).not.toHaveBeenCalled();
  });

  it('the preview and the stored shares agree on what stays with me, in either direction', async () => {
    const { bia, caio, tx } = await setup();
    const owe: PutSharesInput = { direction: 'I_OWE_THEM', strategy: 'exact', entries: [{ personId: caio.id, amount: 40 }] };
    const theirs: PutSharesInput = { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 30 }] };

    // I owe people 40: that is not what is left to me, the transaction amount (100) still is
    expect((await previewTransactionShares(HH, tx.id, owe)).myPart).toBe(100);
    expect((await putTransactionShares(HH, tx.id, owe)).myPart).toBe(100);
    expect((await getTransactionShares(HH, tx.id)).myPart).toBe(100);

    // with 30 owed to me stored, a preview of the other direction keeps it out of my part
    await putTransactionShares(HH, tx.id, theirs);
    expect((await previewTransactionShares(HH, tx.id, owe)).myPart).toBe(70);
    expect((await getTransactionShares(HH, tx.id)).myPart).toBe(70);
    // and a preview of the same direction replaces what is stored
    const replacing: PutSharesInput = { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 55 }] };
    expect((await previewTransactionShares(HH, tx.id, replacing)).myPart).toBe(45);
  });

  it('rejects parts above the transaction amount and leaves the previous shares untouched', async () => {
    const { bia, caio, tx } = await setup();
    await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 40 }] });

    await expect(
      putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 60 }, { personId: caio.id, amount: 40.01 }] }),
    ).rejects.toEqual(error(400, /more than the transaction amount/));
    expect((await getTransactionShares(HH, tx.id)).shares.map((s) => s.amount)).toEqual([40]);
  });

  it('rejects a person twice, and transfers/allocations', async () => {
    const { bia, tx } = await setup();
    await expect(
      putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }, { personId: bia.id }] }),
    ).rejects.toEqual(error(400, /more than once/));

    const transfer = seedTransaction({ householdId: HH, amount: 10, type: 'TRANSFER' });
    await expect(putTransactionShares(HH, transfer.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] })).rejects.toEqual(
      error(400, /income and expense/),
    );
  });

  it('rejects an inactive person and a person or transaction of another household', async () => {
    const { bia, tx } = await setup();
    const stranger = await createPerson({ householdId: OTHER, name: 'Estranha' });
    const foreignTx = seedTransaction({ householdId: OTHER, amount: 50 });
    const inactive = await createPerson({ householdId: HH, name: 'Dora' });
    await updatePerson(HH, inactive.id, { isActive: false });

    await expect(putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: stranger.id }] })).rejects.toEqual(error(404));
    await expect(putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: inactive.id }] })).rejects.toEqual(error(400, /inactive/));
    await expect(putTransactionShares(HH, foreignTx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] })).rejects.toEqual(error(404));
    await expect(getTransactionShares(HH, foreignTx.id)).rejects.toEqual(error(404));
    await expect(previewTransactionShares(HH, foreignTx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [] })).rejects.toEqual(error(404));
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });

  it('answers 409 when a concurrent write wins the unique key', async () => {
    const { bia, tx } = await setup();
    fakePrisma.transactionShare.createMany.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }));
    await expect(
      putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] }),
    ).rejects.toEqual(error(409));
  });

  it('a shared income works the same way (the other side of a refund)', async () => {
    const { bia } = await setup();
    const income = seedTransaction({ householdId: HH, amount: 200, type: 'INCOME' });
    const result = await putTransactionShares(HH, income.id, { direction: 'I_OWE_THEM', strategy: 'percent', entries: [{ personId: bia.id, percent: 50 }] });
    expect(result.shares[0]).toMatchObject({ amount: 100, direction: 'I_OWE_THEM' });
  });
});

describe('balances', () => {
  it('sums shares and settlements per person, in reais', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const caio = await createPerson({ householdId: HH, name: 'Caio' });
    const a = seedTransaction({ householdId: HH, amount: 100 });
    const b = seedTransaction({ householdId: HH, amount: 60 });
    seedShare({ householdId: HH, transactionId: a.id, personId: bia.id, amount: 50.25 });
    seedShare({ householdId: HH, transactionId: b.id, personId: bia.id, amount: 20, direction: 'I_OWE_THEM' });
    seedSettlement({ householdId: HH, personId: bia.id, amount: 10.1, direction: 'RECEIVED' });
    seedSettlement({ householdId: HH, personId: bia.id, amount: 3, direction: 'PAID' });
    seedShare({ householdId: HH, transactionId: a.id, personId: caio.id, amount: 5 });

    const balances = await listBalances(HH);

    expect(balances.map((b2) => b2.person.name)).toEqual(['Bia', 'Caio']);
    expect(balances[0]).toMatchObject({ owedToMe: 50.25, iOwe: 20, received: 10.1, paid: 3, balance: 23.15, openShares: 2 });
    expect(balances[1]).toMatchObject({ owedToMe: 5, balance: 5, openShares: 1 });
  });

  it('keeps cents exact where doubles drift', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 10 });
    for (let i = 0; i < 3; i++) seedShare({ householdId: HH, transactionId: seedTransaction({ householdId: HH, amount: 1 }).id, personId: bia.id, amount: 0.1 });
    seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 0.2 });
    expect((await listBalances(HH))[0]!.balance).toBe(0.5);
  });

  it('includes an inactive person only while the balance is not zero, and always the active ones', async () => {
    const zero = await createPerson({ householdId: HH, name: 'Zero' });
    const owing = await createPerson({ householdId: HH, name: 'Devendo' });
    const settled = await createPerson({ householdId: HH, name: 'Quitada' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    seedShare({ householdId: HH, transactionId: tx.id, personId: owing.id, amount: 40 });
    seedShare({ householdId: HH, transactionId: tx.id, personId: settled.id, amount: 40 });
    seedSettlement({ householdId: HH, personId: settled.id, amount: 40 });
    await updatePerson(HH, owing.id, { isActive: false });
    await updatePerson(HH, settled.id, { isActive: false });

    const names = (await listBalances(HH)).map((b) => b.person.name);
    expect(names).toEqual(['Devendo', 'Zero']);
    expect(zero.isActive).toBe(true);
  });

  it('is scoped to the household', async () => {
    const stranger = await createPerson({ householdId: OTHER, name: 'Estranha' });
    const tx = seedTransaction({ householdId: OTHER, amount: 100 });
    seedShare({ householdId: OTHER, transactionId: tx.id, personId: stranger.id, amount: 40 });
    expect(await listBalances(HH)).toEqual([]);
  });

  it('goes negative when I owe them', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 100, direction: 'I_OWE_THEM' });
    expect((await listBalances(HH))[0]!.balance).toBe(-100);
  });
});

function cursorOf(entry: { date: string; id: string }): string {
  // The cursor is the sort key of a row: day, creation time (the fake projects its sequence onto a fixed epoch) and id
  const row = rowsOf('transactionShare').concat(rowsOf('settlement')).find((r) => r.id === entry.id)!;
  return `${entry.date}|${1_700_000_000_000 + (row.createdAt as number)}|${entry.id}`;
}

describe('ledger', () => {
  async function history() {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const t1 = seedTransaction({ householdId: HH, amount: 100, description: 'Mercado', date: '2026-10-01' });
    const t2 = seedTransaction({ householdId: HH, amount: 60, description: 'Snack bar', date: '2026-10-01' });
    const t3 = seedTransaction({ householdId: HH, amount: 80, description: 'Luz', date: '2026-10-04' });
    const income = seedTransaction({ householdId: HH, type: 'INCOME', amount: 70, description: 'Bia', date: '2026-10-03' });
    seedShare({ householdId: HH, transactionId: t1.id, personId: bia.id, amount: 50, source: 'import', note: '*Dividir com Bia' });
    seedShare({ householdId: HH, transactionId: t2.id, personId: bia.id, amount: 30 });
    seedSettlement({ householdId: HH, personId: bia.id, amount: 70, date: '2026-10-03', transactionId: income.id });
    seedShare({ householdId: HH, transactionId: t3.id, personId: bia.id, amount: 80, direction: 'I_OWE_THEM' });
    seedSettlement({ householdId: HH, personId: bia.id, amount: 5, date: '2026-10-06', direction: 'PAID' });
    return { bia };
  }

  it('returns the timeline newest first with the running balance computed over the whole history', async () => {
    const { bia } = await history();
    const page = await getLedger(HH, bia.id, { limit: 50, order: 'desc' });

    expect(page.pagination).toEqual({ nextCursor: null, hasMore: false, total: 5 });
    expect(page.data.map((e) => [e.date, e.description, e.signed, e.balanceAfter])).toEqual([
      ['2026-10-06', 'Settlement paid', 5, 5 + (50 + 30 - 70 - 80)],
      ['2026-10-04', 'Luz', -80, 50 + 30 - 70 - 80],
      ['2026-10-03', 'Bia', -70, 50 + 30 - 70],
      ['2026-10-01', 'Snack bar', 30, 80],
      ['2026-10-01', 'Mercado', 50, 50],
    ]);
  });

  it('describes each entry: link to the transaction, its amount, note and source', async () => {
    const { bia } = await history();
    const page = await getLedger(HH, bia.id, { limit: 50, order: 'asc' });

    const market = page.data[0]!;
    expect(market).toMatchObject({
      kind: 'share',
      direction: 'THEY_OWE_ME',
      amount: 50,
      transactionAmount: 100,
      note: '*Dividir com Bia',
      source: 'import',
    });
    expect(market.transactionId).toEqual(expect.any(String));
    const settlement = page.data.find((e) => e.kind === 'settlement' && e.direction === 'RECEIVED')!;
    expect(settlement).toMatchObject({ amount: 70, transactionAmount: 70, source: null });
    const bare = page.data.find((e) => e.kind === 'settlement' && e.direction === 'PAID')!;
    expect(bare).toMatchObject({ transactionId: null, transactionAmount: null });
  });

  it('pages with a cursor in a total order, without skipping or repeating rows that share a day', async () => {
    const { bia } = await history();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const page = await getLedger(HH, bia.id, { limit: 2, order: 'desc', cursor });
      expect(page.pagination.total).toBe(5);
      seen.push(...page.data.map((e) => e.id));
      if (!page.pagination.hasMore) {
        expect(page.pagination.nextCursor).toBeNull();
        break;
      }
      cursor = page.pagination.nextCursor!;
    }
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);

    const all = await getLedger(HH, bia.id, { limit: 50, order: 'desc' });
    expect(seen).toEqual(all.data.map((e) => e.id));
  });

  it('the running balance does not depend on the page or the direction', async () => {
    const { bia } = await history();
    const desc = await getLedger(HH, bia.id, { limit: 50, order: 'desc' });
    const asc = await getLedger(HH, bia.id, { limit: 50, order: 'asc' });
    expect(asc.data.map((e) => e.id)).toEqual([...desc.data].reverse().map((e) => e.id));
    const second = await getLedger(HH, bia.id, { limit: 2, order: 'asc', cursor: cursorOf(asc.data[1]!) });
    expect(second.data.map((e) => e.balanceAfter)).toEqual(asc.data.slice(2, 4).map((e) => e.balanceAfter));
    // the last chronological balance is the person's balance
    const balance = (await listBalances(HH))[0]!.balance;
    expect(asc.data[asc.data.length - 1]!.balanceAfter).toBe(balance);
  });

  it('rejects a cursor that is not in the ledger, and a person of another household', async () => {
    const { bia } = await history();
    await expect(getLedger(HH, bia.id, { limit: 5, order: 'desc', cursor: 'nope' })).rejects.toEqual(error(400, /cursor/));
    await expect(getLedger(OTHER, bia.id, { limit: 5, order: 'desc' })).rejects.toEqual(error(404));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Round 2: keys, caps, scoping, races, rename, cursor
// ---------------------------------------------------------------------------------------------------------------

describe('names and keys', () => {
  const COMBINING = '́';

  it('rejects a name made only of combining marks (400, nothing written) on create and update', async () => {
    await expect(createPerson({ householdId: HH, name: COMBINING })).rejects.toEqual(error(400, /letter or digit/));
    await expect(createPerson({ householdId: HH, name: `${COMBINING}${COMBINING}`, aliases: ['Ok'] })).rejects.toEqual(error(400));
    expect(rowsOf('person')).toHaveLength(0);
    expect(rowsOf('personAlias')).toHaveLength(0);

    const person = await createPerson({ householdId: HH, name: 'Bia' });
    await expect(updatePerson(HH, person.id, { name: COMBINING })).rejects.toEqual(error(400, /letter or digit/));
    expect((await listPeople(HH))[0]).toMatchObject({ name: 'Bia' });
  });

  it('skips an alias that normalizes to nothing instead of failing', async () => {
    const person = await createPerson({ householdId: HH, name: 'Bia', aliases: [COMBINING, 'Bi'] });
    expect(person.aliases).toEqual(['Bi']);
  });

  it('rejects a name or alias whose normalized key exceeds the column (Hangul triples in NFD), without writing', async () => {
    const long = '각'.repeat(40); // 40 characters, 120 once decomposed
    await expect(createPerson({ householdId: HH, name: long })).rejects.toEqual(error(400, /too long once normalized/));
    await expect(createPerson({ householdId: HH, name: 'Bia', aliases: [long] })).rejects.toEqual(error(400, /too long once normalized/));
    expect(rowsOf('person')).toHaveLength(0);

    const person = await createPerson({ householdId: HH, name: 'Bia' });
    await expect(updatePerson(HH, person.id, { aliases: [long] })).rejects.toEqual(error(400));
    expect((await listPeople(HH))[0]!.aliases).toEqual([]);
    // 33 syllables = 99 characters of key still fit
    await expect(createPerson({ householdId: HH, name: '각'.repeat(33) })).resolves.toMatchObject({ isActive: true });
  });

  it('caps the people of a household', async () => {
    for (let i = 0; i < 500; i++) seedPerson({ householdId: HH, name: `Pessoa ${i}` });
    await expect(createPerson({ householdId: HH, name: 'A mais' })).rejects.toEqual(error(400, /at most 500/));
    await expect(createPerson({ householdId: OTHER, name: 'A mais' })).resolves.toMatchObject({ name: 'A mais' });
  });

  it('a rename keeps the old name as an alias, unless only the case or accents change', async () => {
    const person = await createPerson({ householdId: HH, name: 'Bia', aliases: ['Biazinha'] });
    const renamed = await updatePerson(HH, person.id, { name: 'Beatriz', aliases: ['Bê'] });
    expect(renamed.aliases).toEqual(['Bê', 'Bia']);
    // the old name still resolves, and it cannot be taken by somebody else
    await expect(createPerson({ householdId: HH, name: 'bia' })).rejects.toEqual(error(409));

    const same = await updatePerson(HH, person.id, { name: 'BEATRIZ' });
    expect(same.aliases).toEqual(['Bê', 'Bia']);
    expect(same.name).toBe('BEATRIZ');
  });

  it('renaming many times never outgrows the alias cap: the oldest aliases go, the latest old name stays', async () => {
    const person = await createPerson({ householdId: HH, name: 'Name 0' });
    let last = person;
    for (let i = 1; i <= 25; i += 1) last = await updatePerson(HH, person.id, { name: `Name ${i}` });

    expect(last.aliases).toHaveLength(20);
    expect(last.aliases[19]).toBe('Name 24');
    expect(last.aliases).not.toContain('Name 0');
    expect(last.aliases).toContain('Name 5');
    // the person can still be edited: the body the client sends back is accepted by the schema
    expect(updatePersonSchema.safeParse({ name: 'Another', aliases: last.aliases }).success).toBe(true);
    await expect(updatePerson(HH, person.id, { name: 'Another', aliases: last.aliases })).resolves.toMatchObject({ name: 'Another' });
  });

  it('names that differ only by a combining mark of another script are different people', async () => {
    await createPerson({ householdId: HH, name: 'かい' });
    await expect(createPerson({ householdId: HH, name: 'がい' })).resolves.toMatchObject({ name: 'がい' });
    await expect(createPerson({ householdId: HH, name: 'Сергей' })).resolves.toBeTruthy();
    await expect(createPerson({ householdId: HH, name: 'Сергеи' })).resolves.toBeTruthy();
    // while accents of Latin letters still collide
    await createPerson({ householdId: HH, name: 'José' });
    await expect(createPerson({ householdId: HH, name: 'jose' })).rejects.toEqual(error(409));
  });
});

describe('race guards', () => {
  it('PUT shares locks the transaction row and splits the amount as it is under the lock', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    const rows = rowsOf('transaction');
    // An update lands after the early checks and before the lock is taken
    fakePrisma.$queryRaw.mockImplementationOnce(async () => {
      rows.find((t) => t.id === tx.id)!.amount = 50;
      return [{ amount: { toString: () => '50' }, type: 'EXPENSE' }];
    });

    await expect(
      putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'exact', entries: [{ personId: bia.id, amount: 80 }] }),
    ).rejects.toEqual(error(400, /more than the transaction amount/));
    expect(rowsOf('transactionShare')).toHaveLength(0);

    const sql = fakePrisma.$queryRaw.mock.calls[0]![0] as unknown as string[];
    expect(sql.join('?')).toMatch(/FROM transactions WHERE id = \?::uuid AND household_id = \?::uuid FOR UPDATE/);
    // taken inside the database transaction, before the shares are written
    const orders = fakePrisma.$transaction.mock.invocationCallOrder;
    expect(orders[orders.length - 1]!).toBeLessThan(fakePrisma.$queryRaw.mock.invocationCallOrder[0]!);
  });

  it('PUT shares answers with the amount it split, not the one it first read', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    fakePrisma.$queryRaw.mockImplementationOnce(async () => {
      rowsOf('transaction').find((t) => t.id === tx.id)!.amount = 200;
      return [{ amount: { toString: () => '200' }, type: 'EXPENSE' }];
    });
    const result = await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] });
    expect(result.shares[0]!.amount).toBe(100);
    expect(result.transactionAmount).toBe(200);
  });

  it('PUT shares answers 404, writing nothing, when the transaction was deleted before the lock was taken', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    fakePrisma.$queryRaw.mockImplementationOnce(async () => []);
    await expect(
      putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] }),
    ).rejects.toEqual(error(404));
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });

  it('both row locks are scoped to the household as well as the id', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    await putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] });
    await deletePerson(HH, bia.id);
    const locks = fakePrisma.$queryRaw.mock.calls.map((call) => (call[0] as unknown as string[]).join('?'));
    expect(locks).toHaveLength(2);
    for (const sql of locks) expect(sql).toContain('AND household_id = ?::uuid FOR UPDATE');
    // the household value itself is bound, not just the clause
    for (const call of fakePrisma.$queryRaw.mock.calls) expect(call.slice(1)).toContain(HH);
  });

  it('deleting a person locks the row first, so a share committed meanwhile deactivates instead of cascading away', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    // the share lands while the delete waits for the lock
    fakePrisma.$queryRaw.mockImplementationOnce(async () => {
      seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 10 });
      return [{ id: bia.id }];
    });

    const result = await deletePerson(HH, bia.id);

    expect(result).toMatchObject({ deleted: false });
    expect(rowsOf('person')).toHaveLength(1);
    expect(rowsOf('transactionShare')).toHaveLength(1);
    expect((fakePrisma.$queryRaw.mock.calls[0]![0] as unknown as string[]).join('?')).toMatch(/FROM people WHERE id = \?::uuid AND household_id = \?::uuid FOR UPDATE/);
  });
});

describe('household scoping of every read (inconsistent rows of another household are ignored)', () => {
  // The foreign key does not tie a row to its household, so each query filters by it; these rows would only
  // exist through a bug, and must still never count here.
  it('balances ignore shares and settlements stamped with another household', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    seedShare({ householdId: HH, transactionId: tx.id, personId: bia.id, amount: 10 });
    seedShare({ householdId: OTHER, transactionId: tx.id, personId: bia.id, amount: 70, direction: 'I_OWE_THEM' });
    seedSettlement({ householdId: OTHER, personId: bia.id, amount: 5 });

    expect((await listBalances(HH))[0]).toMatchObject({ owedToMe: 10, iOwe: 0, received: 0, balance: 10, openShares: 1 });
  });

  it('the ledger ignores shares and settlements of another household, and transactions of another household', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const mine = seedTransaction({ householdId: HH, amount: 100, description: 'Minha' });
    const foreign = seedTransaction({ householdId: OTHER, amount: 100, description: 'De fora' });
    seedShare({ householdId: HH, transactionId: mine.id, personId: bia.id, amount: 10 });
    seedShare({ householdId: HH, transactionId: foreign.id, personId: bia.id, amount: 30 }); // transaction of another household
    seedShare({ householdId: OTHER, transactionId: mine.id, personId: bia.id, amount: 40 }); // stamped with another household
    seedSettlement({ householdId: OTHER, personId: bia.id, amount: 5 });

    const page = await getLedger(HH, bia.id, { limit: 50, order: 'asc' });

    expect(page.data.map((e) => [e.description, e.amount])).toEqual([['Minha', 10]]);
    expect(page.pagination.total).toBe(1);
  });
});

describe('ledger cursor', () => {
  it('continues from the position when the row it names was deleted', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    const days = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'];
    const shares = days.map((date) => seedShare({ householdId: HH, transactionId: seedTransaction({ householdId: HH, amount: 100, date }).id, personId: bia.id, amount: 10 }));
    const first = await getLedger(HH, bia.id, { limit: 2, order: 'asc' });
    expect(first.data.map((e) => e.date)).toEqual(['2026-10-01', '2026-10-02']);

    // the last row of the first page is removed before the next page is asked for
    const doomed = shares[1]!;
    await fakePrisma.transaction.delete({ where: { id: doomed.transactionId as string } });
    const second = await getLedger(HH, bia.id, { limit: 2, order: 'asc', cursor: first.pagination.nextCursor! });

    expect(second.data.map((e) => e.date)).toEqual(['2026-10-03', '2026-10-04']);
    expect(second.pagination.hasMore).toBe(false);
  });

  it('works the same newest first, and a cursor past the end gives an empty page', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    for (const date of ['2026-10-01', '2026-10-02', '2026-10-03']) {
      seedShare({ householdId: HH, transactionId: seedTransaction({ householdId: HH, amount: 100, date }).id, personId: bia.id, amount: 10 });
    }
    const first = await getLedger(HH, bia.id, { limit: 2, order: 'desc' });
    const second = await getLedger(HH, bia.id, { limit: 2, order: 'desc', cursor: first.pagination.nextCursor! });
    expect(second.data.map((e) => e.date)).toEqual(['2026-10-01']);
    const past = await getLedger(HH, bia.id, { limit: 2, order: 'desc', cursor: `2000-01-01|1|zzz` });
    expect(past.data).toEqual([]);
    expect(past.pagination).toEqual({ nextCursor: null, hasMore: false, total: 3 });
  });

  it('rejects a cursor that is not a position', async () => {
    const bia = await createPerson({ householdId: HH, name: 'Bia' });
    for (const cursor of ['share:abc', '2026-10-01|x|y', '|1|2', '']) {
      await expect(getLedger(HH, bia.id, { limit: 5, order: 'asc', cursor })).rejects.toEqual(error(400, /cursor/));
    }
  });
});

describe('race errors become 404/409, not 500', () => {
  it('PUT shares answers 409 when the person is deleted after the lock (foreign key)', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    const real = fakePrisma.transactionShare.createMany.getMockImplementation()!;
    fakePrisma.transactionShare.createMany.mockImplementationOnce(async (args) => {
      rowsOf('person').splice(rowsOf('person').findIndex((x) => x.id === bia.id), 1); // deleted by somebody else
      return real(args);
    });

    await expect(
      putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] }),
    ).rejects.toEqual(error(409, /changed meanwhile/));
    expect(rowsOf('transactionShare')).toHaveLength(0);
  });

  it('PUT shares answers 404 when the person is gone by the time the lock is taken', async () => {
    const bia = seedPerson({ householdId: HH, name: 'Bia' });
    const tx = seedTransaction({ householdId: HH, amount: 100 });
    fakePrisma.$queryRaw.mockImplementationOnce(async () => {
      rowsOf('person').splice(0, 1);
      return [{ amount: { toString: () => '100' }, type: 'EXPENSE' }];
    });
    await expect(
      putTransactionShares(HH, tx.id, { direction: 'THEY_OWE_ME', strategy: 'equal', entries: [{ personId: bia.id }] }),
    ).rejects.toEqual(error(404));
  });

  it('deleting a person already deleted by somebody else is a 404, at the lock or at the write', async () => {
    const a = seedPerson({ householdId: HH, name: 'Bia' });
    fakePrisma.$queryRaw.mockImplementationOnce(async () => []);
    await expect(deletePerson(HH, a.id)).rejects.toEqual(error(404));

    const b = seedPerson({ householdId: HH, name: 'Caio' });
    fakePrisma.person.delete.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'P2025' }));
    await expect(deletePerson(HH, b.id)).rejects.toEqual(error(404));
  });

});
