/**
 * Surface materials for texture packs. Every map quad is tagged with one, so
 * a pack can paint lawns, bark, shingles, rock or floorboards differently
 * while the ROM tile still supplies the shade pattern. Classification only
 * reads tileset names and the manifest's tile kinds/scenery models; it never
 * affects collision or gameplay.
 */
import type { TileKind } from '../manifest';
import type { SceneryKind } from '../scenery';

export const MAT = {
  GENERIC: 0,
  GROUND: 1,
  TALL_GRASS: 2,
  FLOWERS: 3,
  WATER: 4,
  FOLIAGE: 5,
  ROOF: 6,
  FACADE: 7,
  ROCK: 8,
  WOOD: 9,
  FLOOR_WOOD: 10,
  FLOOR_TILE: 11,
  CAVE_FLOOR: 12,
  INDOOR_WALL: 13,
  METAL: 14,
  STONE: 15,
  PATH: 16,
  /** The fake contact-shadow discs under props (hidden when real shadows are on). */
  SHADOW: 17,
} as const;
export type MaterialName = keyof typeof MAT;
export type MaterialId = (typeof MAT)[MaterialName];
export const MATERIAL_NAMES = Object.keys(MAT) as MaterialName[];
export const MATERIAL_COUNT = MATERIAL_NAMES.length;

const OUTDOOR = new Set(['OVERWORLD', 'FOREST', 'PLATEAU']);
const WOOD_FLOORS = new Set(['REDS_HOUSE_1', 'REDS_HOUSE_2', 'HOUSE', 'BEACH_HOUSE', 'MANSION', 'SHIP', 'SHIP_PORT', 'DOJO']);

export function outdoorTileset(name: string): boolean {
  return OUTDOOR.has(name);
}

/** Walkable ground of a tileset. */
export function floorMaterial(tileset: string): MaterialId {
  if (OUTDOOR.has(tileset)) return MAT.GROUND;
  if (tileset === 'CAVERN') return MAT.CAVE_FLOOR;
  if (tileset === 'CEMETERY') return MAT.STONE;
  if (WOOD_FLOORS.has(tileset)) return MAT.FLOOR_WOOD;
  return MAT.FLOOR_TILE;
}

/** Unclassified solid squares (extruded blocks). */
export function solidMaterial(tileset: string): MaterialId {
  if (OUTDOOR.has(tileset)) return MAT.FACADE;
  if (tileset === 'CAVERN') return MAT.ROCK;
  return MAT.INDOOR_WALL;
}

const MODEL: Partial<Record<SceneryKind, MaterialId>> = {
  tree: MAT.FOLIAGE, grove: MAT.FOLIAGE, cutTree: MAT.FOLIAGE, stump: MAT.FOLIAGE, plant: MAT.FOLIAGE,
  roof: MAT.ROOF, wall: MAT.FACADE,
  fence: MAT.WOOD, sign: MAT.WOOD, bookshelf: MAT.WOOD, counter: MAT.WOOD, table: MAT.WOOD,
  stool: MAT.WOOD, chair: MAT.WOOD, bed: MAT.WOOD, cabinet: MAT.WOOD,
  grass: MAT.TALL_GRASS, flowers: MAT.FLOWERS, ledge: MAT.GROUND,
  rock: MAT.ROCK, cliff: MAT.ROCK,
  pc: MAT.METAL, tv: MAT.METAL, machine: MAT.METAL, bin: MAT.METAL,
  statue: MAT.STONE, gravestone: MAT.STONE,
};

/** Material of one map quad. `role` marks a prop's own ground or its fake shadow disc. */
export function quadMaterial(tileset: string, opts: { model?: SceneryKind; kind?: TileKind; water?: boolean; role?: 'ground' | 'shadow' }): MaterialId {
  if (opts.water) return MAT.WATER;
  if (opts.role === 'shadow') return MAT.SHADOW;
  if (opts.role === 'ground') return opts.model === 'grass' ? MAT.TALL_GRASS : floorMaterial(tileset);
  if (opts.model) return MODEL[opts.model] ?? MAT.GENERIC;
  switch (opts.kind) {
    case 'water': return MAT.WATER;
    case 'solid': return solidMaterial(tileset);
    case 'counter': return MAT.WOOD;
    case 'ledge': return MAT.GROUND;
    default: return floorMaterial(tileset);
  }
}
