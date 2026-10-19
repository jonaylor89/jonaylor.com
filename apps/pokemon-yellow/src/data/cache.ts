/**
 * Cache for the bundle derived from the user's ROM. Stored in IndexedDB under
 * the clearly-named object store "derived-rom-data", alongside a notice.
 */
import { SCHEMA_VERSION, type GameBundle } from './schema';
import { idbDelete, idbGet, idbPut, STORES } from './db';

const KEY = 'bundle';

interface CachedBundle {
  label: 'Derived from the user-supplied Pokémon Yellow ROM. Do not redistribute.';
  schemaVersion: number;
  sourceSha1: string;
  bundle: GameBundle;
}

export async function loadCachedBundle(): Promise<GameBundle | undefined> {
  const c = await idbGet<CachedBundle>(STORES.bundle, KEY);
  if (!c || c.schemaVersion !== SCHEMA_VERSION || c.bundle?.meta?.schemaVersion !== SCHEMA_VERSION) return undefined;
  return c.bundle;
}

export async function storeBundle(bundle: GameBundle): Promise<void> {
  const entry: CachedBundle = {
    label: 'Derived from the user-supplied Pokémon Yellow ROM. Do not redistribute.',
    schemaVersion: SCHEMA_VERSION,
    sourceSha1: bundle.meta.sourceSha1,
    bundle,
  };
  await idbPut(STORES.bundle, KEY, entry);
}

export async function clearCachedBundle(): Promise<void> {
  await idbDelete(STORES.bundle, KEY);
}
