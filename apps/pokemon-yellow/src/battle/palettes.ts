/** SetPal_Battle / GetHealthBarColor (engine/gfx/palettes.asm,
 * home/palettes.asm). BlkPacket_Battle applies these rectangles in order.
 */
import type { GameBundle } from '../data/schema';
import { c } from '../rom/constants';

export const BATTLE_PALETTE_BLOCKS = [
  { pal: 2, x0: 0, y0: 12, x1: 19, y1: 17 },
  { pal: 1, x0: 1, y0: 0, x1: 10, y1: 3 },
  { pal: 0, x0: 10, y0: 7, x1: 19, y1: 10 },
  { pal: 2, x0: 0, y0: 4, x1: 8, y1: 11 },
  { pal: 3, x0: 11, y0: 0, x1: 19, y1: 6 },
];
export function healthBarColor(pixels: number): number { return pixels >= 27 ? 0 : pixels >= 10 ? 1 : 2; }
export function monsterPalette(bundle: GameBundle, species: number): number {
  // DeterminePaletteID converts the internal species index to dex order.
  return bundle.palettes.monsterPalettes[bundle.dexOrder[species] ?? 0];
}
export function battlePaletteIds(bundle: GameBundle, playerSpecies: number, enemySpecies: number, playerColor: number, enemyColor: number): number[] {
  return [c('palette', 'PAL_GREENBAR') + playerColor, c('palette', 'PAL_GREENBAR') + enemyColor, monsterPalette(bundle, playerSpecies), monsterPalette(bundle, enemySpecies)];
}
