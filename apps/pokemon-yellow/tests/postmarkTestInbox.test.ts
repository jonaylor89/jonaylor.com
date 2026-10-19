import { afterEach, describe, expect, it, vi } from 'vitest';
import { postmarkTestLink } from '../tools/postmark-test-inbox';
const origin = 'https://pokemon-yellow.jonaylor.com';
const email = 'pokemon-qa-12345678-1234-1234-1234-123456789abc@blackhole.postmarkapp.com';
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });
describe('production QA mail privacy boundary', () => {
  it('filters the provider query to its exact synthetic recipient and returns only app auth links', async () => {
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'qa-placeholder-token');
    const link = origin + '/api/auth/verify-email?token=synthetic';
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ Messages: [{ Subject: 'Verify your Pokémon Yellow account', MessageID: 'qa-message' }] }))
      .mockResolvedValueOnce(Response.json({ To: [{ Email: email }], TextBody: 'Open ' + link }));
    vi.stubGlobal('fetch', fetcher);
    expect(await postmarkTestLink(email, 'Verify', origin)).toBe(link);
    const query = new URL(fetcher.mock.calls[0][0]);
    expect(query.searchParams.get('recipient')).toBe(email);
    expect(query.searchParams.get('messagestream')).toBe('outbound');
    expect(fetcher.mock.calls[1][0]).toBe('https://api.postmarkapp.com/messages/outbound/qa-message/details');
  });
  it('retries when search indexing precedes detail-record availability', async () => {
    vi.useFakeTimers(); vi.stubEnv('POSTMARK_SERVER_TOKEN', 'qa-placeholder-token');
    const link = origin + '/api/auth/verify-email?token=synthetic';
    const listed = () => Response.json({ Messages: [{ Subject: 'Verify account', MessageID: 'qa-message' }] });
    const fetcher = vi.fn().mockResolvedValueOnce(listed()).mockResolvedValueOnce(new Response(null, { status: 422 }))
      .mockResolvedValueOnce(listed()).mockResolvedValueOnce(Response.json({ To: [{ Email: email }], TextBody: link }));
    vi.stubGlobal('fetch', fetcher);
    const result = postmarkTestLink(email, 'Verify', origin);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await result).toBe(link);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('never queries messages for real recipients or an unrelated deployment', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    await expect(postmarkTestLink('me@jonaylor.com', 'Reset', origin)).rejects.toThrow('own blackhole');
    await expect(postmarkTestLink(email, 'Reset', 'https://other.example')).rejects.toThrow('own blackhole');
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('fails closed without a real provider credential', async () => {
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'POSTMARK_API_TEST');
    await expect(postmarkTestLink(email, 'Reset', origin)).rejects.toThrow('real Postmark token');
  });
  it('rejects a mismatched provider recipient without returning its auth link', async () => {
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'qa-placeholder-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ Messages: [{ Subject: 'Reset password', MessageID: 'qa-message' }] }))
      .mockResolvedValueOnce(Response.json({ To: [{ Email: 'other@example.test' }], TextBody: origin + '/api/auth/reset-password/synthetic' })));
    await expect(postmarkTestLink(email, 'Reset', origin)).rejects.toThrow('Unexpected QA message recipient');
  });
  it('reports provider failures without response bodies or credentials', async () => {
    vi.stubEnv('POSTMARK_SERVER_TOKEN', 'qa-placeholder-token');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('private provider diagnostic', { status: 403 })));
    await expect(postmarkTestLink(email, 'Verify', origin)).rejects.toThrow('Postmark QA inbox failed (403).');
  });
});
