import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `SELECT pg_advisory_xact_lock(...)` returns `void`, which Prisma 7 with the pg adapter cannot deserialize through
 * $queryRaw (it throws on a real database; the in-memory fakes hide it). Locks must use $executeRaw.
 */
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

describe('advisory locks', () => {
  it('never go through $queryRaw (void result cannot be deserialized)', () => {
    const offenders = sources(join(process.cwd(), 'src')).filter((file) => {
      const text = readFileSync(file, 'utf8');
      return /\$queryRaw(?:<[^>]*>)?\s*`[^`]*pg_advisory/.test(text);
    });
    expect(offenders).toEqual([]);
  });

  it('are taken with $executeRaw where the recurrences are written', () => {
    for (const file of [
      'modules/recurring-transactions/recurring-detect.service.ts',
      'modules/recurring-transactions/recurring-transactions.service.ts',
    ]) {
      expect(readFileSync(join(process.cwd(), 'src', file), 'utf8')).toMatch(/\$executeRaw`SELECT pg_advisory_xact_lock/);
    }
  });
});
