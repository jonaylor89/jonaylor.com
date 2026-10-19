/**
 * Tileset graphics, blocksets, collision and the special tile tables used by
 * overworld movement (ledges, doors, warps, water, cut trees, ...).
 */
import type { Rom } from '../Rom';
import { c, constEntries, nextLabelOffset, sym, toOffset, symBank } from '../symbols';
import type { TileTables, TilesetData } from '../../data/schema';
import { assert, decode2bpp, readUntil } from './util';
import { labelFor } from '../text';

export function extractTilesets(rom: Rom): TilesetData[] {
  const num = c('tileset', 'NUM_TILESETS');
  const table = rom.sym('Tilesets');
  const warpPtrs = rom.sym('WarpTileIDPointers');
  const warpBank = symBank('WarpTileIDPointers');
  const names = constEntries('tileset').filter(([k]) => k !== 'NUM_TILESETS' && k !== 'MAP_TILESET_SIZE');
  const doorLists = new Map<number, number[]>();
  const doorPtrs = rom.sym('DoorTileIDPointers');
  const doorBank = symBank('DoorTileIDPointers');
  for (let p = doorPtrs; rom.u8(p) !== 0xff; p += 3) {
    doorLists.set(rom.u8(p), readUntil(rom, toOffset(doorBank, rom.u16(p + 1)), 0x00));
  }
  const collBank = symBank('Overworld_Coll');
  const maxTiles = c('tileset', 'MAP_TILESET_SIZE');

  const out: TilesetData[] = [];
  for (let id = 0; id < num; id++) {
    const r = rom.reader(table + id * 12);
    const bank = r.u8();
    const blockPtr = toOffset(bank, r.u16());
    const gfxPtr = toOffset(bank, r.u16());
    const collPtr = toOffset(collBank, r.u16());
    const counters = [r.u8(), r.u8(), r.u8()].filter((t) => t !== 0xff);
    const grass = r.u8();
    const animation = r.u8();
    assert(labelFor(collPtr).endsWith('_Coll'), `tileset ${id} collision pointer`);

    const gfxEnd = nextLabelOffset(gfxPtr);
    const tileCount = Math.min(maxTiles, (gfxEnd - gfxPtr) >> 4);
    const tilePixels = decode2bpp(rom.slice(gfxPtr, tileCount * 16));
    const blockEnd = nextLabelOffset(blockPtr);
    const blockCount = Math.min(256, (blockEnd - blockPtr) >> 4);
    const blocks: number[][] = [];
    for (let b = 0; b < blockCount; b++) blocks.push([...rom.slice(blockPtr + b * 16, 16)]);

    const warpTiles = readUntil(rom, toOffset(warpBank, rom.u16(warpPtrs + id * 2)));
    out.push({
      id,
      name: names.find(([, v]) => v === id)?.[0] ?? `TILESET_${id}`,
      tilePixels,
      tileCount,
      blocks,
      passable: readUntil(rom, collPtr),
      counterTiles: counters,
      grassTile: grass,
      animation,
      warpTiles,
      doorTiles: doorLists.get(id) ?? [],
    });
  }
  return out;
}

export function extractTileTables(rom: Rom): TileTables {
  const triples = (label: string) => {
    const out: { tileset: number; a: number; b: number }[] = [];
    for (let p = sym(label); rom.u8(p) !== 0xff; p += 3) out.push({ tileset: rom.u8(p), a: rom.u8(p + 1), b: rom.u8(p + 2) });
    return out;
  };
  const ledges = [];
  for (let p = sym('LedgeTiles'); rom.u8(p) !== 0xff; p += 4) {
    ledges.push({ facing: rom.u8(p), standing: rom.u8(p + 1), ledge: rom.u8(p + 2), input: rom.u8(p + 3) });
  }
  const cutTreeBlocks = [];
  for (let p = sym('CutTreeBlockSwaps'); rom.u8(p) !== 0xff; p += 2) cutTreeBlocks.push({ from: rom.u8(p), to: rom.u8(p + 1) });

  // Bookshelf text ids index TextPredefs (1-based word table).
  const predefs = sym('TextPredefs');
  const predefBank = symBank('TextPredefs');
  const bookshelves = [];
  for (let p = sym('BookshelfTileIDs'); rom.u8(p) !== 0xff; p += 3) {
    const idx = rom.u8(p + 2);
    const target = toOffset(predefBank, rom.u16(predefs + (idx - 1) * 2));
    bookshelves.push({ tileset: rom.u8(p), tile: rom.u8(p + 1), textLabel: labelFor(target) });
  }
  const warpPadsAndHoles = triples('WarpPadAndHoleData').map((t) => ({ tileset: t.tileset, tile: t.a, kind: t.b }));
  const carpetTable = sym('WarpTileListPointers');
  const carpetBank = symBank('WarpTileListPointers');
  const carpet = (i: number) => readUntil(rom, toOffset(carpetBank, rom.u16(carpetTable + i * 2)));

  return {
    ledges,
    pairCollisionsLand: triples('TilePairCollisionsLand'),
    pairCollisionsWater: triples('TilePairCollisionsWater'),
    waterTilesets: readUntil(rom, sym('WaterTilesets')),
    shoreTiles: readUntil(rom, sym('ShoreTiles')),
    waterTile: rom.u8(sym('WaterTile')),
    cutTreeBlocks,
    bookshelves,
    warpPadsAndHoles,
    dungeonTilesets: readUntil(rom, sym('DungeonTilesets')),
    escapeRopeTilesets: readUntil(rom, sym('EscapeRopeTilesets')),
    bikeRidingTilesets: readUntil(rom, sym('BikeRidingTilesets')),
    // ForcedBikeOrSurfMaps: map, y, x
    forcedBikeOrSurf: (() => {
      const raw = readUntil(rom, sym('ForcedBikeOrSurfMaps'));
      return Array.from({ length: raw.length / 3 }, (_, i) => ({ map: raw[i * 3], y: raw[i * 3 + 1], x: raw[i * 3 + 2] }));
    })(),
    warpCarpets: { down: carpet(0), up: carpet(1), left: carpet(2), right: carpet(3) },
    playerJumpingY: [...rom.slice(sym('PlayerJumpingYScreenCoords'), 16)],
    flowerTiles: ['FlowerTile1', 'FlowerTile2', 'FlowerTile3'].map((l) => decode2bpp(rom.slice(sym(l), 16))),
  };
}
