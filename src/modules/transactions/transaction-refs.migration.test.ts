import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The card invoice import relies on these properties of the reference columns: `transactions.source_ref` is unique
// per household (a second insert is a P2002, read as "already imported") and nullable (manual transactions carry
// none), and `transaction_external_refs.ref` is unique per household, goes away with its transaction and is indexed
// by transaction. The migrations are written by hand, so pin them against the schema.

const migrationsDir = new URL('../../../prisma/migrations/', import.meta.url);
const schema = readFileSync(new URL('../../../prisma/schema.prisma', import.meta.url), 'utf8');

function migration(suffix: string): string {
  const folder = readdirSync(migrationsDir).find((name) => name.endsWith(suffix));
  if (!folder) throw new Error(`migration ${suffix} not found`);
  return readFileSync(new URL(`${folder}/migration.sql`, migrationsDir), 'utf8');
}

function modelBlock(name: string): string {
  const match = new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!match?.[1]) throw new Error(`model ${name} not found in schema.prisma`);
  return match[1];
}

describe('transactions.source_ref migration', () => {
  const sql = migration('_add_transaction_source_ref');

  it('adds a nullable column of 120 characters', () => {
    expect(sql).toMatch(/ALTER TABLE "transactions" ADD COLUMN\s+"source_ref" VARCHAR\(120\);/);
    expect(sql).not.toMatch(/NOT NULL/);
  });

  it('makes it unique per household, in one step', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "transactions_household_id_source_ref_key" ON "transactions"\("household_id", "source_ref"\)/,
    );
    expect(sql).not.toMatch(/DROP INDEX/);
  });

  it('matches the Prisma model', () => {
    const model = modelBlock('Transaction');

    expect(model).toMatch(/sourceRef\s+String\?\s+@map\("source_ref"\)\s+@db\.VarChar\(120\)/);
    expect(model).toMatch(/@@unique\(\[householdId, sourceRef\]\)/);
  });
});

describe('transaction_external_refs migration', () => {
  const sql = migration('_add_transaction_external_refs');

  it('creates the table with the columns the service reads', () => {
    expect(sql).toContain('CREATE TABLE "transaction_external_refs"');
    expect(sql).toMatch(/"household_id" UUID NOT NULL/);
    expect(sql).toMatch(/"transaction_id" UUID NOT NULL/);
    expect(sql).toMatch(/"ref" VARCHAR\(120\) NOT NULL/);
    expect(sql).toMatch(/"created_at" TIMESTAMP\(3\) NOT NULL DEFAULT CURRENT_TIMESTAMP/);
  });

  it('makes a ref unique per household', () => {
    expect(sql).toMatch(
      /CREATE UNIQUE INDEX "transaction_external_refs_household_id_ref_key" ON "transaction_external_refs"\("household_id", "ref"\)/,
    );
  });

  it('deletes the refs with their transaction and indexes the lookup by transaction', () => {
    expect(sql).toMatch(/FOREIGN KEY \("transaction_id"\) REFERENCES "transactions"\("id"\) ON DELETE CASCADE/);
    expect(sql).toMatch(/CREATE INDEX "transaction_external_refs_transaction_id_idx" ON "transaction_external_refs"\("transaction_id"\)/);
  });

  it('matches the Prisma model', () => {
    const model = modelBlock('TransactionExternalRef');

    expect(model).toMatch(/@@unique\(\[householdId, ref\]\)/);
    expect(model).toMatch(/@@index\(\[transactionId\]\)/);
    expect(model).toMatch(/ref\s+String\s+@db\.VarChar\(120\)/);
    expect(model).toMatch(/onDelete: Cascade/);
    expect(model).toMatch(/@@map\("transaction_external_refs"\)/);
  });
});
