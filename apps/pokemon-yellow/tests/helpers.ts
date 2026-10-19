import { existsSync, readFileSync } from 'node:fs';
import { extractBundle } from '../src/rom/extract';
import type { GameBundle } from '../src/data/schema';

/** Tests that need game data read the developer's own ROM (never committed). */
export const ROM_PATH = process.env.PYW_ROM ?? 'roms/pokeyellow.gbc';
export const HAS_ROM = existsSync(ROM_PATH);

let cached: Promise<GameBundle> | undefined;
export function bundle(): Promise<GameBundle> {
  cached ??= extractBundle(new Uint8Array(readFileSync(ROM_PATH))).then((r) => r.bundle);
  return cached;
}
