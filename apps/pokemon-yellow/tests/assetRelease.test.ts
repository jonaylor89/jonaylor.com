import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkPreparedAssets, fetchReleasedAssets } from '../tools/fetch-assets';
import { SCHEMA_VERSION } from '../src/data/schema';

const directories: string[] = [];
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const out = mkdtempSync(join(tmpdir(), 'pokemon-assets-')); directories.push(out);
  const notice = Buffer.from('Operator distribution notice.\n');
  const bundle = Buffer.from(JSON.stringify({ meta: { schemaVersion: SCHEMA_VERSION, notice: notice.toString().trim() }, maps: {}, ui: {}, audio: {} }));
  const filename = `bundle-${hash(bundle)}.json`;
  const manifest = Buffer.from(JSON.stringify({ format: 'pokeyellow-web-assets', release: 'fixture', schemaVersion: SCHEMA_VERSION, bundle: { url: filename, sha256: hash(bundle), bytes: bundle.length } }));
  const pin = { baseUrl: 'https://github.com/jonaylor89/jonaylor.com/releases/download/pokemon-yellow-data-test/', manifestSha256: hash(manifest), noticeSha256: hash(notice) };
  const files = new Map<string, Uint8Array>([['manifest.json', manifest], ['NOTICE.txt', notice], [filename, bundle]]);
  const fetcher = vi.fn(async (input: string | URL | Request) => {
    const file = files.get(new URL(String(input)).pathname.split('/').at(-1)!);
    return file ? new Response(new Uint8Array(file)) : new Response(null, { status: 404 });
  });
  return { out, notice, bundle, filename, manifest, pin, files, fetcher };
}
describe('CI asset release provisioning', () => {
  it('downloads and verifies the pinned release without a ROM or credential', async () => {
    const f = fixture();
    const manifest = await fetchReleasedAssets(f.pin, f.out, f.fetcher);
    expect(manifest.schemaVersion).toBe(SCHEMA_VERSION);
    expect(readFileSync(join(f.out, f.filename))).toEqual(f.bundle);
    expect(await checkPreparedAssets(f.pin, f.out)).toEqual(manifest);
    expect(f.fetcher).toHaveBeenCalledTimes(3);
  });
  it('rejects a changed manifest before following its bundle URL', async () => {
    const f = fixture(); f.files.set('manifest.json', Buffer.from('{}'));
    await expect(fetchReleasedAssets(f.pin, f.out, f.fetcher)).rejects.toThrow('integrity');
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    expect(existsSync(join(f.out, 'manifest.json'))).toBe(false);
  });
  it('does not replace an existing release when the download is corrupt', async () => {
    const f = fixture(); await fetchReleasedAssets(f.pin, f.out, f.fetcher);
    const damaged = new Uint8Array(f.bundle); damaged[10] ^= 1; f.files.set(f.filename, damaged);
    await expect(fetchReleasedAssets(f.pin, f.out, f.fetcher)).rejects.toThrow('integrity');
    expect(readFileSync(join(f.out, f.filename))).toEqual(f.bundle);
  });
  it('bounds downloaded bytes even without a Content-Length header', async () => {
    const f = fixture(); f.files.set(f.filename, Buffer.concat([f.bundle, Buffer.from('x')]));
    await expect(fetchReleasedAssets(f.pin, f.out, f.fetcher)).rejects.toThrow('size limit');
    expect(existsSync(join(f.out, 'manifest.json'))).toBe(false);
  });
  it('checks the separate notice and rejects missing artifacts', async () => {
    const f = fixture(); f.files.set('NOTICE.txt', Buffer.from('changed notice'));
    await expect(fetchReleasedAssets(f.pin, f.out, f.fetcher)).rejects.toThrow('integrity');
    f.files.delete('NOTICE.txt');
    await expect(fetchReleasedAssets(f.pin, f.out, f.fetcher)).rejects.toThrow('404');
  });
  it('rejects arbitrary release hosts and non-content-addressed bundle paths', async () => {
    const f = fixture();
    await expect(fetchReleasedAssets({ ...f.pin, baseUrl: 'http://localhost/' }, f.out, f.fetcher)).rejects.toThrow('release URL');
    expect(f.fetcher).not.toHaveBeenCalled();
    const manifest = JSON.parse(f.manifest.toString()); manifest.bundle.url = 'https://unrelated.test/bundle.json';
    const bytes = Buffer.from(JSON.stringify(manifest)); f.files.set('manifest.json', bytes);
    await expect(fetchReleasedAssets({ ...f.pin, manifestSha256: hash(bytes) }, f.out, f.fetcher)).rejects.toThrow('content-addressed');
  });
});
