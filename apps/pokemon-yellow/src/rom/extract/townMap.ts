/**
 * Town Map data (engine/items/town_map.asm): the RLE-compressed map, its tiles,
 * the cursor/arrow/nest icons, the bird sprite, ExternalMapEntries /
 * InternalMapEntries (coordinates and names) and TownMapOrder.
 */
import type { Rom } from '../Rom';
import type { GameBundle } from '../../data/schema';
import { c } from '../symbols';
import { decodeString } from '../text';
import { decode2bpp } from './util';

/** CopyVideoDataDouble: 1bpp rows written to both bitplanes (color 3 where set). */
function decode1bpp(rom: Rom, at: number, tiles: number): number[] {
  const out = new Array<number>(tiles * 64);
  for (let t = 0; t < tiles; t++)
    for (let y = 0; y < 8; y++) {
      const row = rom.u8(at + t * 8 + y);
      for (let x = 0; x < 8; x++) out[t * 64 + y * 8 + x] = (row >> (7 - x)) & 1 ? 3 : 0;
    }
  return out;
}

export function extractTownMap(rom: Rom): GameBundle['townMap'] {
  const sym = (l: string) => rom.sym(l);
  const size = (l: string) => sym(`${l}End`) - sym(l);
  // LoadTownMap: runs of (tile - $60) << 4 | count from hlcoord 0, 0
  const tilemap: number[] = [];
  for (let p = sym('CompressedMap'); rom.u8(p); p++) {
    const b = rom.u8(p);
    for (let i = 0; i < (b & 0xf); i++) tilemap.push((b >> 4) + 0x60);
  }
  const name = (ptr: number, bank: number) => decodeString(rom, bank * 0x4000 + (ptr - 0x4000), 20);
  const bank = Math.floor(sym('ExternalMapEntries') / 0x4000);
  const coords = (b: number) => ({ x: b & 0xf, y: b >> 4 });
  const firstIndoor = c('map', 'FIRST_INDOOR_MAP');
  const external = Array.from({ length: firstIndoor }, (_, i) => {
    const p = sym('ExternalMapEntries') + i * 3;
    return { ...coords(rom.u8(p)), name: name(rom.u16(p + 1), bank) };
  });
  const internal: { below: number; x: number; y: number; name: string }[] = [];
  for (let p = sym('InternalMapEntries'); rom.u8(p) !== 0xff; p += 4) {
    internal.push({ below: rom.u8(p), ...coords(rom.u8(p + 1)), name: name(rom.u16(p + 2), bank) });
  }
  const order: number[] = [];
  for (let p = sym('TownMapOrder'); p < sym('TownMapOrderEnd'); p++) order.push(rom.u8(p));
  return {
    tiles: decode2bpp(rom.slice(sym('WorldMapTileGraphics'), size('WorldMapTileGraphics'))),
    tilemap,
    cursor: decode1bpp(rom, sym('TownMapCursor'), size('TownMapCursor') / 8),
    upArrow: decode1bpp(rom, sym('TownMapUpArrow'), size('TownMapUpArrow') / 8),
    nestIcon: decode1bpp(rom, sym('MonNestIcon'), size('MonNestIcon') / 8),
    // BirdSprite's first frame (facing down), as LoadTownMap_Fly copies it to vSprites tile 4
    bird: decode2bpp(rom.slice(sym('BirdSprite'), 4 * 16)),
    external,
    internal,
    order,
    strings: {
      to: decodeString(rom, sym('ToText'), 4),
      nest: decodeString(rom, sym('MonsNestText'), 10),
      areaUnknown: decodeString(rom, sym('AreaUnknownText'), 16),
    },
  };
}
