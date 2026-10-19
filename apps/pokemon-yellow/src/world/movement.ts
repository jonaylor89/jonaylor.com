/**
 * Overworld movement rules, ported from home/overworld.asm
 * (CollisionCheckOnLand, CheckForJumpingAndTilePairCollisions,
 * CheckWarpsNoCollision / CheckWarpsCollision, ExtraWarpCheck,
 * CheckMapConnections) and engine/overworld/ledges.asm.
 */
import type { Direction } from '../data/schema';
import type { WorldMap } from './WorldMap';
import { c } from '../rom/constants';

export type Facing = 'down' | 'up' | 'left' | 'right';

export const DIR_VEC: Record<Facing, [number, number]> = {
  down: [0, 1],
  up: [0, -1],
  left: [-1, 0],
  right: [1, 0],
};

/** SPRITE_FACING_* values as stored in ROM tables. */
export const FACING_VALUE: Record<Facing, number> = { down: 0, up: 4, left: 8, right: 12 };
/** PAD_* bits (as used by LedgeTiles). */
export const PAD_BIT: Record<Facing, number> = { right: 0x10, left: 0x20, up: 0x40, down: 0x80 };

export interface MoverState {
  x: number;
  y: number;
  facing: Facing;
  mode: 'walk' | 'bike' | 'surf';
}

export interface StepContext {
  /** True if an object (NPC, boulder, ...) occupies the square. */
  isOccupied(x: number, y: number): boolean;
  /** Movement controlled by a script: collisions are ignored (wSimulatedJoypadStatesIndex). */
  scripted?: boolean;
}

export type StepPlan =
  | { type: 'blocked'; reason: 'tile' | 'object' | 'tilepair' }
  | { type: 'walk'; x: number; y: number }
  | { type: 'jump'; x: number; y: number }
  | { type: 'warp'; warp: number };

const OVERWORLD = () => c('tileset', 'OVERWORLD');

export function front(m: MoverState, dir: Facing = m.facing): [number, number] {
  const [dx, dy] = DIR_VEC[dir];
  return [m.x + dx, m.y + dy];
}

/** HandleLedges: only in the OVERWORLD tileset. */
export function ledgeJump(world: WorldMap, m: MoverState, dir: Facing): boolean {
  if (world.data.tileset !== OVERWORLD()) return false;
  const standing = world.collisionTile(m.x, m.y);
  const [fx, fy] = front(m, dir);
  const ahead = world.collisionTile(fx, fy);
  return world.bundle.tileTables.ledges.some(
    (l) => l.facing === FACING_VALUE[dir] && l.standing === standing && l.ledge === ahead && l.input === PAD_BIT[dir],
  );
}

export function tilePairBlocked(world: WorldMap, standing: number, ahead: number, water = false): boolean {
  const list = water ? world.bundle.tileTables.pairCollisionsWater : world.bundle.tileTables.pairCollisionsLand;
  return list.some(
    (p) => p.tileset === world.data.tileset && ((p.a === standing && p.b === ahead) || (p.b === standing && p.a === ahead)),
  );
}

/** Door or warp tile under the player (IsPlayerStandingOnDoorTileOrWarpTile). */
export function standingOnDoorOrWarpTile(world: WorldMap, x: number, y: number): boolean {
  const t = world.collisionTile(x, y);
  return world.tileset.doorTiles.includes(t) || world.tileset.warpTiles.includes(t);
}

export function standingOnDoorTile(world: WorldMap, x: number, y: number): boolean {
  return world.tileset.doorTiles.includes(world.collisionTile(x, y));
}

/** ExtraWarpCheck: function 1 (facing map edge) or function 2 (warp carpet tile in front). */
export function extraWarpCheck(world: WorldMap, m: MoverState): boolean {
  const map = world.data.id;
  const ts = world.data.tileset;
  const useEdge =
    map === c('map', 'SS_ANNE_3F') ||
    !(
      [c('map', 'ROCKET_HIDEOUT_B1F'), c('map', 'ROCKET_HIDEOUT_B2F'), c('map', 'ROCKET_HIDEOUT_B4F'), c('map', 'ROCK_TUNNEL_1F')].includes(map) ||
      [c('tileset', 'OVERWORLD'), c('tileset', 'SHIP'), c('tileset', 'SHIP_PORT'), c('tileset', 'PLATEAU')].includes(ts)
    );
  if (useEdge) {
    switch (m.facing) {
      case 'down':
        return m.y === world.heightSquares - 1;
      case 'up':
        return m.y === 0;
      case 'left':
        return m.x === 0;
      case 'right':
        return m.x === world.widthSquares - 1;
    }
  }
  const [fx, fy] = front(m);
  const ahead = world.collisionTile(fx, fy);
  if (map === c('map', 'SS_ANNE_BOW')) return ahead === 0x15;
  return world.bundle.tileTables.warpCarpets[m.facing].includes(ahead);
}

/** Decide what happens when the player tries to move in `dir` while facing it. */
export function planStep(world: WorldMap, m: MoverState, dir: Facing, ctx: StepContext): StepPlan {
  const [fx, fy] = front(m, dir);
  if (ctx.scripted) return { type: 'walk', x: fx, y: fy };
  if (m.mode === 'surf') return planSurfStep(world, m, dir, ctx);

  let blocked: StepPlan | undefined;
  if (ctx.isOccupied(fx, fy)) blocked = { type: 'blocked', reason: 'object' };
  if (!blocked && ledgeJump(world, m, dir)) {
    const [dx, dy] = DIR_VEC[dir];
    return { type: 'jump', x: m.x + dx * 2, y: m.y + dy * 2 };
  }
  if (!blocked) {
    const standing = world.collisionTile(m.x, m.y);
    const ahead = world.collisionTile(fx, fy);
    if (tilePairBlocked(world, standing, ahead)) blocked = { type: 'blocked', reason: 'tilepair' };
    else if (!world.isSquarePassable(fx, fy)) blocked = { type: 'blocked', reason: 'tile' };
  }
  if (!blocked) return { type: 'walk', x: fx, y: fy };
  // Collision while standing on a warp: ExtraWarpCheck may still warp us (CheckWarpsCollision).
  const warp = world.warpAt(m.x, m.y);
  if (warp >= 0 && extraWarpCheck(world, { ...m, facing: dir })) return { type: 'warp', warp };
  return blocked;
}

/** CollisionCheckOnWater (simplified until the Surf module lands; see TASKS.md). */
function planSurfStep(world: WorldMap, m: MoverState, dir: Facing, ctx: StepContext): StepPlan {
  const [fx, fy] = front(m, dir);
  if (ctx.isOccupied(fx, fy)) return { type: 'blocked', reason: 'object' };
  const standing = world.collisionTile(m.x, m.y);
  const ahead = world.collisionTile(fx, fy);
  if (tilePairBlocked(world, standing, ahead, true)) return { type: 'blocked', reason: 'tilepair' };
  if (ahead === world.bundle.tileTables.waterTile || world.isSquarePassable(fx, fy)) return { type: 'walk', x: fx, y: fy };
  return { type: 'blocked', reason: 'tile' };
}

export type ArrivalResult =
  | { type: 'none' }
  | { type: 'warp'; warp: number }
  | { type: 'connection'; dir: Direction; map: number; x: number; y: number };

/**
 * After a step completes (CheckWarpsNoCollision, then CheckMapConnections).
 * `heldDirection` mirrors the joypad check for edge/carpet warps.
 */
export function afterStep(world: WorldMap, m: MoverState, heldDirection: boolean, forcedWarp = false): ArrivalResult {
  const warp = world.warpAt(m.x, m.y);
  if (warp >= 0) {
    if (standingOnDoorOrWarpTile(world, m.x, m.y)) return { type: 'warp', warp };
    if (extraWarpCheck(world, m) && (forcedWarp || heldDirection)) return { type: 'warp', warp };
  }
  return checkConnections(world, m);
}

export function checkConnections(world: WorldMap, m: MoverState): ArrivalResult {
  const d = world.data;
  const conn = (dir: Direction) => {
    const cn = d.connections[dir];
    if (!cn) return undefined;
    const other = world.bundle.maps[cn.map];
    return { cn, other };
  };
  if (m.x === -1) {
    const r = conn('west');
    if (r) return { type: 'connection', dir: 'west', map: r.cn.map, x: r.other.width * 2 - 1, y: m.y - r.cn.offset * 2 };
  } else if (m.x === world.widthSquares) {
    const r = conn('east');
    if (r) return { type: 'connection', dir: 'east', map: r.cn.map, x: 0, y: m.y - r.cn.offset * 2 };
  } else if (m.y === -1) {
    const r = conn('north');
    if (r) return { type: 'connection', dir: 'north', map: r.cn.map, x: m.x - r.cn.offset * 2, y: r.other.height * 2 - 1 };
  } else if (m.y === world.heightSquares) {
    const r = conn('south');
    if (r) return { type: 'connection', dir: 'south', map: r.cn.map, x: m.x - r.cn.offset * 2, y: 0 };
  }
  return { type: 'none' };
}

/** CheckIfInOutsideMap: towns/routes use OVERWORLD or PLATEAU tilesets. */
export function isOutsideMap(world: WorldMap): boolean {
  return world.data.tileset === c('tileset', 'OVERWORLD') || world.data.tileset === c('tileset', 'PLATEAU');
}

export interface WarpResolution {
  map: number;
  x: number;
  y: number;
  /** New value for wLastMap. */
  lastMap: number;
}

/** WarpFound2 + LoadMapData's warp destination handling. */
export function resolveWarp(world: WorldMap, warpIndex: number, lastMap: number): WarpResolution {
  const w = world.warp(warpIndex);
  let dest = w.destMap;
  let newLast = lastMap;
  if (isOutsideMap(world)) newLast = world.data.id;
  if (dest === 0xff) dest = lastMap;
  const target = world.bundle.maps[dest];
  if (!target) throw new Error(`warp ${warpIndex} of ${world.data.constName} leads to missing map ${dest}`);
  const tw = target.warps[w.destWarp];
  if (!tw) throw new Error(`warp ${warpIndex} of ${world.data.constName} leads to missing warp ${w.destWarp} in ${target.constName}`);
  return { map: dest, x: tw.x, y: tw.y, lastMap: newLast };
}
