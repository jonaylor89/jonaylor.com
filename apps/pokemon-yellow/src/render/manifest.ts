/**
 * Asset manifest: maps every original asset id (tileset tile, overworld
 * sprite) to its generated 3D representation. Lookups for ids that are not
 * in the manifest throw MissingAssetError — nothing is silently skipped.
 *
 * Tile representations are derived from the ROM's own gameplay tables
 * (collision, water, grass, ledges, doors, counters) plus hand-authored
 * overrides below. Collision in Gen 1 is decided per 16x16 square by its
 * lower-left tile, so the 3D shape of a square is the shape of that tile.
 */
import type { GameBundle } from '../data/schema';
import { c } from '../rom/constants';
import type { SceneryKind } from './scenery';
import { WATER_LEVEL } from './water';

export class MissingAssetError extends Error {}

export type TileKind = 'floor' | 'grass' | 'water' | 'ledge' | 'door' | 'warp' | 'counter' | 'solid';

export interface TileVisual {
  kind: TileKind;
  /** Height of the square's top surface in world units (1 unit = 16 px square). */
  height: number;
  model?: SceneryKind;
  ledgeFacing?: number;
  part?: [number, number];
  span?: [number, number];
  rise?: number;
  /** The actual water graphic in this square, including mixed shoreline cells. */
  waterTile?: number;
}

export interface SpriteVisual {
  kind: 'billboard' | 'model';
  frames: number;
  /** Walking sprites have 6 frames (down, up, left, + walking variants). */
  walking: boolean;
  /** Still objects have real world-space silhouettes, not camera-facing cards. */
  model?: 'rock' | 'ball';
  /** Opaque pixels in the original 16x16 sheet for light/mid/dark surfaces. */
  modelPixels?: number[];
}

/** Authored scenery identities, indexed by the square's lower-left ROM tile.
 * Gameplay still uses the original collision tables, never these models.
 */
type SceneryTable = Partial<Record<SceneryKind, number[]>>;
const HOME: SceneryTable = {
  pc: [0x20], tv: [0x16], bookshelf: [0x30, 0x32], plant: [0x18],
  stool: [0x12], table: [0x36, 0x38, 0x3a, 0x3c], bed: [0x3d, 0x3f],
};
const SHOP: SceneryTable = { pc: [0x52], bookshelf: [0x54, 0x55, 0x50, 0x51], plant: [0x32], cabinet: [0x14] };
const GYM: SceneryTable = { bookshelf: [0x1d], plant: [0x50], tree: [0x17], rock: [0x2e], bin: [0x1b], statue: [0x12, 0x32, 0x3d], pc: [0x5c] };
const GATE: SceneryTable = { bookshelf: [0x22], plant: [0x35], stool: [0x12], cabinet: [0x39], machine: [0x5c] };
const SCENERY: Record<string, SceneryTable> = {
  OVERWORLD: {
    tree: [0x3a], cutTree: [0x3d], rock: [0x50],
    roof: [0x12, 0x15, 0x18, 0x25, 0x38, 0x5a, 0x5c], sign: [0x56], fence: [0x55],
    wall: [0x1a, 0x4a, 0x4b, 0x4e], cliff: [0x24, 0x34],
  },
  FOREST: { tree: [0x46, 0x56, 0x36], grove: [0x00, 0x0b, 0x2d, 0x2f, 0x3d, 0x3e, 0x3f], stump: [0x12], sign: [0x31] },
  REDS_HOUSE_1: HOME,
  REDS_HOUSE_2: HOME,
  BEACH_HOUSE: { ...HOME, tv: [0x16], pc: [0x20] },
  HOUSE: { pc: [0x20], bookshelf: [0x1e, 0x30], plant: [0x18], stool: [0x12], table: [0x36], cabinet: [0x3a] },
  MART: SHOP,
  POKECENTER: SHOP,
  LAB: { pc: [0x16, 0x1e], bookshelf: [0x28], plant: [0x3e], rock: [0x43], cabinet: [0x3a], machine: [0x12, 0x14] },
  MANSION: { bookshelf: [0x32], plant: [0x18], stool: [0x12], bed: [0x3d, 0x3f], cabinet: [0x3c], machine: [0x40, 0x42] },
  FOREST_GATE: GATE,
  MUSEUM: GATE,
  GATE,
  DOJO: GYM,
  GYM,
  SHIP: { bookshelf: [0x36], bin: [0x59], stool: [0x17], bed: [0x56], cabinet: [0x3b] },
  LOBBY: { bookshelf: [0x50, 0x52, 0x3a, 0x3c], stool: [0x17], cabinet: [0x33], machine: [0x12, 0x34] },
  CEMETERY: { gravestone: [0x17], statue: [0x3d], cabinet: [0x19] },
  INTERIOR: { stool: [0x3b], machine: [0x1b, 0x1d] },
  CAVERN: { cliff: [0x10, 0x11, 0x17, 0x31] },
  CLUB: { pc: [0x22], stool: [0x26] },
  FACILITY: { plant: [0x17], rock: [0x36], statue: [0x3d], cabinet: [0x19], machine: [0x4c] },
  PLATEAU: { tree: [0x17], rock: [0x2b], sign: [0x19], cliff: [0x24, 0x32, 0x34] },
};

// Four-tile signatures in hex: authored once, rather than allocating lookup
// tables for every square while building a large map.
const TREE_PARTS: Record<string, [number, number]> = {
  '4/5/23/15': [0, 0], '6/7/16/17': [1, 0],
  '24/25/0/35': [0, 1], '26/27/36/30': [1, 1],
};
const TABLE_PARTS: Record<string, [number, number]> = {
  '26/27/36/37': [0, 0], '28/29/38/39': [1, 0],
  '2a/2b/3a/3b': [0, 1], '2c/2a/3c/3a': [1, 1],
};
const signature = (tiles: number[]) => tiles.map((t) => t.toString(16)).join('/');

/** Hand-authored per-tileset height overrides: tileset const -> tile -> height. */
const HEIGHT_OVERRIDES: Record<string, Record<number, number>> = {
  // Outdoor: signs, fences and short obstacles are knee-high, not wall-high.
  OVERWORLD: {},
};

const DEFAULT_SOLID_HEIGHT = 1;
const COUNTER_HEIGHT = 0.55;
const LEDGE_HEIGHT = 0.12;

export class AssetManifest {
  private readonly tiles = new Map<number, TileVisual[]>();
  private readonly sprites = new Map<number, SpriteVisual>();
  private readonly flowering = new Set<number>();
  private readonly waterTiles = new Map<number, number>();

  constructor(bundle: GameBundle) {
    const tt = bundle.tileTables;
    const overworld = c('tileset', 'OVERWORLD');
    for (const ts of bundle.tilesets) {
      const passable = new Set(ts.passable);
      if (ts.animation === c('map_data', 'TILEANIM_WATER_FLOWER')) this.flowering.add(ts.id);
      const hasWater = tt.waterTilesets.includes(ts.id);
      if (hasWater) this.waterTiles.set(ts.id, tt.waterTile);
      const ledgeTiles = new Set(ts.id === overworld ? tt.ledges.map((l) => l.ledge) : []);
      const overrides = HEIGHT_OVERRIDES[ts.name] ?? {};
      const list: TileVisual[] = [];
      for (let t = 0; t < ts.tileCount; t++) {
        let v: TileVisual;
        if (hasWater && t === tt.waterTile) v = { kind: 'water', height: WATER_LEVEL, waterTile: tt.waterTile };
        else if (ledgeTiles.has(t)) v = { kind: 'ledge', height: LEDGE_HEIGHT };
        else if (ts.counterTiles.includes(t)) v = { kind: 'counter', height: COUNTER_HEIGHT };
        else if (ts.doorTiles.includes(t)) v = { kind: 'door', height: 0 };
        else if (passable.has(t) && t === ts.grassTile) v = { kind: 'grass', height: 0 };
        else if (passable.has(t) && ts.warpTiles.includes(t)) v = { kind: 'warp', height: 0 };
        else if (passable.has(t)) v = { kind: 'floor', height: 0 };
        else v = { kind: 'solid', height: DEFAULT_SOLID_HEIGHT };
        if (v.kind === 'grass') v.model = 'grass';
        if (v.kind === 'counter') v.model = 'counter';
        if (v.kind === 'ledge') {
          v.model = 'ledge';
          v.ledgeFacing = tt.ledges.find((l) => l.ledge === t)?.facing;
        }
        for (const [model, ids] of Object.entries(SCENERY[ts.name] ?? {}))
          if (ids.includes(t)) v.model = model as SceneryKind;
        if (overrides[t] !== undefined) v = { ...v, height: overrides[t] };
        list.push(v);
      }
      this.tiles.set(ts.id, list);
    }
    const firstStill = c('sprite', 'FIRST_STILL_SPRITE');
    for (const sp of bundle.sprites) {
      const model = sp.id === c('sprite', 'SPRITE_BOULDER') ? 'rock'
        : sp.id === c('sprite', 'SPRITE_POKE_BALL') ? 'ball' : undefined;
      const opaque = Math.max(0, sp.pixels.findIndex((p) => p !== 0));
      const modelPixels = model ? [1, 2, 2, 3].map((color) => {
        const pixel = sp.pixels.indexOf(color);
        return pixel >= 0 ? pixel : opaque;
      }) : undefined;
      this.sprites.set(sp.id, { kind: model ? 'model' : 'billboard', frames: sp.frames, walking: sp.id < firstStill && sp.frames === 6, model, modelPixels });
    }
  }

  tile(tileset: number, tile: number): TileVisual {
    const list = this.tiles.get(tileset);
    if (!list) throw new MissingAssetError(`no 3D assets for tileset ${tileset}`);
    const v = list[tile];
    if (!v) throw new MissingAssetError(`no 3D asset for tileset ${tileset} tile $${tile.toString(16)}`);
    return v;
  }

  /** Whole-square context: animated flowers can be in any of its four tiles. */
  square(tileset: number, tiles: number[]): TileVisual {
    const v = this.tile(tileset, tiles[2]);
    const waterTile = this.waterTiles.get(tileset);
    if (waterTile !== undefined && tiles.includes(waterTile) && !v.model)
      return { ...v, waterTile, height: v.kind === 'solid' ? 0 : v.height };
    if (tileset === c('tileset', 'OVERWORLD') && tiles[2] === 0x17 && [0x07, 0x12, 0x53, 0x5a].includes(tiles[0])) return { ...v, model: 'roof' };
    // Some facades/roof edges share the same collision tile. Classify the
    // illustration, not just that tile, so windows never become roof wedges.
    if (tileset === c('tileset', 'OVERWORLD') && [0x0f, 0x17, 0x22, 0x4f, 0x1f].includes(tiles[2])
      && [0x0a, 0x0f, 0x22, 0x23, 0x28, 0x3f].includes(tiles[0])) return { ...v, model: 'wall' };
    if (tileset === c('tileset', 'FOREST')) {
      // The large round tree is a 2x2 gameplay-square illustration. Each
      // quarter receives the same clipped canopy, not four trees or slabs.
      const part = TREE_PARTS[signature(tiles)];
      if (part) return { ...v, model: 'tree', part, span: [2, 2], rise: 1.2 };
    }
    if ([c('tileset', 'GYM'), c('tileset', 'DOJO')].includes(tileset) && v.model === 'statue'
      && [0x12, 0x32].includes(tiles[2]))
      return { ...v, part: [0, tiles[2] === 0x12 ? 0 : 1], span: [1, 2], rise: 1.3 };
    if ([c('tileset', 'REDS_HOUSE_1'), c('tileset', 'REDS_HOUSE_2'), c('tileset', 'BEACH_HOUSE')].includes(tileset)) {
      const part = TABLE_PARTS[signature(tiles)];
      if (part) return { ...v, model: 'table', part, span: [2, 2] };
    }
    return this.flowering.has(tileset) && tiles.includes(0x03) && v.kind === 'floor'
      ? { ...v, model: 'flowers' }
      : v;
  }

  sprite(id: number): SpriteVisual {
    const v = this.sprites.get(id);
    if (!v) throw new MissingAssetError(`no 3D asset for sprite ${id}`);
    return v;
  }

  /** Serializable view: original asset id -> representation. */
  toJSON(): Record<string, TileVisual | SpriteVisual> {
    const out: Record<string, TileVisual | SpriteVisual> = {};
    for (const [ts, list] of this.tiles) list.forEach((v, t) => (out[`tileset:${ts}:tile:${t}`] = v));
    for (const [id, v] of this.sprites) out[`sprite:${id}`] = v;
    return out;
  }
}
