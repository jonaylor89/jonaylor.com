import { SCHEMA_VERSION, type GameBundle } from './schema';
import { idbGet, idbPut, STORES } from './db';

export interface AssetManifest {
  format: 'pokeyellow-web-assets';
  release: string;
  schemaVersion: number;
  bundle: { url: string; sha256: string; bytes: number };
}
export function validateManifest(value: unknown): AssetManifest {
  const m = value as AssetManifest | null;
  if (!m || m.format !== 'pokeyellow-web-assets' || typeof m.release !== 'string' || !m.release ||
      m.schemaVersion !== SCHEMA_VERSION || typeof m.bundle?.url !== 'string' ||
      !/^[a-f0-9]{64}$/.test(m.bundle.sha256) || !Number.isSafeInteger(m.bundle.bytes) ||
      m.bundle.bytes <= 0 || m.bundle.bytes > 64 * 1024 * 1024) {
    throw new Error('Game-data release is incompatible with this app. Reconnect and reload, or contact the host.');
  }
  return m;
}
export async function verifyBundle(bytes: Uint8Array, manifest: AssetManifest): Promise<GameBundle> {
  if (bytes.byteLength !== manifest.bundle.bytes) throw new Error('Game-data download is incomplete.');
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new Uint8Array(bytes))), n => n.toString(16).padStart(2, '0')).join('');
  if (hash !== manifest.bundle.sha256) throw new Error('Game-data integrity check failed. Please retry.');
  const bundle = JSON.parse(new TextDecoder().decode(bytes)) as GameBundle;
  if (bundle.meta?.schemaVersion !== SCHEMA_VERSION || !bundle.maps || !bundle.ui || !bundle.audio) {
    throw new Error('Game-data bundle is incompatible with this app.');
  }
  return bundle;
}
interface HostedCache { manifest: AssetManifest; bundle: GameBundle }
export async function loadHostedBundle(manifestUrl: string, progress: (message: string) => void): Promise<GameBundle> {
  const key = 'hosted:' + SCHEMA_VERSION + ':' + manifestUrl;
  const cached = await idbGet<HostedCache>(STORES.bundle, key).catch(() => undefined);
  let manifest: AssetManifest;
  try {
    progress('Checking game-data release…');
    const response = await fetch(manifestUrl, { cache: 'no-cache', signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error('The host has not published the game-data manifest (' + response.status + ').');
    manifest = validateManifest(await response.json());
  } catch (error) {
    if (cached?.manifest.schemaVersion === SCHEMA_VERSION && cached.bundle.meta?.schemaVersion === SCHEMA_VERSION) {
      progress('Using downloaded game data.');
      return cached.bundle;
    }
    throw error;
  }
  if (cached?.manifest.bundle.sha256 === manifest.bundle.sha256 && cached.bundle.meta?.schemaVersion === SCHEMA_VERSION) return cached.bundle;
  progress('Downloading game data for this device…');
  const bundleUrl = new URL(manifest.bundle.url, manifestUrl);
  if (!['http:', 'https:'].includes(bundleUrl.protocol)) throw new Error('Invalid game-data URL');
  const response = await fetch(bundleUrl, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error('Game-data download failed (' + response.status + ').');
  const bundle = await verifyBundle(new Uint8Array(await response.arrayBuffer()), manifest);
  progress('Keeping a copy for offline play…');
  // Fail visibly if we cannot keep a complete offline copy.
  await idbPut(STORES.bundle, key, { manifest, bundle } satisfies HostedCache);
  return bundle;
}
