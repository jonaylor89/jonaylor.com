/**
 * Map sprite state and per-update logic, ported from
 * engine/overworld/movement.asm (UpdateNPCSprite, TryWalking,
 * CanWalkOntoTile, UpdateSpriteInWalkingAnimation, UpdateSpriteMovementDelay,
 * MakeNPCFacePlayer, Func_5288/Func_5357, DoScriptedNPCMovement).
 *
 * Positions are kept in map squares plus a pixel offset instead of the
 * original's screen-relative pixel coordinates; the two are equivalent
 * because the original shifts every sprite whenever the screen scrolls.
 */
import { EXTRA_SHEETS } from '../data/schema';
import type { ObjectEvent } from '../data/schema';
import { c } from '../rom/constants';

export const FACING_DOWN = 0;
export const FACING_UP = 4;
export const FACING_LEFT = 8;
export const FACING_RIGHT = 12;

export const NPC_MOVEMENT_DOWN = 0x00;
export const NPC_MOVEMENT_UP = 0x40;
export const NPC_MOVEMENT_LEFT = 0x80;
export const NPC_MOVEMENT_RIGHT = 0xc0;
export const NPC_CHANGE_FACING = 0xe0;
export const WALK = 0xfe;
export const STAY = 0xff;

/** Sprite id of a EXTRA_SHEETS entry (stored after NUM_SPRITES). */
export function extraSheetId(label: (typeof EXTRA_SHEETS)[number]): number {
  return c('sprite', 'NUM_SPRITES') + 1 + EXTRA_SHEETS.indexOf(label);
}
export const ANY_DIR = 0x00;
export const UP_DOWN = 0x01;
export const LEFT_RIGHT = 0x02;
export const DOWN = 0xd0;
export const UP = 0xd1;
export const LEFT = 0xd2;
export const RIGHT = 0xd3;
export const NONE = 0xff;

export interface Sprite {
  /** Sprite slot: 0 = player, 1..15 = map objects (object index), 15 = Pikachu. */
  slot: number;
  /** Picture id (SPRITE_*); 0 = empty slot. */
  pictureId: number;
  obj?: ObjectEvent;
  /** 0 uninitialized, 1 ready, 2 delayed, 3 walking, 4 fast walking. */
  movementStatus: number;
  facing: number;
  origFacing: number;
  mapX: number;
  mapY: number;
  /** Render offset in pixels from (mapX, mapY). */
  offX: number;
  offY: number;
  stepX: number;
  stepY: number;
  walkCounter: number;
  /** Advance the map position when a walk starts (false for Func_5288's "set 2" half steps). */
  movementByte1: number;
  movementByte2: number;
  delay: number;
  yDisp: number;
  xDisp: number;
  intraAnim: number;
  animFrame: number;
  facePlayer: boolean;
  /** Hidden via toggleable objects. */
  hidden: boolean;
  /** Image index $ff: outside the update window or otherwise not drawn. */
  offscreen: boolean;
}

export function newSprite(slot: number, obj?: ObjectEvent): Sprite {
  const facingFromDir: Record<number, number> = { [DOWN]: FACING_DOWN, [UP]: FACING_UP, [LEFT]: FACING_LEFT, [RIGHT]: FACING_RIGHT };
  return {
    slot,
    pictureId: obj?.sprite ?? 0,
    obj,
    movementStatus: 0,
    facing: obj ? (facingFromDir[obj.rangeOrDirection] ?? FACING_DOWN) : FACING_DOWN,
    origFacing: FACING_DOWN,
    mapX: obj?.x ?? 0,
    mapY: obj?.y ?? 0,
    offX: 0,
    offY: 0,
    stepX: 0,
    stepY: 0,
    walkCounter: 0,
    movementByte1: obj?.movement ?? STAY,
    movementByte2: obj?.rangeOrDirection ?? NONE,
    delay: 0,
    yDisp: 8,
    xDisp: 8,
    intraAnim: 0,
    animFrame: 0,
    facePlayer: false,
    hidden: false,
    offscreen: false,
  };
}

/** What the sprite engine needs from the world/engine. */
export interface SpriteHost {
  random(): number;
  hRandomAdd(): number;
  /** Player position (wXCoord / wYCoord) and walk state. */
  playerX(): number;
  playerY(): number;
  playerWalking(): boolean;
  /** wPlayerDirection as a facing value, for MakeNPCFacePlayer. */
  playerDirectionFacing(): number;
  fontLoaded(): boolean;
  noNpcFacePlayer(): boolean;
  isTilePassable(x: number, y: number): boolean;
  /** Squares occupied by any sprite other than `self` (including the player). */
  occupiedByOther(self: Sprite, x: number, y: number): boolean;
  /** Scripted NPC movement buffer (wNPCMovementDirections). */
  scripted: ScriptedMovement;
}

export interface ScriptedMovement {
  directions: number[];
  /** wNPCNumScriptedSteps */
  numSteps: number;
  /** BIT_SCRIPTED_NPC_MOVEMENT */
  active: boolean;
  onEnd(): void;
}

/** Func_5274: advance the walk animation (frame every 4 ticks, 4 frames per cycle). */
function tickAnim(s: Sprite): void {
  s.intraAnim = (s.intraAnim + 1) & 3;
  if (s.intraAnim === 0) s.animFrame = (s.animFrame + 1) & 3;
}

/** UpdateNPCSprite for one map sprite (called once per UpdateSprites). */
export function updateNpcSprite(s: Sprite, h: SpriteHost): void {
  if (s.movementStatus === 0) {
    // InitializeSpriteStatus
    s.movementStatus = 1;
    s.offscreen = true;
    s.yDisp = 8;
    s.xDisp = 8;
    s.offX = s.offY = 0;
    return;
  }
  if (!checkSpriteAvailability(s, h)) return;
  if (s.facePlayer) {
    // MakeNPCFacePlayer
    if (!h.noNpcFacePlayer()) {
      s.facePlayer = false;
      s.facing = h.playerDirectionFacing();
    }
    s.animFrame = 0;
    return;
  }
  if (h.fontLoaded()) {
    s.animFrame = 0; // NotYetMoving
    return;
  }
  switch (s.movementStatus) {
    case 2:
      updateMovementDelay(s);
      return;
    case 3:
      updateWalking(s, h, 1);
      return;
    case 4:
      updateWalking(s, h, 2);
      return;
  }
  if (h.playerWalking()) return;
  // InitializeSpriteScreenPosition: snap to the map position.
  s.offX = s.offY = 0;
  if (s.movementByte1 === STAY || s.movementByte1 === WALK) {
    const r = h.random();
    determineDirection(s, h, r);
    return;
  }
  // scripted movement
  const sm = h.scripted;
  const i = s.movementByte1;
  s.movementByte1 = i + 1;
  sm.numSteps = (sm.numSteps - 1) & 0xff;
  const a = sm.directions[i] ?? STAY;
  if (a === NPC_CHANGE_FACING) {
    tryWalking(s, h, 0, 0, s.facing, 0);
    return;
  }
  if (a === STAY) {
    s.movementByte1 = STAY;
    sm.active = false;
    sm.onEnd();
    return;
  }
  if (specialMovement(s, a)) return;
  determineDirection(s, h, a);
}

/** CheckSpriteAvailability: only sprites inside the screen window around the player update. */
function checkSpriteAvailability(s: Sprite, h: SpriteHost): boolean {
  if (s.hidden) {
    s.offscreen = true;
    return false;
  }
  if (s.movementByte1 >= WALK) {
    const ry = s.mapY + 4 - h.playerY();
    const rx = s.mapX + 4 - h.playerX();
    if (ry < 0 || ry > 8 || rx < 0 || rx > 9) {
      s.offscreen = true;
      return false;
    }
  }
  s.offscreen = false;
  return true;
}

/** The .determineDirection block: map a random/scripted byte to a step attempt. */
function determineDirection(s: Sprite, h: SpriteHost, b: number): void {
  const m2 = s.movementByte2;
  const down = () => tryWalking(s, h, 1, 0, FACING_DOWN, 4);
  const up = () => tryWalking(s, h, -1, 0, FACING_UP, 8);
  const left = () => tryWalking(s, h, 0, -1, FACING_LEFT, 2);
  const right = () => tryWalking(s, h, 0, 1, FACING_RIGHT, 1);
  if (m2 === DOWN) return down();
  if (m2 === UP) return up();
  if (m2 === LEFT) return left();
  if (m2 === RIGHT) return right();
  if (b < NPC_MOVEMENT_UP) return m2 === LEFT_RIGHT ? left() : down();
  if (b < NPC_MOVEMENT_LEFT) return m2 === LEFT_RIGHT ? right() : up();
  if (b < NPC_MOVEMENT_RIGHT) return m2 === UP_DOWN ? up() : left();
  return m2 === UP_DOWN ? down() : right();
}

/**
 * TryWalking: set facing, test the destination, then start a 16-tick walk.
 * `dirBit` is the collision direction bit (1 right, 2 left, 4 down, 8 up).
 */
function tryWalking(s: Sprite, h: SpriteHost, dy: number, dx: number, facing: number, dirBit: number): void {
  s.facing = facing;
  s.stepY = dy;
  s.stepX = dx;
  if (!canWalkOntoTile(s, h, dy, dx, dirBit)) return;
  s.mapY += dy;
  s.mapX += dx;
  s.offY = -16 * dy;
  s.offX = -16 * dx;
  s.walkCounter = 16;
  s.movementStatus = 3;
}

function canWalkOntoTile(s: Sprite, h: SpriteHost, dy: number, dx: number, dirBit: number): boolean {
  if (s.movementByte1 < WALK) return true; // scripted movement always succeeds
  const tx = s.mapX + dx;
  const ty = s.mapY + dy;
  const fail = () => {
    s.movementStatus = 2;
    s.stepX = s.stepY = 0;
    h.random();
    s.delay = h.hRandomAdd() & 0x7f;
    return false;
  };
  if (!h.isTilePassable(tx, ty)) return fail();
  if (s.movementByte1 === STAY) return fail();
  // Screen-edge checks against the sprite's *current* screen position.
  const ry = (s.mapY + 4 - h.playerY()) * 16;
  const rx = (s.mapX + 4 - h.playerX()) * 16;
  if (((ry + dy) & 0xff) >= 0x80) return fail();
  if (((rx + dx) & 0xff) >= 0x90) return fail();
  if (dirBit && h.occupiedByOther(s, tx, ty)) return fail();
  // Displacement from the spawn point: up/left limited to 8 steps (Yellow fixed down/right).
  let yd = s.yDisp;
  if (dy < 0) {
    if (yd === 0) return fail();
    yd -= 1;
  } else yd = (yd + dy) & 0xff;
  let xd = s.xDisp;
  if (dx < 0) {
    if (xd === 0) return fail();
    xd -= 1;
  } else xd = (xd + dx) & 0xff;
  s.yDisp = yd;
  s.xDisp = xd;
  return true;
}

/** UpdateSpriteInWalkingAnimation (speed 1) and Func_5357 (speed 2). */
function updateWalking(s: Sprite, h: SpriteHost, speed: number): void {
  tickAnim(s);
  s.offY += s.stepY * speed;
  s.offX += s.stepX * speed;
  s.walkCounter--;
  if (s.walkCounter > 0) return;
  if (s.movementByte1 < WALK) {
    s.movementStatus = 1;
    return;
  }
  h.random();
  s.delay = h.hRandomAdd() & 0x7f;
  s.movementStatus = 2;
  s.stepX = s.stepY = 0;
}

/** UpdateSpriteMovementDelay. A delay of 0 wraps to 256 ticks, as in the original. */
function updateMovementDelay(s: Sprite): void {
  if (s.movementByte1 < WALK) {
    s.delay = 0;
    s.movementStatus = 1;
  } else {
    s.delay = (s.delay - 1) & 0xff;
    if (s.delay === 0) s.movementStatus = 1;
  }
  s.animFrame = 0;
}

/**
 * Func_5288: Yellow's extra scripted movement codes.
 *  $04-$07: fast step (2 px per tick for 8 ticks), map position updated.
 *  $11-$14: 8-tick step at 1 px per tick without moving the map position.
 */
function specialMovement(s: Sprite, a: number): boolean {
  const dirs: Record<number, [number, number, number]> = {
    0x04: [1, 0, FACING_DOWN],
    0x05: [-1, 0, FACING_UP],
    0x06: [0, -1, FACING_LEFT],
    0x07: [0, 1, FACING_RIGHT],
    0x12: [1, 0, FACING_DOWN],
    0x11: [-1, 0, FACING_UP],
    0x13: [0, -1, FACING_LEFT],
    0x14: [0, 1, FACING_RIGHT],
  };
  const d = dirs[a];
  if (!d) return false;
  const [dy, dx, facing] = d;
  s.facing = facing;
  s.stepY = dy;
  s.stepX = dx;
  s.walkCounter = 8;
  if (a <= 0x07) {
    s.mapY += dy;
    s.mapX += dx;
    s.offY = -16 * dy;
    s.offX = -16 * dx;
    s.movementStatus = 4;
  } else {
    s.movementStatus = 3;
  }
  return true;
}

/**
 * DoScriptedNPCMovement: the NPC walks in lockstep with simulated player
 * input along wNPCMovementDirections2 — 2 px per tick, 8 ticks per square.
 * Only the drawn position changes; map coordinates stay put (as in the original).
 */
export interface SyncedMovement {
  directions: number[];
  index: number;
  walkCounter: number;
  initialized: boolean;
}

export function doScriptedNpcMovement(s: Sprite, m: SyncedMovement): void {
  if (!m.initialized) {
    m.initialized = true;
    m.index = 0;
    m.walkCounter = 8;
    return;
  }
  const a = m.directions[m.index];
  let dx = 0;
  let dy = 0;
  if (a === NPC_MOVEMENT_UP) [dy, s.facing] = [-2, FACING_UP];
  else if (a === NPC_MOVEMENT_DOWN) [dy, s.facing] = [2, FACING_DOWN];
  else if (a === NPC_MOVEMENT_LEFT) [dx, s.facing] = [-2, FACING_LEFT];
  else if (a === NPC_MOVEMENT_RIGHT) [dx, s.facing] = [2, FACING_RIGHT];
  else return;
  s.offX += dx;
  s.offY += dy;
  tickAnim(s);
  m.walkCounter--;
  if (m.walkCounter === 0) {
    m.walkCounter = 8;
    m.index++;
  }
}

/** Squares a sprite currently covers (its map square, plus the one it is leaving). */
export function spriteSquares(s: Sprite): [number, number][] {
  const out: [number, number][] = [[s.mapX, s.mapY]];
  if (s.movementStatus === 3 || s.movementStatus === 4) out.push([s.mapX - s.stepX, s.mapY - s.stepY]);
  return out;
}

export function facingName(f: number): 'down' | 'up' | 'left' | 'right' {
  return f === FACING_UP ? 'up' : f === FACING_LEFT ? 'left' : f === FACING_RIGHT ? 'right' : 'down';
}

export function facingValue(n: 'down' | 'up' | 'left' | 'right'): number {
  return { down: FACING_DOWN, up: FACING_UP, left: FACING_LEFT, right: FACING_RIGHT }[n];
}

/** Pikachu occupies the last sprite slot in Yellow. */
export const PIKACHU_SLOT = () => c('map_object', 'PIKACHU_SPRITE_INDEX');
