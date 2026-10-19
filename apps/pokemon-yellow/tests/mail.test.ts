import { afterEach, describe, expect, it, vi } from 'vitest';
import { queueMail } from '../worker/mail';
import type { Env } from '../worker/env';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });
const env = {
  APP_ORIGIN: 'https://pokemon-yellow.jonaylor.com', EMAIL_FROM: 'Game <verified@example.test>',
  POSTMARK_SERVER_TOKEN: 'test-server-credential',
} as Env;
async function send(overrides: Partial<Env> = {}) {
  let task!: Promise<unknown>;
  queueMail(new Request('https://pokemon-yellow.jonaylor.com/api/auth/sign-up/email'), { ...env, ...overrides },
    { waitUntil(promise) { task = promise; } }, 'player@example.test', 'Verify your account', 'https://pokemon-yellow.jonaylor.com/verify?token=sensitive');
  await task;
}
describe('Postmark transactional email', () => {
  it('uses the server-token header and transactional message stream', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ErrorCode: 0, MessageID: 'test-message' })));
    vi.stubGlobal('fetch', fetch);
    await send();
    expect(fetch.mock.calls[0][0]).toBe('https://api.postmarkapp.com/email');
    const init = fetch.mock.calls[0][1];
    expect(init.headers['X-Postmark-Server-Token']).toBe(env.POSTMARK_SERVER_TOKEN);
    expect(JSON.parse(init.body)).toMatchObject({ From: env.EMAIL_FROM, To: 'player@example.test', MessageStream: 'outbound' });
  });
  it('allows a configured Postmark stream', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ErrorCode: 0 })));
    vi.stubGlobal('fetch', fetch); await send({ POSTMARK_MESSAGE_STREAM: 'game-auth' });
    expect(JSON.parse(fetch.mock.calls[0][1].body).MessageStream).toBe('game-auth');
  });
  it.each([422, 500])('logs a generic delivery failure for HTTP %s without secrets or links', async status => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('provider error', { status })));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(); expect(log).toHaveBeenCalledWith('Authentication email delivery failed');
  });
  it('does not mistake a nonzero Postmark error code for successful delivery', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ ErrorCode: 406 }))));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await send(); expect(log).toHaveBeenCalledWith('Authentication email delivery failed');
  });
});
