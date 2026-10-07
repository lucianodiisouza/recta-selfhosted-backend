import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  userFindFirst: vi.fn(),
  userFindUnique: vi.fn(),
  memberFindUnique: vi.fn(),
  memberCount: vi.fn(),
  inviteFindFirst: vi.fn(),
  inviteCreate: vi.fn(),
  householdFindUnique: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    user: { findFirst: db.userFindFirst, findUnique: db.userFindUnique },
    householdMember: { findUnique: db.memberFindUnique, count: db.memberCount },
    householdInvite: { findFirst: db.inviteFindFirst, create: db.inviteCreate },
    household: { findUnique: db.householdFindUnique },
    notification: { create: vi.fn().mockResolvedValue({}) },
  },
}));

const { inviteMember } = await import('./households.service.js');

beforeEach(() => {
  vi.clearAllMocks();
  db.userFindFirst.mockResolvedValue(null);
  db.memberFindUnique.mockResolvedValue(null);
  db.memberCount.mockResolvedValue(1);
  db.inviteFindFirst.mockResolvedValue(null);
  db.householdFindUnique.mockResolvedValue({ id: 'hh-1', name: 'Home' });
  db.userFindUnique.mockResolvedValue({ id: 'inviter-1', email: 'ana@example.com', displayName: null });
  db.inviteCreate.mockImplementation(async ({ data }) => ({ id: 'inv-1', ...data }));
});

describe('inviteMember', () => {
  it('finds the invitee whatever the capitals of the typed email', async () => {
    db.userFindFirst.mockResolvedValue({ id: 'user-2', email: 'Carol@Example.com' });

    await inviteMember('hh-1', 'inviter-1', { email: 'carol@example.com', role: 'EDITOR' } as never);

    expect(db.userFindFirst).toHaveBeenCalledWith({ where: { email: { equals: 'carol@example.com', mode: 'insensitive' } } });
    expect(db.inviteCreate.mock.calls[0][0].data).toMatchObject({ inviteeId: 'user-2', email: 'Carol@Example.com' });
  });

  it('checks the pending invite with the stored email, not the typed one', async () => {
    db.userFindFirst.mockResolvedValue({ id: 'user-2', email: 'Carol@Example.com' });

    await inviteMember('hh-1', 'inviter-1', { email: 'CAROL@example.com', role: 'EDITOR' } as never);

    expect(db.inviteFindFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ email: 'Carol@Example.com' }) }));
  });

  it('still answers 404 for an unknown email', async () => {
    await expect(inviteMember('hh-1', 'inviter-1', { email: 'nobody@example.com', role: 'EDITOR' } as never)).rejects.toMatchObject({ statusCode: 404 });
  });
});
