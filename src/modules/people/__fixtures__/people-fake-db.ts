/**
 * In-memory stand-in for the Prisma calls the people module makes, for unit tests. It keeps the properties the
 * module relies on: the unique keys (alias per household, share per transaction+person+direction, one settlement
 * per transaction: P2002), foreign keys (P2003), the cascades (a transaction takes its shares with it and only
 * unlinks its settlement; a person takes aliases, shares and settlements), `createMany` with `skipDuplicates`,
 * and all-or-nothing interactive transactions. Dates are 'YYYY-MM-DD' days (read back as UTC midnight, like a
 * @db.Date column), amounts are numbers (read back as decimal-likes).
 */
import { vi } from 'vitest';

type Row = Record<string, unknown> & { id: string };
type Where = Record<string, unknown>;

interface TableSpec {
  /** Sets of fields that must be unique together (null values never collide, like SQL). */
  unique: string[][];
  /** Foreign keys: field -> [table, onDelete behaviour of the parent] */
  parents: Record<string, string>;
  defaults: () => Record<string, unknown>;
}

const SPECS: Record<string, TableSpec> = {
  transaction: { unique: [], parents: {}, defaults: () => ({ description: null, notes: null, paid: true }) },
  person: { unique: [], parents: {}, defaults: () => ({ userId: null, isActive: true }) },
  personAlias: { unique: [['householdId', 'key']], parents: { personId: 'person' }, defaults: () => ({ isName: false }) },
  transactionShare: {
    unique: [['transactionId', 'personId', 'direction']],
    parents: { transactionId: 'transaction', personId: 'person' },
    defaults: () => ({ source: 'manual', note: null }),
  },
  settlement: { unique: [['transactionId']], parents: { personId: 'person' }, defaults: () => ({ transactionId: null, note: null }) },
};

type Store = Record<string, Row[]>;

export const store: Store = {};
let sequence = 0;

function resetTables(): void {
  for (const name of Object.keys(SPECS)) store[name] = [];
}
resetTables();

export function resetStore(): void {
  resetTables();
  sequence = 0;
}

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${String(sequence).padStart(4, '0')}`;
}

function prismaError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

function localDay(date: Date): string {
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Input values as the module sends them -> stored values. */
function toStored(field: string, value: unknown): unknown {
  if (field === 'date' && value instanceof Date) return localDay(value);
  if (field === 'amount' && value !== null && typeof value === 'object') return Number(String(value));
  return value;
}

function matches(row: Row, where: Where | undefined): boolean {
  if (!where) return true;
  for (const [key, condition] of Object.entries(where)) {
    if (key === 'OR') {
      if (!(condition as Where[]).some((c) => matches(row, c))) return false;
      continue;
    }
    const value = row[key];
    if (condition === null) {
      if (value !== null && value !== undefined) return false;
      continue;
    }
    if (typeof condition !== 'object' || condition instanceof Date) {
      if (value !== toStored(key, condition)) return false;
      continue;
    }
    const c = condition as Record<string, unknown>;
    if ('in' in c && !(c.in as unknown[]).includes(value)) return false;
    if ('not' in c && (c.not === null ? value === null || value === undefined : value === c.not)) return false;
    if ('startsWith' in c && !(typeof value === 'string' && value.startsWith(c.startsWith as string))) return false;
    if ('gte' in c && !(String(value) >= String(toStored(key, c.gte)))) return false;
    if ('lte' in c && !(String(value) <= String(toStored(key, c.lte)))) return false;
  }
  return true;
}

function decimal(n: number) {
  return { toNumber: () => n, toString: () => n.toFixed(2) };
}

/** What Prisma returns: Decimal amounts, @db.Date columns as UTC midnight, DateTime as Date. */
function project(row: Row, select?: Record<string, boolean>): Record<string, unknown> {
  const full: Record<string, unknown> = { ...row };
  if (typeof row.amount === 'number') full.amount = decimal(row.amount);
  if (typeof row.date === 'string') full.date = new Date(`${row.date}T00:00:00.000Z`);
  if (typeof row.createdAt === 'number') full.createdAt = new Date(1_700_000_000_000 + row.createdAt);
  if (typeof row.updatedAt === 'number') full.updatedAt = new Date(1_700_000_000_000 + row.updatedAt);
  if (!select) return full;
  return Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, full[k]]));
}

function sortRows(rows: Row[], orderBy: unknown): Row[] {
  const keys = (Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : []) as Array<Record<string, 'asc' | 'desc'>>;
  return [...rows].sort((a, b) => {
    for (const key of keys) {
      const [field, direction] = Object.entries(key)[0]!;
      const av = a[field] as string | number;
      const bv = b[field] as string | number;
      if (av === bv) continue;
      const order = av < bv ? -1 : 1;
      return direction === 'desc' ? -order : order;
    }
    return 0;
  });
}

function collides(spec: TableSpec, candidate: Row, others: Row[]): boolean {
  return spec.unique.some((fields) => {
    if (fields.some((f) => candidate[f] === null || candidate[f] === undefined)) return false;
    return others.some((o) => o !== candidate && fields.every((f) => o[f] === candidate[f]));
  });
}

function build(name: string, data: Record<string, unknown>): Row {
  const spec = SPECS[name]!;
  const row: Row = { id: nextId(name), createdAt: sequence, updatedAt: sequence, ...spec.defaults() } as Row;
  for (const [field, value] of Object.entries(data)) {
    if (value !== undefined) row[field] = toStored(field, value);
  }
  return row;
}

function checkParents(name: string, row: Row): void {
  for (const [field, parent] of Object.entries(SPECS[name]!.parents)) {
    if (row[field] !== null && row[field] !== undefined && !store[parent]!.some((p) => p.id === row[field])) {
      throw prismaError('P2003', `Foreign key constraint failed on the field: \`${field}\``);
    }
  }
}

/** Removes the rows and applies the cascades the schema declares. */
function removeRows(name: string, doomed: Row[]): void {
  if (doomed.length === 0) return;
  const ids = new Set(doomed.map((r) => r.id));
  store[name] = store[name]!.filter((r) => !ids.has(r.id));
  if (name === 'transaction') {
    store.transactionShare = store.transactionShare!.filter((r) => !ids.has(r.transactionId as string));
    for (const s of store.settlement!) if (ids.has(s.transactionId as string)) s.transactionId = null; // SET NULL
  }
  if (name === 'person') {
    store.personAlias = store.personAlias!.filter((r) => !ids.has(r.personId as string));
    store.transactionShare = store.transactionShare!.filter((r) => !ids.has(r.personId as string));
    store.settlement = store.settlement!.filter((r) => !ids.has(r.personId as string));
  }
}

function table(name: string) {
  const spec = SPECS[name]!;
  const rows = () => store[name]!;
  const insert = (data: Record<string, unknown>): Row => {
    const row = build(name, data);
    checkParents(name, row);
    if (collides(spec, row, rows())) throw prismaError('P2002', `Unique constraint failed on the fields: ${name}`);
    rows().push(row);
    return row;
  };
  return {
    findMany: vi.fn(async (args: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown; take?: number } = {}) => {
      const found = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy);
      return found.slice(0, args.take ?? found.length).map((r) => project(r, args.select));
    }),
    findFirst: vi.fn(async (args: { where?: Where; select?: Record<string, boolean>; orderBy?: unknown } = {}) => {
      const found = sortRows(rows().filter((r) => matches(r, args.where)), args.orderBy)[0];
      return found ? project(found, args.select) : null;
    }),
    count: vi.fn(async (args: { where?: Where } = {}) => rows().filter((r) => matches(r, args.where)).length),
    create: vi.fn(async (args: { data: Record<string, unknown> }) => project(insert(args.data))),
    createMany: vi.fn(async (args: { data: Array<Record<string, unknown>>; skipDuplicates?: boolean }) => {
      const before = rows().length;
      const added: Row[] = [];
      for (const data of args.data) {
        const row = build(name, data);
        checkParents(name, row);
        if (collides(spec, row, [...rows(), ...added])) {
          if (args.skipDuplicates) continue;
          // all or nothing, like one INSERT statement
          store[name] = rows().slice(0, before);
          throw prismaError('P2002', `Unique constraint failed on the fields: ${name}`);
        }
        added.push(row);
      }
      rows().push(...added);
      return { count: added.length };
    }),
    update: vi.fn(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = rows().find((r) => r.id === args.where.id);
      if (!row) throw prismaError('P2025', 'Record to update not found.');
      const next: Row = { ...row };
      for (const [field, value] of Object.entries(args.data)) next[field] = toStored(field, value);
      next.updatedAt = ++sequence;
      if (collides(spec, next, rows().filter((r) => r !== row))) throw prismaError('P2002', 'Unique constraint failed');
      Object.assign(row, next);
      return project(row);
    }),
    delete: vi.fn(async (args: { where: { id: string } }) => {
      const row = rows().find((r) => r.id === args.where.id);
      if (!row) throw prismaError('P2025', 'Record to delete does not exist.');
      removeRows(name, [row]);
      return project(row);
    }),
    deleteMany: vi.fn(async (args: { where?: Where } = {}) => {
      const doomed = rows().filter((r) => matches(r, args.where));
      removeRows(name, doomed);
      return { count: doomed.length };
    }),
  };
}

function snapshot(): Store {
  return Object.fromEntries(Object.entries(store).map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
}

export const fakePrisma = {
  transaction: table('transaction'),
  person: table('person'),
  personAlias: table('personAlias'),
  transactionShare: table('transactionShare'),
  settlement: table('settlement'),
  /** The two row-lock reads the module makes (`SELECT ... FOR UPDATE`); no real locking, tests hook the call. */
  $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join('?');
    if (!sql.includes('FOR UPDATE')) throw new Error(`Unexpected raw query: ${sql}`);
    if (sql.includes('FROM transactions')) {
      const row = store.transaction!.find((t) => t.id === values[0]);
      return row ? [{ amount: { toString: () => String(row.amount) }, type: row.type }] : [];
    }
    if (sql.includes('FROM people')) {
      const row = store.person!.find((t) => t.id === values[0]);
      return row ? [{ id: row.id }] : [];
    }
    throw new Error(`Unexpected raw query: ${sql}`);
  }),
  $transaction: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => {
    const saved = snapshot();
    try {
      return await callback(fakePrisma);
    } catch (error) {
      for (const key of Object.keys(store)) delete store[key];
      Object.assign(store, saved);
      throw error;
    }
  }),
};

// ---- Seed helpers -----------------------------------------------------------------------------------------------

export interface SeedTransaction {
  id?: string;
  householdId: string;
  type?: 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'ALLOCATION';
  amount: number;
  description?: string | null;
  /** YYYY-MM-DD */
  date?: string;
  notes?: string | null;
}

export function seedTransaction(data: SeedTransaction): Row {
  const row = build('transaction', { type: 'EXPENSE', date: '2026-10-01', ...data });
  store.transaction!.push(row);
  return row;
}

/** A person with its name key (and optional aliases) the way the service stores them. */
export function seedPerson(data: { id?: string; householdId: string; name: string; aliases?: string[]; isActive?: boolean }): Row {
  const person = build('person', { id: data.id, householdId: data.householdId, name: data.name, isActive: data.isActive ?? true });
  store.person!.push(person);
  const key = (label: string) => label.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
  for (const [i, label] of [data.name, ...(data.aliases ?? [])].entries()) {
    store.personAlias!.push(build('personAlias', { householdId: data.householdId, personId: person.id, label, key: key(label), isName: i === 0 }));
  }
  return person;
}

export function seedShare(data: {
  householdId: string;
  transactionId: string;
  personId: string;
  amount: number;
  direction?: 'THEY_OWE_ME' | 'I_OWE_THEM';
  source?: 'manual' | 'import';
  note?: string | null;
}): Row {
  const row = build('transactionShare', { direction: 'THEY_OWE_ME', ...data });
  store.transactionShare!.push(row);
  return row;
}

export function seedSettlement(data: {
  householdId: string;
  personId: string;
  amount: number;
  date?: string;
  direction?: 'RECEIVED' | 'PAID';
  transactionId?: string | null;
  note?: string | null;
}): Row {
  const row = build('settlement', { direction: 'RECEIVED', date: '2026-10-05', ...data });
  store.settlement!.push(row);
  return row;
}

export function rowsOf(name: keyof typeof SPECS): Row[] {
  return store[name]!;
}
