/**
 * Palettes. The overworld palette selection is a port of SetPal_Overworld
 * (engine/gfx/palettes.asm); colors come from the ROM's SuperPalettes.
 */
import type { GameBundle } from '../data/schema';
import { c } from '../rom/constants';

export type RGB = [number, number, number];

/** GB 5-bit color -> 8-bit, with the usual (v << 3 | v >> 2) expansion. */
export function to8bit([r, g, b]: [number, number, number]): RGB {
  const e = (v: number) => (v << 3) | (v >> 2);
  return [e(r), e(g), e(b)];
}

export function overworldPaletteId(mapId: number, tileset: number, lastMap: number): number {
  if (tileset === c('tileset', 'CEMETERY')) return c('palette', 'PAL_GRAYMON');
  if (tileset === c('tileset', 'CAVERN')) return c('palette', 'PAL_CAVE');
  let a = mapId;
  if (a >= c('map', 'FIRST_INDOOR_MAP')) {
    if (a >= c('map', 'CERULEAN_CAVE_2F') && a <= c('map', 'CERULEAN_CAVE_1F')) return c('palette', 'PAL_CAVE');
    if (a === c('map', 'LORELEIS_ROOM')) return c('palette', 'PAL_PALLET'); // .Lorelei: xor a, then +1
    if (a === c('map', 'BRUNOS_ROOM')) return c('palette', 'PAL_CAVE');
    if (a === c('map', 'TRADE_CENTER') || a === c('map', 'COLOSSEUM')) return c('palette', 'PAL_GRAYMON');
    a = lastMap;
  }
  if (a < c('map', 'NUM_CITY_MAPS')) return a + 1; // a town's palette id is its map id + 1
  return c('palette', 'PAL_ROUTE');
}

export function paletteColors(bundle: GameBundle, palId: number): RGB[] {
  const p = bundle.palettes.superPalettes[palId];
  if (!p) throw new Error(`palette ${palId} missing`);
  return p.map(to8bit);
}

/** Optional accessibility/color filters applied on top of the authentic palette. */
export type ColorFilter = 'gbc' | 'dmg' | 'pocket' | 'high-contrast';

export function applyFilter(colors: RGB[], filter: ColorFilter): RGB[] {
  switch (filter) {
    case 'gbc':
      return colors;
    case 'dmg':
      return [
        [224, 248, 208],
        [136, 192, 112],
        [52, 104, 86],
        [8, 24, 32],
      ];
    case 'pocket':
      return [
        [255, 255, 255],
        [169, 169, 169],
        [84, 84, 84],
        [0, 0, 0],
      ];
    case 'high-contrast':
      return [
        [255, 255, 255],
        [200, 200, 200],
        [90, 90, 90],
        [0, 0, 0],
      ];
  }
}

/**
 * FadePal1-8 (home/fade.asm) rBGP as shade per color index 0-3. LoadGBPal picks
 * FadePal4 - wMapPalOffset / 3 bytes: dark caves (offset 6) use FadePal2.
 */
export const FADE_PALS_BGP: number[][] = [
  [3, 3, 3, 3],
  [2, 3, 3, 3],
  [1, 2, 3, 3],
  [0, 1, 2, 3],
  [0, 1, 2, 3],
  [0, 0, 1, 2],
  [0, 0, 0, 1],
  [0, 0, 0, 0],
];

/** FadePal1-8 rOBP0 as shade per color index (color 0 is transparent). */
export const FADE_PALS_OBP0: number[][] = [
  [3, 3, 3, 3],
  [2, 3, 3, 3],
  [0, 1, 2, 3],
  [0, 0, 1, 3],
  [0, 0, 1, 3],
  [0, 0, 0, 2],
  [0, 0, 0, 1],
  [0, 0, 0, 0],
];

/** LoadGBPal's palette for wMapPalOffset (0 = normal). */
export function mapPalOffsetRemap(offset: number): number[] {
  return FADE_PALS_BGP[3 - Math.floor(offset / 3)] ?? FADE_PALS_BGP[3];
}

/** LoadGBPal: FadePal4 - wMapPalOffset / 3 (a 1-based FadePal number) */
export function loadGBPalIndex(offset: number): number {
  return Math.max(1, 4 - Math.floor(offset / 3));
}

/**
 * The FadePal of a fade level: toward black FadePal4 → 1 (GBFadeOutToBlack),
 * toward white FadePal6 → 8 (GBFadeOutToWhite); level 0 is `normal`.
 */
export function fadePalForLevel(level: number, color: 'black' | 'white', normal: number): number {
  const step = Math.round(Math.min(1, Math.max(0, level)) * 3);
  if (!step) return normal;
  return color === 'black' ? 4 - step : 5 + step;
}

export function remapColors(colors: RGB[], remap: number[]): RGB[] {
  return remap.map((shade) => colors[shade]);
}
