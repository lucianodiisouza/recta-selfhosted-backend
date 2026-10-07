import { Pool } from 'pg';
import { env } from '../config/env.js';

/**
 * Cross-request mutual exclusion on a key, held by a database session (`pg_advisory_lock`), for work that spans
 * several connections of the main pool and so cannot be covered by one transaction's row lock.
 *
 * It uses its OWN small pool: a holder keeps its lock connection while the work inside takes connections from the main
 * pool, and a waiter keeps one while it waits. Sharing the main pool would let waiters starve the holders of the
 * connections they need, which is a deadlock.
 *
 * Callers must take this lock BEFORE any row lock the protected work also takes, and never the other way round.
 */
let lockPool: Pool | undefined;

/** How long a caller waits for a lock connection before failing, so a stuck holder cannot pile up requests forever. */
export const LOCK_CONNECT_TIMEOUT_MS = 10_000;
const LOCK_POOL_SIZE = 10;

function pool(): Pool {
  if (!lockPool) {
    lockPool = new Pool({ connectionString: env.DATABASE_URL, max: LOCK_POOL_SIZE, connectionTimeoutMillis: LOCK_CONNECT_TIMEOUT_MS });
    // An idle connection dropped by the server (restart, failover) must not crash the process: the pool replaces it
    lockPool.on('error', (error) => console.error('[advisory-lock] idle connection error:', error.message));
  }
  return lockPool;
}

/** Ends the lock pool (graceful shutdown, tests). A later lock request opens a new one. */
export async function closeAdvisoryLockPool(): Promise<void> {
  const closing = lockPool;
  lockPool = undefined;
  await closing?.end();
}

/**
 * Runs `work` while holding the lock for (`namespace`, `key`); the lock is released when it settles. If the lock
 * connection is lost while the work runs, the lock is gone with it (the server releases a session's locks): the work is
 * not interrupted, and the connection is discarded instead of going back to the pool.
 */
export async function withAdvisoryLock<T>(namespace: number, key: string, work: () => Promise<T>): Promise<T> {
  const client = await pool().connect();
  let discard = false;
  // A checked-out connection that errors (server restart, terminated session) emits 'error' on the client itself, and
  // with no listener that is an uncaught exception that kills the process
  const onError = (error: Error) => {
    discard = true;
    console.error('[advisory-lock] lock connection error:', error.message);
  };
  client.on('error', onError);
  try {
    try {
      await client.query('SELECT pg_advisory_lock($1::int4, hashtext($2))', [namespace, key]);
    } catch (error) {
      discard = true;
      throw error;
    }
    try {
      return await work();
    } finally {
      try {
        await client.query('SELECT pg_advisory_unlock($1::int4, hashtext($2))', [namespace, key]);
      } catch {
        // A session that cannot unlock is discarded: closing it releases the lock
        discard = true;
      }
    }
  } finally {
    client.removeListener('error', onError);
    client.release(discard);
  }
}
