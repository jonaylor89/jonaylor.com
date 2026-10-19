import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerSaves } from '../src/cloud/client';

afterEach(() => vi.unstubAllGlobals());
describe('Worker save transport', () => {
  it('pins the expected account in every request and uses same-origin cookies', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ revision: 0, payload: null, device: '', updatedAt: '' })));
    vi.stubGlobal('fetch', fetch);
    await new WorkerSaves('alice').read();
    expect(fetch).toHaveBeenCalledWith('/api/save', expect.objectContaining({ credentials: 'same-origin', cache: 'no-store', headers: { 'X-Game-Account': 'alice' } }));
  });
  it('does not send an old account queue when the server reports a cookie/account mismatch', async () => {
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Account changed' }), { status: 409 })));
    await expect(new WorkerSaves('alice').write({ expectedRevision: 0, requestId: crypto.randomUUID(), payload: null, device: 'phone' })).rejects.toThrow('Account changed');
  });
  it('makes no network call offline', async () => {
    vi.stubGlobal('navigator', { onLine: false }); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    await expect(new WorkerSaves('alice').read()).rejects.toThrow('Offline'); expect(fetch).not.toHaveBeenCalled();
  });
});
