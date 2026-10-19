/** Texture pack registry: every module in ./packs is a pack (default export). */
import type { TexturePack } from './types';

export const ORIGINAL_LOOK = 'original';

const modules = import.meta.glob<{ default: TexturePack }>('./packs/*.ts', { eager: true });
export const TEXTURE_PACKS: readonly TexturePack[] = Object.values(modules)
  .map((m) => m.default)
  .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

/** Menu entries: the original look first, then the packs. */
export const WORLD_LOOKS: readonly { id: string; label: string; description: string }[] = [
  { id: ORIGINAL_LOOK, label: 'ORIGINAL GB', description: 'The ROM tiles and SGB palettes, as the game drew them.' },
  ...TEXTURE_PACKS.map(({ id, label, description }) => ({ id, label, description })),
];

export function texturePack(id: string | undefined): TexturePack | undefined {
  return TEXTURE_PACKS.find((p) => p.id === id);
}

export function isWorldLook(value: unknown): value is string {
  return typeof value === 'string' && WORLD_LOOKS.some((l) => l.id === value);
}
