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

/**
 * Optional color filters applied on top of the authentic palette. The fixed
 * ones replace every palette with one 4-shade ramp; the graded ones keep each
 * SGB palette's hues but move past the hardware's washed-out 15-bit range.
 * Shade order (0 lightest → 3 darkest) is preserved so fades and text work.
 */
export const COLOR_FILTERS = [
  { id: 'gbc', label: 'ORIGINAL SGB / GBC' },
  { id: 'vivid', label: 'VIVID' },
  { id: 'pastel', label: 'PASTEL' },
  { id: 'dusk', label: 'GOLDEN DUSK' },
  { id: 'night', label: 'MOONLIT NIGHT' },
  { id: 'sepia', label: 'SEPIA' },
  { id: 'dmg', label: 'DMG GREEN' },
  { id: 'pocket', label: 'POCKET GRAYSCALE' },
  { id: 'high-contrast', label: 'HIGH CONTRAST' },
] as const;
export type ColorFilter = (typeof COLOR_FILTERS)[number]['id'];
export function isColorFilter(value: unknown): value is ColorFilter {
  return COLOR_FILTERS.some((f) => f.id === value);
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const byte = (v: number) => Math.round(Math.max(0, Math.min(255, v)));
function mix(a: RGB, b: RGB, t: number): RGB {
  return [byte(a[0] + (b[0] - a[0]) * t), byte(a[1] + (b[1] - a[1]) * t), byte(a[2] + (b[2] - a[2]) * t)];
}
function luma([r, g, b]: RGB): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}
function toHsl([r, g, b]: RGB): [number, number, number] {
  const [R, G, B] = [r / 255, g / 255, b / 255];
  const max = Math.max(R, G, B), min = Math.min(R, G, B), l = (max + min) / 2, d = max - min;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h * 60, s, l];
}
function fromHsl(h: number, s: number, l: number): RGB {
  const C = (1 - Math.abs(2 * l - 1)) * s, X = C * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - C / 2;
  const [r, g, b] = h < 60 ? [C, X, 0] : h < 120 ? [X, C, 0] : h < 180 ? [0, C, X] : h < 240 ? [0, X, C] : h < 300 ? [X, 0, C] : [C, 0, X];
  return [byte((r + m) * 255), byte((g + m) * 255), byte((b + m) * 255)];
}
/** Scale saturation and push lightness away from (or toward) mid-gray. */
function grade(rgb: RGB, saturation: number, contrast = 1, lift = 0): RGB {
  const [h, s, l] = toHsl(rgb);
  return fromHsl(h, clamp01(s * saturation), clamp01((l - 0.5) * contrast + 0.5 + lift));
}
function retone(rgb: RGB, saturation: (s: number) => number, lightness: (l: number) => number): RGB {
  const [h, s, l] = toHsl(rgb);
  return fromHsl(h, clamp01(saturation(s)), clamp01(lightness(l)));
}
/** Split toning: highlights lean toward `light`, shadows toward `dark`. */
function tone(rgb: RGB, light: RGB, dark: RGB, amount: number): RGB {
  const y = luma(rgb);
  return mix(mix(rgb, dark, amount * (1 - y)), light, amount * y * 0.6);
}

function fixedRamp(filter: 'dmg' | 'pocket' | 'high-contrast'): RGB[] {
  switch (filter) {
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

export function applyFilter(colors: RGB[], filter: ColorFilter): RGB[] {
  const [c0, c1, c2] = colors;
  switch (filter) {
    case 'gbc':
      return colors;
    case 'dmg':
    case 'pocket':
    case 'high-contrast':
      return fixedRamp(filter);
    case 'vivid': {
      // Deeper, saturated mids (most SGB mids are pale), and shadows tinted by
      // the palette instead of flat black. Grays stay gray.
      const mid1 = retone(c1, (s) => (s > 0.08 ? Math.max(s * 1.25, 0.6) : s), (l) => Math.min(l, 0.72));
      const mid2 = retone(c2, (s) => (s > 0.08 ? Math.max(s * 1.2, 0.55) : s), (l) => Math.min(l, 0.48));
      return [mix([255, 255, 255], mid1, 0.1), mid1, mid2, mix([10, 10, 18], mid2, 0.22)];
    }
    case 'pastel': {
      // Ease every palette toward the same soft lightness band.
      const mid1 = retone(c1, (s) => Math.min(s, 0.6), (l) => l + (0.78 - l) * 0.7);
      const mid2 = retone(c2, (s) => Math.min(s, 0.5), (l) => l + (0.6 - l) * 0.7);
      return [mix([255, 253, 248], mid1, 0.15), mid1, mid2, mix([46, 40, 60], mid2, 0.2)];
    }
    case 'dusk':
      return colors.map((c, i) => tone(grade(c, 1.2), [255, 178, 120], [58, 24, 74], i === 0 ? 0.32 : 0.45));
    case 'night':
      return colors.map((c, i) => {
        const cool = tone(grade(c, 0.7, 1, -0.06), [176, 200, 255], [8, 14, 44], 0.55);
        return i === 0 ? mix(cool, [214, 226, 255], 0.35) : cool;
      });
    case 'sepia':
      return colors.map((c) => {
        const y = luma(c);
        return mix(mix([40, 24, 12], [176, 128, 82], clamp01(y * 1.6)), [252, 240, 216], clamp01(y * 1.6 - 0.6));
      });
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
