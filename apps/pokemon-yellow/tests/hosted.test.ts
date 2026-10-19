import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHostedBundle, validateManifest, verifyBundle, type AssetManifest } from '../src/data/hosted';
import { SCHEMA_VERSION } from '../src/data/schema';

async function fixture() {
  const bytes = new TextEncoder().encode(JSON.stringify({ meta: { schemaVersion: SCHEMA_VERSION }, maps: {}, ui: {}, audio: {} }));
  const hash = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  const manifest: AssetManifest = { format: 'pokeyellow-web-assets', release: 'test', schemaVersion: SCHEMA_VERSION, bundle: { url: 'bundle.json', sha256: hash, bytes: bytes.length } };
  return { bytes, manifest };
}
afterEach(() => vi.unstubAllGlobals());
describe('hosted game data', () => {
  it('checks release compatibility, size and SHA-256 before decoding', async () => {
    const { manifest, bytes } = await fixture();
    expect(validateManifest(manifest)).toEqual(manifest);
    expect((await verifyBundle(bytes, manifest)).meta.schemaVersion).toBe(SCHEMA_VERSION);
    await expect(verifyBundle(bytes.slice(1), manifest)).rejects.toThrow('incomplete');
    const bad = bytes.slice(); bad[10] ^= 1;
    await expect(verifyBundle(bad, manifest)).rejects.toThrow('integrity');
    expect(() => validateManifest({ ...manifest, schemaVersion: SCHEMA_VERSION - 1 })).toThrow('incompatible');
  });
  it('downloads automatically, caches verified data and opens offline without a ROM', async () => {
    const { manifest, bytes } = await fixture();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
      .mockResolvedValueOnce(new Response(bytes));
    vi.stubGlobal('fetch', fetch);
    const url = 'https://game.test/game-data/manifest.json';
    await loadHostedBundle(url, () => undefined);
    expect(fetch.mock.calls[1][0].href).toBe('https://game.test/game-data/bundle.json');
    fetch.mockRejectedValue(new Error('offline'));
    expect((await loadHostedBundle(url, () => undefined)).meta.schemaVersion).toBe(SCHEMA_VERSION);
  });
  it('does not cache damaged downloads or prompt for a player ROM', async () => {
    const { manifest, bytes } = await fixture();
    const fetch = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(manifest)))
      .mockResolvedValueOnce(new Response(bytes.slice(1)));
    vi.stubGlobal('fetch', fetch);
    const url = 'https://bad.test/manifest.json';
    await expect(loadHostedBundle(url, () => undefined)).rejects.toThrow('incomplete');
    fetch.mockRejectedValue(new Error('offline'));
    await expect(loadHostedBundle(url, () => undefined)).rejects.toThrow('offline');
  });
});
