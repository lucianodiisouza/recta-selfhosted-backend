import { describe, expect, it } from 'vitest';
import { buildPaginationArgs, createPaginatedResponse, paginationSchema } from './pagination.js';

const rows = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `id-${i + 1}` }));

describe('createPaginatedResponse', () => {
  it('trims the extra probe row and points the cursor at the last returned item', () => {
    const page = createPaginatedResponse(rows(4), 3);

    expect(page.data.map((r) => r.id)).toEqual(['id-1', 'id-2', 'id-3']);
    expect(page.pagination).toEqual({ nextCursor: 'id-3', hasMore: true });
  });

  it('reports no next page when the query returned at most `limit` rows', () => {
    const page = createPaginatedResponse(rows(3), 3);

    expect(page.data).toHaveLength(3);
    expect(page.pagination).toEqual({ nextCursor: null, hasMore: false });
  });

  it('only includes `total` when it is provided (0 counts as provided)', () => {
    expect(createPaginatedResponse(rows(1), 3).pagination).not.toHaveProperty('total');
    expect(createPaginatedResponse([], 3, 0).pagination.total).toBe(0);
  });
});

describe('buildPaginationArgs', () => {
  it('takes one extra row so the caller can detect another page', () => {
    expect(buildPaginationArgs({ limit: 20 })).toEqual({ take: 21 });
  });

  it('skips the cursor row itself when a cursor is given', () => {
    const cursor = '3f2b8c1e-7d4a-4c55-9a1e-0b6f2d8e4a10';

    expect(buildPaginationArgs({ limit: 5, cursor })).toEqual({
      take: 6,
      skip: 1,
      cursor: { id: cursor },
    });
  });
});

describe('paginationSchema', () => {
  it('defaults the limit and coerces numeric strings from the query string', () => {
    expect(paginationSchema.parse({}).limit).toBe(20);
    expect(paginationSchema.parse({ limit: '50' }).limit).toBe(50);
  });

  it('rejects limits outside 1..100', () => {
    expect(paginationSchema.safeParse({ limit: '0' }).success).toBe(false);
    expect(paginationSchema.safeParse({ limit: '101' }).success).toBe(false);
  });
});
