import { AccountType } from '../../shared/enums/index.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ create: vi.fn() }));

vi.mock('../../shared/db/prisma.js', () => ({ prisma: { account: { create: db.create, findUnique: vi.fn(), findFirst: vi.fn() } } }));

const { createAccount } = await import('./accounts.service.js');

const dec = (n: number) => ({ toNumber: () => n });
const BASE = { householdId: 'h1', name: 'Cartao', balance: 0, currency: 'BRL' } as const;

describe('createAccount closing day', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    db.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      balance: dec(0),
      totalBalance: dec(0),
      availableBalance: dec(0),
      allocatedBalance: dec(0),
      creditLimit: null,
    }));
  });

  const dataOfCall = () => db.create.mock.calls[0]![0].data as Record<string, unknown>;

  it('stores closing = due - 7 for a credit card created with only a due day', async () => {
    await createAccount({ ...BASE, type: AccountType.CREDIT, dueDay: 9 });
    expect(dataOfCall()).toMatchObject({ dueDay: 9, closingDay: 2 });
  });

  it('wraps into the previous month (due 3 -> 26)', async () => {
    await createAccount({ ...BASE, type: AccountType.CREDIT, dueDay: 3 });
    expect(dataOfCall().closingDay).toBe(26);
  });

  it('keeps an explicit closing day', async () => {
    await createAccount({ ...BASE, type: AccountType.CREDIT, dueDay: 9, closingDay: 20 });
    expect(dataOfCall().closingDay).toBe(20);
  });

  it('stores no closing day without a due day, and none for non-credit accounts', async () => {
    await createAccount({ ...BASE, type: AccountType.CREDIT });
    expect(dataOfCall()).not.toHaveProperty('closingDay');
    db.create.mockClear();
    await createAccount({ ...BASE, type: AccountType.CHECKING, dueDay: 9 });
    expect(dataOfCall()).not.toHaveProperty('closingDay');
  });

  it('accepts bestDayOffset for backwards compatibility but ignores it (no default of 7)', async () => {
    await createAccount({ ...BASE, type: AccountType.CREDIT, dueDay: 9, bestDayOffset: 5 });
    expect(dataOfCall()).not.toHaveProperty('bestDayOffset');
    db.create.mockClear();
    await createAccount({ ...BASE, type: AccountType.CREDIT, dueDay: 9 });
    expect(dataOfCall()).not.toHaveProperty('bestDayOffset');
  });
});
