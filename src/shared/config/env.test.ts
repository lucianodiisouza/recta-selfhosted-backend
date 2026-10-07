import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

// Auth settings: each case stubs the variables, re-imports the module and turns process.exit into a throw.
describe('auth settings', () => {
  const load = async (vars: Record<string, string | undefined>) => {
    vi.resetModules();
    for (const [key, value] of Object.entries(vars)) vi.stubEnv(key, value as string);
    return import('./env.js');
  };

  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit ${code}`);
    }) as never);
  });

  describe('AUTH_MODE', () => {
    it('defaults to firebase and needs no JWT secret', async () => {
      const { env, isLocalAuth } = await load({ AUTH_MODE: undefined, AUTH_JWT_SECRET: undefined });

      expect(env.AUTH_MODE).toBe('firebase');
      expect(isLocalAuth).toBe(false);
    });

    it('refuses to start in local mode without a JWT secret', async () => {
      await expect(load({ AUTH_MODE: 'local', AUTH_JWT_SECRET: undefined })).rejects.toThrow('exit 1');
    });

    it('refuses a JWT secret shorter than 32 characters', async () => {
      await expect(load({ AUTH_MODE: 'local', AUTH_JWT_SECRET: 'too-short' })).rejects.toThrow('exit 1');
    });

    it('starts in local mode with a 32+ character secret and a 30 day default lifetime', async () => {
      const { env, isLocalAuth } = await load({ AUTH_MODE: 'local', AUTH_JWT_SECRET: 'x'.repeat(32), AUTH_TOKEN_TTL_HOURS: undefined });

      expect(isLocalAuth).toBe(true);
      expect(env.AUTH_TOKEN_TTL_HOURS).toBe(720);
    });

    it('rejects an unknown mode', async () => {
      await expect(load({ AUTH_MODE: 'ldap' })).rejects.toThrow('exit 1');
    });
  });

  describe('AUTH_ALLOW_REGISTRATION', () => {
    it('is open by default and can be closed', async () => {
      expect((await load({ AUTH_ALLOW_REGISTRATION: undefined })).env.AUTH_ALLOW_REGISTRATION).toBe(true);
      expect((await load({ AUTH_ALLOW_REGISTRATION: 'false' })).env.AUTH_ALLOW_REGISTRATION).toBe(false);
    });

    it('rejects anything but true or false', async () => {
      await expect(load({ AUTH_ALLOW_REGISTRATION: 'no' })).rejects.toThrow('exit 1');
    });
  });

  describe('AUTH_TOKEN_TTL_HOURS', () => {
    it.each(['0', '-5', 'abc', '100000'])('rejects %s', async (hours) => {
      await expect(load({ AUTH_TOKEN_TTL_HOURS: hours })).rejects.toThrow('exit 1');
    });

    it('accepts a positive number of hours', async () => {
      expect((await load({ AUTH_TOKEN_TTL_HOURS: '24' })).env.AUTH_TOKEN_TTL_HOURS).toBe(24);
    });
  });
});
