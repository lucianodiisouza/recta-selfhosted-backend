import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The people module relies on database-level guarantees: names and aliases are unique per household, a person's
// share of a transaction is unique per direction, a transaction backs at most one settlement, amounts are positive,
// and deleting a transaction removes its shares but only unlinks its settlement. The migration is written by hand,
// so pin it against the schema.

const migrationsDir = new URL('../../../prisma/migrations/', import.meta.url);
const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

function peopleMigration(): string {
  const folder = readdirSync(migrationsDir).find((name) => name.endsWith('_add_people_and_shares'));
  if (!folder) throw new Error('migration add_people_and_shares not found');
  return readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), 'utf8');
}

function modelBlock(name: string): string {
  const start = schema.indexOf(`model ${name} {`);
  const end = start < 0 ? -1 : schema.indexOf('\n}', start);
  if (end < 0) throw new Error(`model ${name} not found in schema.prisma`);
  return schema.slice(start, end);
}

describe('people migration', () => {
  const sql = peopleMigration();

  it('only adds: no table is dropped or altered apart from constraints on the new ones', () => {
    expect(sql).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
    const alters = [...sql.matchAll(/ALTER TABLE "(\w+)"/g)].map((m) => m[1]);
    for (const table of alters) {
      expect(['people', 'person_aliases', 'transaction_shares', 'settlements']).toContain(table);
    }
  });

  it('makes names and aliases unique per household through one key table', () => {
    expect(sql).toMatch(/CREATE UNIQUE INDEX "person_aliases_household_id_key_key" ON "person_aliases"\("household_id", "key"\)/);
    expect(modelBlock('PersonAlias')).toMatch(/@@unique\(\[householdId, key\]\)/);
  });

  it('makes a share unique per transaction, person and direction, and a transaction back one settlement', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "transaction_shares_transaction_id_person_id_direction_key" ON "transaction_shares"\("transaction_id", "person_id", "direction"\)/,
    );
    expect(sql).toMatch(/CREATE UNIQUE INDEX "settlements_transaction_id_key" ON "settlements"\("transaction_id"\)/);
    expect(modelBlock('TransactionShare')).toMatch(/@@unique\(\[transactionId, personId, direction\]\)/);
    expect(modelBlock('Settlement')).toMatch(/transactionId\s+String\?\s+@unique/);
  });

  it('keeps amounts positive with two decimals', () => {
    expect(sql).toMatch(/"amount" DECIMAL\(12,2\) NOT NULL/);
    expect(sql).toMatch(/CONSTRAINT "transaction_shares_amount_positive" CHECK \("amount" > 0\)/);
    expect(sql).toMatch(/CONSTRAINT "settlements_amount_positive" CHECK \("amount" > 0\)/);
  });

  it('removes shares with their transaction and only unlinks the settlement', () => {
    expect(sql).toMatch(/"transaction_shares_transaction_id_fkey" FOREIGN KEY \("transaction_id"\) REFERENCES "transactions"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"settlements_transaction_id_fkey" FOREIGN KEY \("transaction_id"\) REFERENCES "transactions"\("id"\) ON DELETE SET NULL/);
  });

  it('cascades people from the household', () => {
    expect(sql).toMatch(/"people_household_id_fkey" FOREIGN KEY \("household_id"\) REFERENCES "households"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/"person_aliases_person_id_fkey" FOREIGN KEY \("person_id"\) REFERENCES "people"\("id"\) ON DELETE CASCADE/);
  });
});
