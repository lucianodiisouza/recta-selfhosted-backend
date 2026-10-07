import { defineConfig } from 'vitest/config';

// Unit tests never touch the database. Importing any service pulls in
// shared/db/prisma.ts -> shared/config/env.ts, whose validateEnv() calls
// process.exit(1) when DATABASE_URL is missing, so give it a dummy URL
// unless the shell already provides one. src/shared/config/env.test.ts covers
// that validation. IMPORT_DB_TEST_URL points the opt-in database test
// (import.integration.test.ts) at a scratch database; it wins so the app's own URL is never used by accident.
// The server runs with TZ=America/Sao_Paulo (src/index.ts); the tests use the same zone so that
// day-shifting bugs show up on a machine whose own zone happens to be UTC.
export default defineConfig({
  test: {
    // Fixes the time zone to one behind UTC, see src/test/global-setup.ts.
    globalSetup: ['./src/test/global-setup.ts'],
    env: {
      DATABASE_URL:
        process.env.IMPORT_DB_TEST_URL ??
        process.env.DATABASE_URL ??
        'postgresql://vitest:vitest@localhost:5432/vitest',
      TZ: 'America/Sao_Paulo',
    },
  },
});
