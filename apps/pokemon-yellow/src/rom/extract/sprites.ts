/** Overworld sprite sheets and SGB palettes. */
import type { Rom } from '../Rom';
import { c, constEntries, toOffset } from '../symbols';
import { EXTRA_SHEETS, type OverworldSprite, type PaletteData } from '../../data/schema';
import { decode2bpp } from './util';

export function extractOverworldSprites(rom: Rom): OverworldSprite[] {
  const table = rom.sym('SpriteSheetPointerTable');
  const num = c('sprite', 'NUM_SPRITES');
  const firstStill = c('sprite', 'FIRST_STILL_SPRITE');
  const names = new Map<number, string>();
  for (const [k, v] of constEntries('sprite', 'SPRITE_')) if (!names.has(v) && !k.startsWith('SPRITE_FACING')) names.set(v, k);
  const out: OverworldSprite[] = [];
  for (let id = 1; id <= num; id++) {
    const name = names.get(id) ?? `SPRITE_${id}`;
    const r = rom.reader(table + (id - 1) * 4);
    const addr = r.u16();
    const size = r.u8();
    const bank = r.u8();
    // Walking sprites store a second set of 12 tiles (walking frames) right after the
    // first; LoadMapSpriteTilePatterns copies both halves (see engine/overworld/map_sprites.asm).
    const bytes = id < firstStill && size === 12 * 16 ? size * 2 : size;
    out.push({ id, name, ...sheetFromBytes([...rom.slice(toOffset(bank, addr), bytes)]) });
  }
  // Player sheets that are not in SpriteSheetPointerTable, appended after NUM_SPRITES.
  const id = (label: (typeof EXTRA_SHEETS)[number]) => num + 1 + EXTRA_SHEETS.indexOf(label);
  for (const label of ['RedBikeSprite', 'SurfingPikachuSprite'] as const) {
    out.push({ id: id(label), name: label, ...sheetFromBytes([...rom.slice(rom.sym(label), 24 * 16)]) });
  }
  // FishingAnim: RedSprite's 12 standing tiles, tiles 2-3 / 6-7 / 10-11 replaced by the fishing tiles
  const red = [...rom.slice(rom.sym('RedSprite'), 12 * 16)];
  ['RedFishingTilesFront', 'RedFishingTilesBack', 'RedFishingTilesSide'].forEach((l, i) => red.splice((i * 4 + 2) * 16, 32, ...rom.slice(rom.sym(l), 32)));
  out.push({ id: id('RedFishingSprite'), name: 'RedFishingSprite', ...sheetFromBytes(red) });
  // the rod: tile $fd (vertical) below the player facing down / above facing up, $fe beside facing left
  const rod = decode2bpp(rom.slice(rom.sym('RedFishingRodTiles'), 3 * 16));
  const rodPixels = new Array<number>(3 * 256).fill(0);
  const put = (frame: number, tile: number, ox: number, oy: number) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) rodPixels[frame * 256 + (oy + y) * 16 + ox + x] = rod[tile * 64 + y * 8 + x];
  };
  put(0, 0, 4, 8);
  put(1, 0, 4, 8);
  put(2, 1, 8, 4);
  out.push({ id: id('FishingRod'), name: 'FishingRod', tileCount: 12, pixels: rodPixels, frames: 3 });
  // field animation OAM graphics
  const tile = (at: number) => decode2bpp(rom.slice(at, 16));
  const blit = (px: number[], frame: number, t: number[], ox: number, oy: number) => {
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[frame * 256 + (oy + y) * 16 + ox + x] = t[y * 8 + x];
  };
  const gfx = rom.sym('Overworld_GFX');
  const tree = new Array<number>(2 * 256).fill(0);
  blit(tree, 0, tile(gfx + 0x2d * 16), 0, 0);
  blit(tree, 0, tile(gfx + 0x3d * 16), 0, 8);
  blit(tree, 1, tile(gfx + 0x2e * 16), 8, 0);
  blit(tree, 1, tile(gfx + 0x3e * 16), 8, 8);
  out.push({ id: id('CutTree'), name: 'CutTree', tileCount: 8, pixels: tree, frames: 2 });
  const leaf = new Array<number>(256).fill(0);
  blit(leaf, 0, tile(rom.sym('MoveAnimationTiles1') + 6 * 16), 4, 4);
  out.push({ id: id('CutLeaf'), name: 'CutLeaf', tileCount: 4, pixels: leaf, frames: 1 });
  const smoke = tile(rom.sym('SSAnneSmokePuffTile'));
  const dust = new Array<number>(256).fill(0);
  for (const [ox, oy] of [[0, 0], [8, 0], [0, 8], [8, 8]]) blit(dust, 0, smoke, ox, oy);
  out.push({ id: id('BoulderDust'), name: 'BoulderDust', tileCount: 4, pixels: dust, frames: 1 });
  return out;
}

/** Split 2bpp tile data into 16x16 frames (top-left, top-right, bottom-left, bottom-right tiles). */
function sheetFromBytes(bytes: number[]): Pick<OverworldSprite, 'tileCount' | 'pixels' | 'frames'> {
  const raw = decode2bpp(Uint8Array.from(bytes));
  const tileCount = bytes.length >> 4;
  const frames = tileCount >> 2;
  const pixels = new Array<number>(frames * 256);
  for (let f = 0; f < frames; f++)
    for (let q = 0; q < 4; q++) {
      const tx = (q & 1) * 8;
      const ty = (q >> 1) * 8;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) pixels[f * 256 + (ty + y) * 16 + tx + x] = raw[(f * 4 + q) * 64 + y * 8 + x];
    }
  return { tileCount, pixels, frames };
}

export function extractPalettes(rom: Rom): PaletteData {
  const sp = rom.sym('SuperPalettes');
  const count = c('palette', 'NUM_SGB_PALS');
  const superPalettes: [number, number, number][][] = [];
  for (let i = 0; i < count; i++) {
    const pal: [number, number, number][] = [];
    for (let j = 0; j < 4; j++) {
      const w = rom.u16(sp + i * 8 + j * 2);
      pal.push([w & 31, (w >> 5) & 31, (w >> 10) & 31]);
    }
    superPalettes.push(pal);
  }
  const mp = rom.sym('MonsterPalettes');
  const monsterPalettes = [...rom.slice(mp, 152)];
  return { superPalettes, monsterPalettes };
}
