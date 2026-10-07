import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard (a text scan, not a type-aware analysis): every function that writes a category name must take the
 * category share lock (`lockCustomCategory`) in that same function, or be listed in EXCEPTIONS with the reason it cannot
 * leave an orphan `CUSTOM:<id>` reference behind.
 *
 * Why: merging or deleting a custom category locks its row FOR UPDATE and re-points every reference. A writer that
 * stores a `CUSTOM:<id>` without sharing that lock can commit after the merge and leave a row pointing at a category
 * that no longer exists.
 *
 * WHAT THE SCAN COVERS (comments are stripped first, so a lock or a write that only appears in a comment does not count):
 *  - units: `function name` (also `export default`), `const name = (...) =>` / `= async function` / `= wrapper(async ...)`,
 *    all at column 0, and methods indented by two spaces whose signature fits on one line (`  name(...) {`,
 *    `  async name(...) {`), each running to the next unit;
 *  - writes: Prisma `create`, `createMany` (and `createManyAndReturn`), `update`, `updateMany` or `upsert` whose call text
 *    contains `categoryName` or `category_name`; `createMany`/`create` whose `data` is a variable in a unit that
 *    mentions `categoryName`; `$executeRaw`/`$queryRaw` (and the `Unsafe` forms) containing INSERT or UPDATE on
 *    `category_name` or on one of the tables that has the column (transactions, recurring_transactions, budgets), or
 *    called with a variable in a unit that mentions `categoryName`;
 *  - a lock: an actual `lockCustomCategory(` call in the same unit that comes BEFORE its first write.
 *
 * WHAT IT DOES NOT COVER (these rely on review): a write in a unit that never spells `categoryName` (for example
 * `data: { ...row }` of a row built elsewhere); a nested function or callback inside a unit (it belongs to the outer unit);
 * a method whose signature spans several lines, or an anonymous `export default` function (no unit starts there, so the
 * text belongs to the unit before it); a lock taken for a different category than the one written (the check is textual:
 * a call before the write, not the same argument); a write reached only through a helper in another file (that helper is
 * its own unit and is checked there); and code outside `src/` or in scripts. The probes below pin each covered shape.
 *
 * HOW A NEW WRITER REGISTERS (the checklist for a PR that adds code storing a category name):
 *  1. If it can store a custom category (the name comes from the user, a file, a recurrence...), call
 *     `lockCustomCategory(tx, householdId, categoryName)` inside the SAME database transaction that writes the row,
 *     before the write. When it writes several, lock them in sorted order (a merge locks in id order too).
 *  2. If it only ever stores fixed system names (TRANSFER, OTHER_EXPENSES...), add `'<path under src>::<unit>'` to
 *     EXCEPTIONS below with the reason. The guard tells you the exact key when it finds the writer.
 *  3. A unit that calls `createTransaction` / `updateTransaction` / `batchCreateTransactions` needs nothing: those
 *     already lock (and the tests at the bottom pin that), so importers that go through them are covered.
 *  4. Renaming or removing a listed unit makes the "no stale entries" test fail: update the key.
 */
const EXCEPTIONS: Record<string, string> = {
  'modules/categories/categories.merge.service.ts::run': 'the merge itself: it holds the category rows FOR UPDATE and re-points the references',
  'modules/accounts/accounts.service.ts::transferBetweenAccounts': 'writes the fixed system names TRANSFER/ALLOCATION, never a custom id',
  'modules/accounts/accounts.service.ts::adjustBalance': 'writes the system names OTHER_INCOME/OTHER_EXPENSES by sign, never a custom id',
  'modules/transactions/transactions.service.ts::payCreditCardInvoice': 'writes the fixed system name OTHER_EXPENSES',
  'modules/transactions/transactions.service.ts::createTransfer': 'writes the fixed system name TRANSFER',
  'modules/transactions/transactions.service.ts::createAllocation': 'writes the fixed system name ALLOCATION',
  'modules/transactions/transactions.service.ts::createDeallocation': 'writes the fixed system name ALLOCATION',
};

const CATEGORY_TABLES = '(?:transactions|recurring_transactions|budgets)';

/** Removes comments but leaves string and template literals alone (a `//` inside a string is not a comment). */
function stripComments(text: string): string {
  return text.replace(/("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (_m, literal?: string) => literal ?? ' ');
}

const UNIT_START = new RegExp(
  [
    '^(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s+(\\w+)',
    // `const x = async (...) =>` and also `const x = withTx(async (...) =>` (a wrapper call around the function).
    '^(?:export\\s+)?const\\s+(\\w+)\\s*(?::[^=\\n]+)?=\\s*(?:[\\w.]+\\(\\s*)?(?:async\\s*)?(?:function\\b|\\([^\\n]*\\)\\s*(?::[^=\\n]+)?=>|\\w+\\s*=>)',
    '^  (?:async\\s+)?(?!(?:if|for|while|switch|catch|return|else|function|await)\\b)(\\w+)\\s*\\([^\\n]*\\)\\s*(?::\\s*[^{\\n]+)?\\{\\s*$',
  ].join('|'),
  'gm',
);

export function units(text: string): Array<{ name: string; body: string }> {
  const code = stripComments(text);
  const starts = [...code.matchAll(UNIT_START)];
  return starts.map((m, i) => ({ name: m[1] ?? m[2] ?? m[3], body: code.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : code.length) }));
}

/** The text of the call that opens at `open` (the index of its "("), up to the matching ")". */
function callText(body: string, open: number): string {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === '(') depth += 1;
    else if (body[i] === ')' && --depth === 0) return body.slice(open, i + 1);
  }
  return body.slice(open);
}

/** Index of the first statement of the unit that writes a category name, or -1 when it writes none. */
export function firstWrite(body: string): number {
  const mentionsName = /\bcategoryName\b|\bcategory_name\b/.test(body);
  const found: number[] = [];
  for (const m of body.matchAll(/\.(create|createMany\w*|update|updateMany|upsert)\s*\(/g)) {
    const call = callText(body, m.index! + m[0].length - 1);
    if (/\bcategoryName\b|\bcategory_name\b/.test(call)) found.push(m.index!);
    // `createMany({ data })` / `create({ data: rows })`: the rows were built earlier in the unit.
    else if (mentionsName && /\bdata\s*(?::\s*[A-Za-z_$][\w$.]*\s*[,}]|[,}])/.test(call)) found.push(m.index!);
  }
  for (const m of body.matchAll(/\$(?:executeRaw|queryRaw)(?:Unsafe)?/g)) {
    const end = body.indexOf(';', m.index!);
    const sql = body.slice(m.index!, end === -1 ? body.length : end);
    if (new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE)\\b[^;]*?(?:\\bcategory_name\\b|\\b${CATEGORY_TABLES}\\b)`, 'i').test(sql)) found.push(m.index!);
    // `$executeRaw(sql)`: the statement is built elsewhere; in a unit that handles category names it counts as a write.
    else if (mentionsName && /^\$(?:executeRaw|queryRaw)(?:Unsafe)?\s*\(\s*[A-Za-z_$]/.test(sql)) found.push(m.index!);
  }
  return found.length === 0 ? -1 : Math.min(...found);
}

export function writesCategory(body: string): boolean {
  return firstWrite(body) >= 0;
}

/** An actual `lockCustomCategory(` call that comes BEFORE the first write of the unit. */
export function takesLock(body: string): boolean {
  const lock = body.search(/\blockCustomCategory\s*\(/);
  if (lock < 0) return false;
  const write = firstWrite(body);
  return write < 0 || lock < write;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated' || name === 'scripts' || name === '__fixtures__') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('the scan itself (sabotage probes: each shape must be found, and an unlocked one must be reported)', () => {
  const found = (text: string) => units(text).filter((u) => writesCategory(u.body)).map((u) => `${u.name}:${takesLock(u.body) ? 'locked' : 'unlocked'}`);

  it('finds a function declaration that writes through create', () => {
    expect(found(`export async function a(tx: T) {\n  await tx.transaction.create({ data: { categoryName: 'X' } });\n}\n`)).toEqual(['a:unlocked']);
  });

  it('finds an arrow-function const writer', () => {
    expect(found(`export const b = async (tx: T, categoryName: string) => {\n  return tx.budget.update({ where: { id: 1 }, data: { categoryName } });\n};\n`)).toEqual(['b:unlocked']);
  });

  it('finds a method of a class or object', () => {
    expect(found(`export const svc = {\n  async c(tx: T) {\n    await tx.transaction.updateMany({ data: { categoryName: 'X' } });\n  },\n};\n`)).toEqual(['c:unlocked']);
  });

  it('finds createMany whose data was built before the call', () => {
    expect(found(`async function d(tx: T) {\n  const rows = items.map((i) => ({ categoryName: i.c }));\n  await tx.transaction.createMany({ data: rows });\n}\n`)).toEqual(['d:unlocked']);
    expect(found(`async function e(tx: T) {\n  const categoryName = pick();\n  await tx.transaction.createMany({ data });\n}\n`)).toEqual(['e:unlocked']);
  });

  it('finds raw SQL that inserts or updates a table with a category column', () => {
    expect(found('async function f(tx: T) {\n  await tx.$executeRaw`INSERT INTO transactions (id, category_name) VALUES (${id}, ${name})`;\n}\n')).toEqual(['f:unlocked']);
    expect(found('async function g(tx: T) {\n  await tx.$executeRaw`UPDATE budgets SET monthly_limit = 1 WHERE id = ${id}`;\n}\n')).toEqual(['g:unlocked']);
    expect(found('async function h(tx: T) {\n  await tx.$queryRaw`SELECT id FROM transactions WHERE id = ${id} FOR UPDATE`;\n}\n')).toEqual([]);
  });

  it('finds createManyAndReturn, an export default function and a wrapper-call arrow', () => {
    expect(found(`async function n(tx: T) {
  await tx.transaction.createManyAndReturn({ data: [{ categoryName: 'X' }] });
}
`)).toEqual(['n:unlocked']);
    expect(found(`export default async function o(tx: T) {
  await tx.budget.update({ data: { categoryName: 'X' } });
}
`)).toEqual(['o:unlocked']);
    expect(found(`export const p = withTx(async (tx: T) => {
  await tx.budget.update({ data: { categoryName: 'X' } });
});
`)).toEqual(['p:unlocked']);
  });

  it('finds $executeRaw called with a statement built elsewhere, in a unit that handles category names', () => {
    expect(found(`async function q(tx: T, categoryName: string) {
  const sql = build(categoryName);
  await tx.$executeRaw(sql);
}
`)).toEqual(['q:unlocked']);
    expect(found(`async function r(tx: T) {
  await tx.$executeRaw(sql);
}
`)).toEqual([]);
  });

  it('does not count a lock taken after the write', () => {
    expect(found(`async function s(tx: T, n: string) {
  await tx.transaction.create({ data: { categoryName: n } });
  await lockCustomCategory(tx, h, n);
}
`)).toEqual(['s:unlocked']);
  });

  it('does not count a lock that only appears in a comment, but counts a real call', () => {
    expect(found(`async function i(tx: T) {\n  // TODO lockCustomCategory(tx, h, n)\n  /* lockCustomCategory(tx, h, n) */\n  await tx.transaction.create({ data: { categoryName: 'X' } });\n}\n`)).toEqual(['i:unlocked']);
    expect(found(`async function j(tx: T) {\n  await lockCustomCategory(tx, h, n);\n  await tx.transaction.create({ data: { categoryName: n } });\n}\n`)).toEqual(['j:locked']);
  });

  it('does not count a write that only appears in a comment, and keeps a "//" inside a string', () => {
    expect(found(`async function k(tx: T) {\n  // tx.transaction.create({ data: { categoryName: 'X' } })\n}\n`)).toEqual([]);
    expect(found(`async function l(tx: T) {\n  const url = 'https://x.test';\n  await tx.transaction.create({ data: { categoryName: n } });\n}\n`)).toEqual(['l:unlocked']);
  });

  it('ignores a write that does not touch a category', () => {
    expect(found(`async function m(tx: T) {\n  await tx.transaction.update({ where: { id: 1 }, data: { paid: true } });\n}\n`)).toEqual([]);
  });
});

describe('category writers take the category lock', () => {
  const root = join(process.cwd(), 'src');
  const found: Array<{ key: string; locked: boolean }> = [];
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    for (const unit of units(text)) {
      if (writesCategory(unit.body)) found.push({ key: `${relative(root, file).split(sep).join('/')}::${unit.name}`, locked: takesLock(unit.body) });
    }
  }

  it('finds the known writers (the scan itself works)', () => {
    const keys = found.map((f) => f.key);
    for (const expected of [
      'modules/transactions/transactions.service.ts::createTransaction',
      'modules/transactions/transactions.service.ts::updateTransaction',
      'modules/transactions/transactions.service.ts::batchCreateTransactions',
      'modules/recurring-transactions/recurring-transactions.service.ts::createRecurringTransaction',
      'modules/recurring-transactions/recurring-transactions.service.ts::updateRecurringTransaction',
      'modules/recurring-transactions/recurring-transactions.service.ts::executeRecurringTransaction',
      'modules/recurring-transactions/recurring-detect.service.ts::applyDetectedRecurrences',
      'modules/budgets/budgets.service.ts::createBudget',
    ]) expect(keys).toContain(expected);
  });

  it('every writer locks the category or is a justified exception', () => {
    const offenders = found.filter((f) => !f.locked && !(f.key in EXCEPTIONS)).map((f) => f.key);
    expect(offenders, 'a unit writes a category name without lockCustomCategory: lock it, or register it in EXCEPTIONS (see the header of this file)').toEqual([]);
  });

  it('exceptions are still real writers (no stale entries)', () => {
    const keys = found.map((f) => f.key);
    expect(Object.keys(EXCEPTIONS).filter((k) => !keys.includes(k)), 'an EXCEPTIONS entry no longer matches a writer: update or remove it').toEqual([]);
  });

  it('an exception never takes the lock (otherwise it should not be listed)', () => {
    const lockedExceptions = found.filter((f) => f.locked && f.key in EXCEPTIONS).map((f) => f.key);
    expect(lockedExceptions).toEqual([]);
  });

  it('updateTransaction locks the new category inside its $transaction', () => {
    const text = readFileSync(join(root, 'modules/transactions/transactions.service.ts'), 'utf8');
    expect(text).toMatch(/if \(input\.categoryName\) await lockCustomCategory\(tx, householdId, input\.categoryName\)/);
  });

  it('createTransaction and batchCreateTransactions lock inside their $transaction (every importer goes through them)', () => {
    const text = readFileSync(join(root, 'modules/transactions/transactions.service.ts'), 'utf8');
    const create = units(text).find((c) => c.name === 'createTransaction')!.body;
    expect(create).toMatch(/\$transaction\(async \(tx[^)]*\) => \{\s*await lockCustomCategory\(tx, householdId, categoryName\)/);
    const batch = units(text).find((c) => c.name === 'batchCreateTransactions')!.body;
    expect(batch).toMatch(/for \(const name of customNames\) await lockCustomCategory\(tx, householdId, name\)/);
  });
});
