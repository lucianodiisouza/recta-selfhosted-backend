import { beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({ state: { local: false }, get isLocalAuth() { return this.state.local; } }));
const db = vi.hoisted(() => ({ findUnique: vi.fn(), update: vi.fn(), create: vi.fn() }));

vi.mock('../config/env.js', () => config);
vi.mock('../db/prisma.js', () => ({ prisma: { user: { findUnique: db.findUnique, update: db.update, create: db.create } } }));
vi.mock('../../modules/households/households.service.js', () => ({}));

const { getUserByFirebaseUid } = await import('./authorization.middleware.js');

const OMIT_HASH = expect.objectContaining({ omit: { passwordHash: true } });

beforeEach(() => {
  vi.clearAllMocks();
  db.findUnique.mockResolvedValue({ id: 'user-1' });
  db.create.mockResolvedValue({ id: 'user-1' });
  db.update.mockResolvedValue({ id: 'user-1' });
});

// Every row this helper returns goes into route handlers and, from some of them, into responses.
describe('getUserByFirebaseUid never reads the password hash', () => {
  it('in local mode', async () => {
    config.state.local = true;

    await getUserByFirebaseUid('6f1c1f0e-8a49-4c53-9c06-3f0a1d1c2b11', 'ana@example.com');

    expect(db.findUnique).toHaveBeenCalledWith(OMIT_HASH);
  });

  it('in Firebase mode: lookup by UID', async () => {
    config.state.local = false;

    await getUserByFirebaseUid('firebase-uid-1', 'ana@example.com');

    expect(db.findUnique).toHaveBeenCalledWith(OMIT_HASH);
  });

  it('in Firebase mode: first sign-in creates the user', async () => {
    config.state.local = false;
    db.findUnique.mockResolvedValue(null);

    await getUserByFirebaseUid('firebase-uid-1', 'ana@example.com');

    expect(db.create).toHaveBeenCalledWith(OMIT_HASH);
  });

  it('in Firebase mode: an existing email gets the new UID', async () => {
    config.state.local = false;
    db.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'user-1' });

    await getUserByFirebaseUid('firebase-uid-1', 'ana@example.com');

    expect(db.update).toHaveBeenCalledWith(OMIT_HASH);
  });
});
