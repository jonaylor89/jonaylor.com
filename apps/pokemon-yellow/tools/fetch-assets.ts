/** Provision the pinned public release; no ROM, credentials or extraction needed in CI. */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateManifest, verifyBundle, type AssetManifest } from '../src/data/hosted';

export interface ReleasePin {
  baseUrl: string;
  manifestSha256: string;
  noticeSha256: string;
}
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function checkHash(bytes: Uint8Array, expected: string) {
  if (!/^[a-f0-9]{64}$/.test(expected) || sha256(bytes) !== expected) throw new Error('Asset release integrity check failed.');
}
function checkManifest(bytes: Uint8Array, pin: ReleasePin) {
  checkHash(bytes, pin.manifestSha256);
  const manifest = validateManifest(JSON.parse(new TextDecoder().decode(bytes)));
  if (manifest.bundle.url !== `bundle-${manifest.bundle.sha256}.json`) throw new Error('Release bundle must use its content-addressed filename.');
  if (manifest.bundle.bytes > 25 * 1024 * 1024) throw new Error('Bundle exceeds the Cloudflare static-asset file limit.');
  return manifest;
}
async function checkData(bundleBytes: Uint8Array, noticeBytes: Uint8Array, manifest: AssetManifest, pin: ReleasePin) {
  checkHash(noticeBytes, pin.noticeSha256);
  const bundle = await verifyBundle(bundleBytes, manifest);
  const notice = new TextDecoder().decode(noticeBytes).trim();
  if (!notice || bundle.meta.notice !== notice) throw new Error('Bundle distribution notice does not match NOTICE.txt.');
}
async function download(url: URL, maximum: number, fetcher: typeof fetch): Promise<Uint8Array> {
  const response = await fetcher(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok || !response.body) throw new Error(`Asset download failed (${response.status}).`);
  if (Number(response.headers.get('content-length') ?? 0) > maximum) {
    await response.body.cancel();
    throw new Error('Asset download exceeds its size limit.');
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = []; let length = 0;
  for (;;) {
    const { value, done } = await reader.read(); if (done) break;
    length += value.byteLength;
    if (length > maximum) { await reader.cancel(); throw new Error('Asset download exceeds its size limit.'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}
export async function fetchReleasedAssets(pin: ReleasePin, out: string, fetcher: typeof fetch = fetch): Promise<AssetManifest> {
  // Only public release assets from this repository. No credentials are sent, including on redirects.
  if (!/^https:\/\/github\.com\/jonaylor89\/jonaylor\.com\/releases\/download\/[a-zA-Z0-9._-]+\/$/.test(pin.baseUrl)) {
    throw new Error('Invalid asset release URL.');
  }
  const manifestBytes = await download(new URL('manifest.json', pin.baseUrl), 64 * 1024, fetcher);
  const manifest = checkManifest(manifestBytes, pin);
  const [bundleBytes, noticeBytes] = await Promise.all([
    download(new URL(manifest.bundle.url, pin.baseUrl), manifest.bundle.bytes, fetcher),
    download(new URL('NOTICE.txt', pin.baseUrl), 64 * 1024, fetcher),
  ]);
  await checkData(bundleBytes, noticeBytes, manifest, pin);
  // Do not modify the previous release until every download has passed validation. Publish manifest last.
  mkdirSync(out, { recursive: true });
  writeFileSync(resolve(out, manifest.bundle.url), bundleBytes);
  writeFileSync(resolve(out, 'NOTICE.txt'), noticeBytes);
  writeFileSync(resolve(out, 'manifest.json'), manifestBytes);
  return manifest;
}
export async function checkPreparedAssets(pin: ReleasePin, out: string): Promise<AssetManifest> {
  const manifest = checkManifest(new Uint8Array(readFileSync(resolve(out, 'manifest.json'))), pin);
  await checkData(new Uint8Array(readFileSync(resolve(out, manifest.bundle.url))), new Uint8Array(readFileSync(resolve(out, 'NOTICE.txt'))), manifest, pin);
  return manifest;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pin = JSON.parse(readFileSync('assets.release.json', 'utf8')) as ReleasePin;
  const manifest = process.argv.includes('--check')
    ? await checkPreparedAssets(pin, resolve(process.argv.includes('--dist') ? 'dist/game-data' : 'public/game-data'))
    : await fetchReleasedAssets(pin, resolve('public/game-data'));
  console.log(`Verified game-data release ${manifest.release} (schema ${manifest.schemaVersion}, ${manifest.bundle.bytes} bytes).`);
}
