import { afterEach, describe, expect, it, vi } from 'vitest';

// env.ts validates process.env at import time and calls process.exit(1) on
// failure, so every case re-imports it from a clean module registry.
const importEnv = () => import('./env.js');

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('env validation', () => {
  it('loads with the dummy DATABASE_URL that vitest.config.ts injects', async () => {
    const { env } = await importEnv();

    expect(env.DATABASE_URL).toMatch(/^postgres(ql)?:\/\//);
  });

  it('exits the process when DATABASE_URL is not a URL', async () => {
    vi.stubEnv('DATABASE_URL', 'not-a-url');
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);

    await expect(importEnv()).rejects.toThrow('process.exit called');
    expect(exit).toHaveBeenCalledWith(1);
  });
});
