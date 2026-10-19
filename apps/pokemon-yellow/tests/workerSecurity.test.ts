import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createAuth } from '../worker/auth';
import { handleRequest } from '../worker/index';
import type { Env } from '../worker/env';

const ctx = { waitUntil() {} };
function env(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as Env['DB'], APP_ORIGIN: 'https://game.example', BETTER_AUTH_SECRET: 'strong-example-secret-value-for-tests-only-0123456789',
    EMAIL_FROM: 'Game <game@example.test>', POSTMARK_SERVER_TOKEN: 'not-a-real-server-token', ...overrides,
  };
}
describe('Worker deployment boundaries', () => {
  it('keeps the production domain out of the local proxy and disables remote previews', () => {
    const config = JSON.parse(readFileSync(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
    expect(config.env.local.routes).toEqual([]);
    expect(Object.keys(config.env)).toEqual(['local']);
    expect(config.workers_dev).toBe(false);
    expect(config.preview_urls).toBe(false);
    expect(config.env.local.d1_databases[0].database_id).not.toBe(config.d1_databases[0].database_id);
    expect(config.vars.LOCAL_DEV).toBeUndefined();
  });
  it('enforces secure cookies and database-backed sessions/rate limits in production', () => {
    const auth = createAuth(new Request('https://game.example/api/auth/get-session'), env(), ctx);
    expect(auth.options.advanced?.useSecureCookies).toBe(true);
    expect(auth.options.session?.cookieCache.enabled).toBe(false);
    expect(auth.options.rateLimit?.storage).toBe('database');
  });
  it('rejects missing email delivery, weak/missing secrets and accidentally deployed local configuration', () => {
    const request = new Request('https://game.example/api/auth/get-session');
    for (const overrides of [
      { POSTMARK_SERVER_TOKEN: undefined }, { POSTMARK_SERVER_TOKEN: 'POSTMARK_API_TEST' }, { BETTER_AUTH_SECRET: '' },
      { BETTER_AUTH_SECRET: 'local-development-only-not-for-deployment-0123456789' }, { LOCAL_DEV: 'true' },
    ]) expect(() => createAuth(request, env(overrides), ctx)).toThrow('not configured');
  });
  it('returns a closed auth endpoint rather than falling back to unverified sessions', async () => {
    const result = await handleRequest(new Request('https://game.example/api/auth/get-session'), env({ BETTER_AUTH_SECRET: '' }), ctx);
    expect(result.status).toBe(503);
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it('never exposes the local mail inbox on a public hostname, even when misconfigured', async () => {
    const result = await handleRequest(new Request('https://game.example/__dev/mail.json'), env({ LOCAL_DEV: 'true' }), ctx);
    expect(result.status).toBe(404);
  });
});
