/** Full Better Auth + real local workerd/D1, with verification/reset delivery through local inbox. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startLocalBackend } from '../tools/localBackend';
import { serializeSave } from '../src/game/save';
import { newGameState } from '../src/game/state';
import type { GameBundle } from '../src/data/schema';

let backend: Awaited<ReturnType<typeof startLocalBackend>>;
const password = 'Local-integration-password-123';
type Login = { id: string; cookie: string };
let alice: Login; let bob: Login;
const payload = serializeSave(newGameState({ toggleableObjects: [] } as unknown as GameBundle));
const save = (revision: number) => ({ expectedRevision: revision, requestId: crypto.randomUUID(), device: 'real worker test', payload });
async function api(path: string, body?: unknown, login?: Login, overrides: Record<string, string> = {}) {
  return fetch(backend.baseURL + path, {
    method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
    headers: { Origin: backend.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(login ? { Cookie: login.cookie, 'X-Game-Account': login.id } : {}), ...overrides },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(15_000),
  });
}
async function mail(email: string, subject: string) {
  for (let i = 0; i < 50; i++) {
    const rows = await (await api('/__dev/mail.json')).json() as { recipient: string; subject: string; url: string }[];
    const row = rows.find(row => row.recipient === email && row.subject.includes(subject));
    if (row) return row.url;
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('Email was not delivered');
}
async function register(email: string): Promise<Login> {
  const registration = await api('/api/auth/sign-up/email', { name: email.split('@')[0], email, password, callbackURL: backend.origin + '/' });
  expect(registration.status).toBe(200);
  const unverified = await api('/api/auth/sign-in/email', { email, password });
  expect(unverified.status).toBe(403);
  const link = await mail(email, 'Verify');
  expect((await fetch(link, { redirect: 'manual', signal: AbortSignal.timeout(10_000) })).status).toBe(302);
  const response = await api('/api/auth/sign-in/email', { email, password });
  expect(response.status).toBe(200);
  const data = await response.json() as { user: { id: string } };
  const cookies = response.headers.getSetCookie();
  expect(cookies.some(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax'))).toBe(true);
  return { id: data.user.id, cookie: cookies.map(cookie => cookie.split(';')[0]).join('; ') };
}
describe.sequential('real Worker authentication and saves', () => {
  beforeAll(async () => {
    backend = await startLocalBackend();
    alice = await register('alice@example.test'); bob = await register('bob@example.test');
  }, 90_000);
  afterAll(async () => { await backend?.close(); });
  it('requires verified email for sessions and issues HttpOnly session cookies', async () => {
    expect(alice.id).not.toBe(bob.id);
  });
  it('blocks unauthenticated, cross-origin and stale-account requests', async () => {
    expect((await api('/api/save')).status).toBe(401);
    expect((await api('/api/save', save(0), alice, { Origin: 'https://attacker.invalid' })).status).toBe(403);
    expect((await api('/api/save', save(0), alice, { 'X-Game-Account': bob.id })).status).toBe(409);
    expect((await api('/api/auth/sign-in/email', { email: 'alice@example.test', password }, undefined, { Origin: 'https://attacker.invalid' })).status).toBe(403);
  });
  it('isolates saves by the server session, not submitted owner IDs', async () => {
    const response = await api('/api/save', { ...save(0), owner: bob.id }, alice);
    expect(response.status).toBe(200);
    expect((await response.json()).snapshot.revision).toBe(1);
    expect((await (await api('/api/save', undefined, bob)).json()).revision).toBe(0);
    expect(await (await api('/api/save/history', undefined, bob)).json()).toEqual([]);
  });
  it('handles genuinely concurrent saves and retries through the D1 trigger transaction', async () => {
    const first = save(1); const second = save(1);
    const responses = await Promise.all([api('/api/save', first, alice), api('/api/save', second, alice)]);
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results.map(result => result.status).sort()).toEqual(['conflict', 'saved']);
    const winner = results[0].status === 'saved' ? first : second;
    const receipt = await (await api('/api/save', winner, alice)).json();
    expect(receipt.status).toBe('saved'); expect(receipt.snapshot.revision).toBe(2);
    const invalidReuse = await api('/api/save', { ...winner, payload: null }, alice);
    expect(invalidReuse.status).toBe(409);
  });
  it('rejects malformed/oversized state and writes revisioned deletion tombstones', async () => {
    expect((await api('/api/save', { ...save(2), payload: '{}' }, alice)).status).toBe(400);
    expect((await api('/api/save', { ...save(2), payload: 'x'.repeat(1048577) }, alice)).status).toBe(400);
    const result = await (await api('/api/save', { ...save(2), payload: null }, alice)).json();
    expect(result.snapshot).toMatchObject({ revision: 3, payload: null });
    expect((await (await api('/api/save', save(2), alice)).json()).status).toBe('conflict');
  });
  it('resets passwords via local email, revokes old sessions and refuses token replay', async () => {
    const requested = await api('/api/auth/request-password-reset', { email: 'alice@example.test', redirectTo: backend.origin + '/?account=recovery' });
    expect(requested.status).toBe(200);
    const redirect = await fetch(await mail('alice@example.test', 'Reset'), { redirect: 'manual' });
    expect(redirect.status).toBe(302);
    const token = new URL(redirect.headers.get('location')!, backend.origin).searchParams.get('token');
    expect(token).toBeTruthy();
    const newPassword = 'Different-integration-password-456';
    expect((await api('/api/auth/reset-password', { token, newPassword })).status).toBe(200);
    expect((await api('/api/save', undefined, alice)).status).toBe(401);
    expect((await api('/api/auth/reset-password', { token, newPassword })).status).not.toBe(200);
    expect((await api('/api/auth/sign-in/email', { email: 'alice@example.test', password })).status).not.toBe(200);
    expect((await api('/api/auth/sign-in/email', { email: 'alice@example.test', password: newPassword })).status).toBe(200);
  });
  it('invalidates a signed-out session on the server', async () => {
    expect((await api('/api/auth/sign-out', {}, bob)).status).toBe(200);
    expect((await api('/api/save', undefined, bob)).status).toBe(401);
  });
  it('does not expose the development inbox without the localhost guard', async () => {
    const response = await api('/__dev/mail.json');
    expect(response.headers.get('cache-control')).toBe('no-store');
    // Host is part of the guard; server production-misconfiguration behavior is unit-tested separately.
    const imported = await import('../worker/index');
    const result = await imported.handleRequest(new Request('https://game.example/__dev/mail.json'), {
      APP_ORIGIN: 'https://game.example', LOCAL_DEV: 'true',
    } as never, { waitUntil() {} });
    expect(result.status).toBe(404);
  });
});
