/**
 * Runtime view of one map: tile lookups (including connected-map strips and
 * the border block, as the original wOverworldMap buffer provides),
 * collision tiles and event lookups.
 *
 * Coordinates:
 *  - block: 32x32 px (4x4 tiles)
 *  - square: 16x16 px — the unit of movement (player x/y, warps, objects)
 *  - tile: 8x8 px
 */
import type { Direction, GameBundle, MapData, TilesetData } from '../data/schema';

export class MissingDataError extends Error {}

/** Original blocks beyond the map edge that are loaded (MAP_BORDER). */
export const MAP_BORDER = 3;

export class WorldMap {
  readonly data: MapData;
  readonly tileset: TilesetData;
  readonly passable: Set<number>;

  constructor(
    readonly bundle: GameBundle,
    readonly id: number,
  ) {
    const data = bundle.maps[id];
    if (!data) throw new MissingDataError(`map ${id} not present in bundle`);
    this.data = data;
    const ts = bundle.tilesets[data.tileset];
    if (!ts) throw new MissingDataError(`tileset ${data.tileset} missing for map ${data.constName}`);
    this.tileset = ts;
    this.passable = new Set(ts.passable);
  }

  /** Blocks changed since the map was loaded (ReplaceTileBlock writes to wOverworldMap). */
  private readonly replaced = new Map<number, number>();
  /** Bumped on every block change so the renderer can rebuild. */
  blockVersion = 0;

  /** ReplaceTileBlock: set an in-map block. Lost when the map is loaded again, as in the original. */
  replaceBlock(bx: number, by: number, block: number): void {
    const d = this.data;
    if (bx < 0 || by < 0 || bx >= d.width || by >= d.height) throw new Error(`block (${bx},${by}) outside ${d.constName}`);
    this.replaced.set(by * d.width + bx, block);
    this.blockVersion++;
  }

  /**
   * Tiles changed on screen only (wTileMap / VRAM writes that bypass the block map, e.g. the
   * S.S. Anne's water fill). Like replaced blocks, they last until the map is loaded again.
   */
  private readonly tileOverrides = new Map<string, number>();
  overrideTile(tx: number, ty: number, tile: number): void {
    this.tileOverrides.set(`${tx},${ty}`, tile);
    this.blockVersion++;
  }

  /** A copy of this map with the same changed blocks (for rendering a snapshot). */
  snapshot(): WorldMap {
    const w = new WorldMap(this.bundle, this.data.id);
    for (const [k, v] of this.replaced) w.replaced.set(k, v);
    for (const [k, v] of this.tileOverrides) w.tileOverrides.set(k, v);
    return w;
  }

  get widthSquares(): number {
    return this.data.width * 2;
  }
  get heightSquares(): number {
    return this.data.height * 2;
  }

  /**
   * Block id at block coords, which may lie outside the map. Outside blocks
   * come from a connected map's adjoining strip when one exists, otherwise
   * the border block — matching what LoadTileBlockMap puts in wOverworldMap.
   */
  blockAt(bx: number, by: number): number {
    const d = this.data;
    if (bx >= 0 && by >= 0 && bx < d.width && by < d.height) return this.replaced.get(by * d.width + bx) ?? d.blocks[by * d.width + bx];
    const conn = this.connectionFor(bx, by);
    if (conn) return conn.map.data.blocks[conn.by * conn.map.data.width + conn.bx];
    return d.borderBlock;
  }

  /** Which connected map (if any) covers an outside block coordinate. */
  connectionFor(bx: number, by: number): { dir: Direction; map: WorldMap; bx: number; by: number } | undefined {
    const d = this.data;
    const tryDir = (dir: Direction, cx: number, cy: number) => {
      const c = d.connections[dir];
      if (!c) return undefined;
      const other = this.bundle.maps[c.map];
      if (!other) return undefined;
      let tx: number;
      let ty: number;
      switch (dir) {
        case 'north':
          tx = cx - c.offset;
          ty = other.height + cy;
          break;
        case 'south':
          tx = cx - c.offset;
          ty = cy - d.height;
          break;
        case 'west':
          tx = other.width + cx;
          ty = cy - c.offset;
          break;
        case 'east':
          tx = cx - d.width;
          ty = cy - c.offset;
          break;
      }
      if (tx < 0 || ty < 0 || tx >= other.width || ty >= other.height) return undefined;
      return { dir, map: this.connected(dir), bx: tx, by: ty };
    };
    if (by < 0 && bx >= 0 && bx < d.width) return tryDir('north', bx, by);
    if (by >= d.height && bx >= 0 && bx < d.width) return tryDir('south', bx, by);
    if (bx < 0 && by >= 0 && by < d.height) return tryDir('west', bx, by);
    if (bx >= d.width && by >= 0 && by < d.height) return tryDir('east', bx, by);
    return undefined;
  }

  private readonly connCache = new Map<Direction, WorldMap>();
  connected(dir: Direction): WorldMap {
    let m = this.connCache.get(dir);
    if (!m) {
      const c = this.data.connections[dir];
      if (!c) throw new MissingDataError(`${this.data.constName} has no ${dir} connection`);
      m = new WorldMap(this.bundle, c.map);
      this.connCache.set(dir, m);
    }
    return m;
  }

  /** Tile id at tile coordinates (8x8 grid). */
  tileAt(tx: number, ty: number): number {
    const o = this.tileOverrides.size ? this.tileOverrides.get(`${tx},${ty}`) : undefined;
    if (o !== undefined) return o;
    const bx = Math.floor(tx / 4);
    const by = Math.floor(ty / 4);
    const blockId = this.blockAt(bx, by);
    const ts = this.tilesetForBlock(bx, by);
    const block = ts.blocks[blockId];
    if (!block) throw new MissingDataError(`block ${blockId} missing in tileset ${ts.name}`);
    return block[(ty - by * 4) * 4 + (tx - bx * 4)];
  }

  /**
   * Tileset used to interpret a block. The original only has one tileset in
   * VRAM, so connected strips are drawn with the current one; every
   * connection between maps sharing a tileset behaves identically here. Where
   * tilesets differ (Route 23 <-> Route 22 / Indigo Plateau), we interpret the
   * connected map's blocks with its own tileset — the original would index
   * past the end of the current blockset (see DEVIATIONS.md).
   */
  tilesetForBlock(bx: number, by: number): TilesetData {
    const d = this.data;
    if (bx >= 0 && by >= 0 && bx < d.width && by < d.height) return this.tileset;
    const conn = this.connectionFor(bx, by);
    return conn ? conn.map.tileset : this.tileset;
  }

  /** Is the square passable, judged by the tileset that owns it. */
  isSquarePassable(sx: number, sy: number): boolean {
    const ts = this.tilesetForBlock(Math.floor(sx / 2), Math.floor(sy / 2));
    const tile = this.collisionTile(sx, sy);
    return ts === this.tileset ? this.passable.has(tile) : ts.passable.includes(tile);
  }

  /** The map whose blocks are shown at a square (self, a connected map, or self for border). */
  ownerOfSquare(sx: number, sy: number): WorldMap {
    if (this.inBounds(sx, sy)) return this;
    return this.connectionFor(Math.floor(sx / 2), Math.floor(sy / 2))?.map ?? this;
  }

  /** The tile collision is checked against: lower-left tile of a 16x16 square. */
  collisionTile(sx: number, sy: number): number {
    return this.tileAt(sx * 2, sy * 2 + 1);
  }

  /** Lower-right tile of a square (used e.g. for grass checks, coord 9,9). */
  lowerRightTile(sx: number, sy: number): number {
    return this.tileAt(sx * 2 + 1, sy * 2 + 1);
  }

  /** Upper-left tile (coord 8,8 — used for the door sound check). */
  upperLeftTile(sx: number, sy: number): number {
    return this.tileAt(sx * 2, sy * 2);
  }

  isTilePassable(tile: number): boolean {
    return this.passable.has(tile);
  }

  inBounds(sx: number, sy: number): boolean {
    return sx >= 0 && sy >= 0 && sx < this.widthSquares && sy < this.heightSquares;
  }

  /** wNumberOfWarps: a script can drop the last warps (the S.S. Anne leaving Vermilion Dock). */
  numberOfWarps = Infinity;

  /** wWarpEntries rewritten by elevator scripts: warp index → destination. Lost on reload. */
  private readonly warpOverrides = new Map<number, { destWarp: number; destMap: number }>();
  setWarpDestination(index: number, destWarp: number, destMap: number): void {
    this.warpOverrides.set(index, { destWarp, destMap });
  }
  /** The warp's destination, with any elevator rewrite. */
  warp(index: number) {
    const w = this.data.warps[index];
    const o = this.warpOverrides.get(index);
    return o ? { ...w, ...o } : w;
  }

  warpAt(sx: number, sy: number): number {
    const i = this.data.warps.findIndex((w) => w.x === sx && w.y === sy);
    return i < this.numberOfWarps ? i : -1;
  }

  signAt(sx: number, sy: number) {
    return this.data.signs.find((s) => s.x === sx && s.y === sy);
  }
}
