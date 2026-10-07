import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { storedDateString } from '../../shared/utils/local-date.js';
import { buildLedger, compareLedgerRows, computeBalance, type BalanceCents } from './balance.js';
import { MAX_ALIASES, MAX_PEOPLE_PER_HOUSEHOLD, buildKeyRows, conflictOnUnique, labelKey, type Db } from './people.common.js';
import type { LedgerEntryDto, LedgerPage, PersonBalanceDto, PersonDto } from './people.types.js';
import { fromCents, storedToCents } from './money.js';

/** The persisted pieces of a person the service reads back. */
interface PersonRow {
  id: string;
  householdId: string;
  name: string;
  userId: string | null;
  isActive: boolean;
}

interface AliasRow {
  personId: string;
  label: string;
  key: string;
  isName: boolean;
}

const NAME_CONFLICT = 'That name or alias is already used by another person';

function toPersonDto(person: PersonRow, aliases: AliasRow[]): PersonDto {
  return {
    id: person.id,
    householdId: person.householdId,
    name: person.name,
    aliases: aliases.filter((a) => a.personId === person.id && !a.isName).map((a) => a.label),
    userId: person.userId,
    isActive: person.isActive,
  };
}

function byNameThenId(a: PersonRow, b: PersonRow): number {
  const ka = labelKey(a.name);
  const kb = labelKey(b.name);
  if (ka !== kb) return ka < kb ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function loadAliasRows(db: Db, householdId: string): Promise<AliasRow[]> {
  return db.personAlias.findMany({
    where: { householdId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { personId: true, label: true, key: true, isName: true },
  });
}

/**
 * The rows of a person's lookup keys, with creation times one millisecond apart: rows written in one statement would
 * share a timestamp and come back in id (random) order, and the order is what says which aliases are the most recent
 * when a rename has to trim the list.
 */
function aliasInsertData(householdId: string, personId: string, rows: ReadonlyArray<{ label: string; key: string; isName: boolean }>) {
  const base = Date.now();
  return rows.map((r, index) => ({ householdId, personId, label: r.label, key: r.key, isName: r.isName, createdAt: new Date(base + index) }));
}

/** The person of the household, or 404. Nothing outside the household is ever readable through here. */
export async function findPersonOrThrow(db: Db, householdId: string, personId: string): Promise<PersonRow> {
  const person = await db.person.findFirst({ where: { id: personId, householdId } });
  if (!person) throw new NotFoundError('Person');
  return person;
}

/** Household that owns a person, to authorize routes keyed by the person id alone; null when there is none. */
export async function findPersonHousehold(personId: string): Promise<string | null> {
  const person = await prisma.person.findFirst({ where: { id: personId }, select: { householdId: true } });
  return person?.householdId ?? null;
}

export async function listPeople(householdId: string, includeInactive = false): Promise<PersonDto[]> {
  const people = await prisma.person.findMany({
    where: { householdId, ...(includeInactive ? {} : { isActive: true }) },
  });
  if (people.length === 0) return [];
  const aliases = await loadAliasRows(prisma, householdId);
  return [...people].sort(byNameThenId).map((p) => toPersonDto(p, aliases));
}

/** 409 when a key is already used by a person other than `exceptPersonId`. */
async function assertKeysFree(db: Db, householdId: string, keys: string[], exceptPersonId?: string): Promise<void> {
  if (keys.length === 0) return;
  const taken = await db.personAlias.findMany({
    where: { householdId, key: { in: keys } },
    select: { personId: true, label: true },
  });
  const clash = taken.find((row) => row.personId !== exceptPersonId);
  if (clash) throw new ConflictError(`"${clash.label}" is already used by another person`);
}

export async function createPerson(input: { householdId: string; name: string; aliases?: string[] }): Promise<PersonDto> {
  const { householdId } = input;
  const rows = buildKeyRows(input.name, input.aliases ?? []);
  return conflictOnUnique(NAME_CONFLICT, () =>
    prisma.$transaction(async (tx) => {
      await assertKeysFree(tx, householdId, rows.map((r) => r.key));
      if ((await tx.person.count({ where: { householdId } })) >= MAX_PEOPLE_PER_HOUSEHOLD) {
        throw new BadRequestError(`A household can have at most ${MAX_PEOPLE_PER_HOUSEHOLD} people`);
      }
      const person = await tx.person.create({ data: { householdId, name: rows[0]!.label } });
      await tx.personAlias.createMany({
        data: aliasInsertData(householdId, person.id, rows),
      });
      return toPersonDto(person, rows.map((r) => ({ ...r, personId: person.id })));
    }),
  );
}

export async function updatePerson(
  householdId: string,
  personId: string,
  input: { name?: string; aliases?: string[]; isActive?: boolean },
): Promise<PersonDto> {
  return conflictOnUnique(NAME_CONFLICT, () =>
    prisma.$transaction(async (tx) => {
      const person = await findPersonOrThrow(tx, householdId, personId);
      const current = (await loadAliasRows(tx, householdId)).filter((a) => a.personId === personId);

      let aliasRows = current;
      let name = person.name;
      if (input.name !== undefined || input.aliases !== undefined) {
        name = input.name ?? person.name;
        const aliases = input.aliases ?? current.filter((a) => !a.isName).map((a) => a.label);
        // A rename keeps answering to the old name (existing labels and notes still use it); buildKeyRows drops it when it
        // is only a change of case or accents
        const built = buildKeyRows(name, name === person.name ? aliases : [...aliases, person.name]);
        // Every rename adds the old name, so the list would outgrow what the update body accepts: keep the most
        // recent aliases (the old name is last) up to the cap
        const rows = [built[0]!, ...built.slice(1).slice(-MAX_ALIASES)];
        name = rows[0]!.label;
        await assertKeysFree(tx, householdId, rows.map((r) => r.key), personId);
        await tx.personAlias.deleteMany({ where: { personId } });
        await tx.personAlias.createMany({
          data: aliasInsertData(householdId, personId, rows),
        });
        aliasRows = rows.map((r) => ({ ...r, personId }));
      }

      const updated = await tx.person.update({
        where: { id: personId },
        data: {
          ...(name !== person.name ? { name } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
        },
      });
      return toPersonDto(updated, aliasRows);
    }),
  );
}

export type DeletePersonResult = { deleted: true } | { deleted: false; person: PersonDto };

/** Deletes a person with no history; one with shares or settlements is only deactivated (the data stays). */
export async function deletePerson(householdId: string, personId: string): Promise<DeletePersonResult> {
  try {
    return await deletePersonLocked(householdId, personId);
  } catch (error) {
    // The person was deleted by somebody else between our lookup and our write
    if ((error as { code?: unknown } | null)?.code === 'P2025') throw new NotFoundError('Person');
    throw error;
  }
}

async function deletePersonLocked(householdId: string, personId: string): Promise<DeletePersonResult> {
  return prisma.$transaction(async (tx) => {
    const person = await findPersonOrThrow(tx, householdId, personId);
    // Row lock: a share or settlement being inserted for this person holds a key-share lock until it commits, so
    // waiting for ours means the counts below see it (instead of the delete cascading it away)
    const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM people WHERE id = ${personId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
    if (locked.length === 0) throw new NotFoundError('Person');
    const [shares, settlements] = await Promise.all([
      tx.transactionShare.count({ where: { personId } }),
      tx.settlement.count({ where: { personId } }),
    ]);
    if (shares + settlements > 0) {
      const updated = await tx.person.update({ where: { id: personId }, data: { isActive: false } });
      const aliases = (await loadAliasRows(tx, householdId)).filter((a) => a.personId === personId);
      return { deleted: false as const, person: toPersonDto(updated, aliases) };
    }
    await tx.person.delete({ where: { id: personId } });
    return { deleted: true as const };
  });
}

// ---------------------------------------------------------------------------
// Balances and ledger
// ---------------------------------------------------------------------------

function balanceDto(person: PersonDto, balance: BalanceCents): PersonBalanceDto {
  return {
    person,
    owedToMe: fromCents(balance.owedToMe),
    iOwe: fromCents(balance.iOwe),
    received: fromCents(balance.received),
    paid: fromCents(balance.paid),
    balance: fromCents(balance.balance),
    openShares: balance.openShares,
  };
}

/** Balance of every active person (zero included) and of the inactive ones that still have a balance. */
export async function listBalances(householdId: string): Promise<PersonBalanceDto[]> {
  const [people, aliases, shares, settlements] = await Promise.all([
    prisma.person.findMany({ where: { householdId } }),
    loadAliasRows(prisma, householdId),
    prisma.transactionShare.findMany({ where: { householdId }, select: { personId: true, direction: true, amount: true } }),
    prisma.settlement.findMany({ where: { householdId }, select: { personId: true, direction: true, amount: true } }),
  ]);

  const sharesBy = new Map<string, Array<{ direction: 'THEY_OWE_ME' | 'I_OWE_THEM'; amountCents: number }>>();
  for (const s of shares) {
    const list = sharesBy.get(s.personId) ?? [];
    list.push({ direction: s.direction, amountCents: storedToCents(s.amount) });
    sharesBy.set(s.personId, list);
  }
  const settlementsBy = new Map<string, Array<{ direction: 'RECEIVED' | 'PAID'; amountCents: number }>>();
  for (const s of settlements) {
    const list = settlementsBy.get(s.personId) ?? [];
    list.push({ direction: s.direction, amountCents: storedToCents(s.amount) });
    settlementsBy.set(s.personId, list);
  }

  return [...people]
    .sort(byNameThenId)
    .map((person) => ({
      person,
      balance: computeBalance(sharesBy.get(person.id) ?? [], settlementsBy.get(person.id) ?? []),
    }))
    .filter(({ person, balance }) => person.isActive || balance.balance !== 0)
    .map(({ person, balance }) => balanceDto(toPersonDto(person, aliases), balance));
}

const SETTLEMENT_LABEL = { RECEIVED: 'Settlement received', PAID: 'Settlement paid' } as const;

/** A cursor is the sort key of the last row returned (day|creation ms|id), so it still works if that row is deleted. */
function ledgerCursor(row: { date: string; createdAt: number; id: string }): string {
  return `${row.date}|${row.createdAt}|${row.id}`;
}

function parseLedgerCursor(cursor: string): { date: string; createdAt: number; id: string } {
  const match = /^(\d{4}-\d{2}-\d{2})\|(\d{1,16})\|(.+)$/.exec(cursor);
  if (!match) throw new BadRequestError('Invalid cursor');
  return { date: match[1]!, createdAt: Number(match[2]), id: match[3]! };
}

/**
 * Timeline of a person: shares and settlements with the running balance, computed over the whole history in
 * chronological order (day, creation, id) and then paged. Newest first by default; `order: 'asc'` flips the list,
 * not the balances. The cursor is the sort key of the last row returned: the next page is what comes after that position.
 */
export async function getLedger(
  householdId: string,
  personId: string,
  query: { limit: number; cursor?: string; order: 'asc' | 'desc' },
): Promise<LedgerPage> {
  await findPersonOrThrow(prisma, householdId, personId);

  const [shares, settlements] = await Promise.all([
    prisma.transactionShare.findMany({ where: { householdId, personId } }),
    prisma.settlement.findMany({ where: { householdId, personId } }),
  ]);
  const transactionIds = [
    ...new Set([...shares.map((s) => s.transactionId), ...settlements.flatMap((s) => (s.transactionId ? [s.transactionId] : []))]),
  ];
  const transactions = transactionIds.length
    ? await prisma.transaction.findMany({
        where: { householdId, id: { in: transactionIds } },
        select: { id: true, description: true, amount: true, date: true },
      })
    : [];
  const txById = new Map(transactions.map((t) => [t.id, t]));

  const chronological = buildLedger(
    shares.flatMap((s) => {
      const tx = txById.get(s.transactionId);
      if (!tx) return []; // cannot happen (the foreign key cascades), but never invent a date
      return [
        {
          id: s.id,
          date: storedDateString(tx.date),
          createdAt: s.createdAt.getTime(),
          description: tx.description ?? '',
          direction: s.direction,
          amountCents: storedToCents(s.amount),
          transactionId: s.transactionId,
          transactionAmountCents: storedToCents(tx.amount),
          note: s.note,
          source: s.source === 'import' ? ('import' as const) : ('manual' as const),
        },
      ];
    }),
    settlements.map((s) => {
      const linked = s.transactionId ? txById.get(s.transactionId) : undefined;
      return {
        id: s.id,
        date: storedDateString(s.date),
        createdAt: s.createdAt.getTime(),
        description: linked?.description || SETTLEMENT_LABEL[s.direction],
        direction: s.direction,
        amountCents: storedToCents(s.amount),
        transactionId: s.transactionId,
        transactionAmountCents: linked ? storedToCents(linked.amount) : null,
        note: s.note,
      };
    }),
  );

  const ordered = query.order === 'asc' ? chronological : [...chronological].reverse();
  let start = 0;
  if (query.cursor !== undefined) {
    const position = parseLedgerCursor(query.cursor);
    const after = query.order === 'asc' ? (row: typeof position) => compareLedgerRows(row, position) > 0 : (row: typeof position) => compareLedgerRows(row, position) < 0;
    const next = ordered.findIndex(after);
    start = next < 0 ? ordered.length : next;
  }
  const page = ordered.slice(start, start + query.limit);
  const hasMore = start + query.limit < ordered.length;

  const data: LedgerEntryDto[] = page.map((row) => ({
    kind: row.kind,
    id: row.id,
    date: row.date,
    description: row.description,
    direction: row.direction,
    amount: fromCents(row.amountCents),
    signed: fromCents(row.signedCents),
    balanceAfter: fromCents(row.balanceAfterCents),
    transactionId: row.transactionId,
    transactionAmount: row.transactionAmountCents === null ? null : fromCents(row.transactionAmountCents),
    note: row.note,
    source: row.source,
  }));
  return {
    data,
    pagination: { nextCursor: hasMore && page.length > 0 ? ledgerCursor(page[page.length - 1]!) : null, hasMore, total: ordered.length },
  };
}
