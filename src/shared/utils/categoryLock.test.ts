import { describe, expect, it, vi } from 'vitest';
import { lockCustomCategory } from './categoryLock.js';

const ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const txWith = (rows: unknown[]) => {
  const queryRaw = vi.fn(async (strings: TemplateStringsArray) => {
    expect(strings.join('?')).toContain('FOR SHARE');
    return rows;
  });
  return { tx: { $queryRaw: queryRaw } as never, queryRaw };
};

describe('lockCustomCategory', () => {
  it('lets system names and empty values through without a query', async () => {
    const { tx, queryRaw } = txWith([]);
    expect(await lockCustomCategory(tx, 'h', 'FOOD')).toBeNull();
    expect(await lockCustomCategory(tx, 'h', null)).toBeNull();
    expect(queryRaw).not.toHaveBeenCalled();
  });
  it('share-locks the row and returns its type', async () => {
    const { tx, queryRaw } = txWith([{ id: ID, type: 'INCOME' }]);
    expect(await lockCustomCategory(tx, 'h', `CUSTOM:${ID}`)).toBe('INCOME');
    expect(queryRaw).toHaveBeenCalledTimes(1);
  });
  it('refuses with 400 a category that is gone (merged/deleted) or not a uuid', async () => {
    await expect(lockCustomCategory(txWith([]).tx, 'h', `CUSTOM:${ID}`)).rejects.toMatchObject({ statusCode: 400 });
    const { tx, queryRaw } = txWith([]);
    await expect(lockCustomCategory(tx, 'h', 'CUSTOM:not-a-uuid')).rejects.toMatchObject({ statusCode: 400 });
    expect(queryRaw).not.toHaveBeenCalled();
  });
});
