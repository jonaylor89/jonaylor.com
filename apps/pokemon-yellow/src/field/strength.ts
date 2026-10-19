/**
 * Strength boulders: TryPushingBoulder / DoBoulderDustAnimation
 * (engine/overworld/push_boulder.asm), CheckForCollisionWhenPushingBoulder
 * (engine/overworld/player_state.asm) and AnimateBoulderDust
 * (engine/overworld/dust_smoke.asm), run before each map script.
 */
import type { Co, Engine } from '../engine/Engine';
import { c } from '../rom/constants';
import { DIR_VEC } from '../world/movement';
import { tilePairBlocked } from '../world/movement';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP } from '../engine/sprites';
import { PAD_CTRL_PAD, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_UP } from '../engine/pad';

const STAIRS_TILE = 0x15;

/** wStatusFlags1 BIT_STRENGTH_ACTIVE (kept in the save, as in the original). */
export function strengthActive(e: Engine): boolean {
  return ((e.state.vars.wStatusFlags1 ?? 0) >> c('ram', 'BIT_STRENGTH_ACTIVE')) & 1 ? true : false;
}
export function setStrengthActive(e: Engine, on: boolean): void {
  const bit = 1 << c('ram', 'BIT_STRENGTH_ACTIVE');
  const v = e.state.vars.wStatusFlags1 ?? 0;
  e.env.setVar('wStatusFlags1', on ? v | bit : v & ~bit);
}

/** CheckForCollisionWhenPushingBoulder: the square two steps ahead must take the boulder. */
function boulderBlocked(e: Engine, boulderSlot: number): boolean {
  const p = e.state.player;
  const [dx, dy] = DIR_VEC[p.facing];
  const tx = p.x + dx * 2;
  const ty = p.y + dy * 2;
  const tile = e.world.collisionTile(tx, ty);
  if (!e.world.isTilePassable(tile)) return true;
  if (tilePairBlocked(e.world, e.world.collisionTile(p.x + dx, p.y + dy), tile)) return true;
  if (tile === STAIRS_TILE) return true;
  // CheckForBoulderCollisionWithSprites: any other sprite on that square
  return e.sprites.some((s) => s && s.slot !== 0 && s.slot !== boulderSlot && !s.hidden && s.pictureId && s.mapX === tx && s.mapY === ty);
}

/** TryPushingBoulder: the second push in a row moves the boulder in front one square. */
export function tryPushingBoulder(e: Engine): void {
  const r = e.ram;
  if (!strengthActive(e) || r.boulderDust) return;
  const [fx, fy] = e.frontOfPlayer();
  const boulder = e.sprites.find((s) => s && s.slot !== 0 && s.slot !== e.pikachuSlot && !s.hidden && s.pictureId && s.mapX === fx && s.mapY === fy);
  if (!boulder || boulder.movementByte2 !== c('map_object', 'BOULDER_MOVEMENT_BYTE_2')) return resetBoulderPushFlags(e);
  r.boulderSpriteIndex = boulder.slot;
  const tried = r.triedPushBoulder;
  r.triedPushBoulder = true;
  if (!tried) return; // the player must try pushing twice before the boulder will move
  if (!(r.joyHeld & PAD_CTRL_PAD)) return;
  if (boulderBlocked(e, boulder.slot)) return resetBoulderPushFlags(e);
  const f = e.state.player.facing;
  const pad = { up: PAD_UP, down: PAD_DOWN, left: PAD_LEFT, right: PAD_RIGHT }[f];
  if (!(r.joyHeld & pad)) return;
  const move = { up: NPC_MOVEMENT_UP, down: NPC_MOVEMENT_DOWN, left: NPC_MOVEMENT_LEFT, right: NPC_MOVEMENT_RIGHT }[f];
  e.moveSprite(boulder.slot, [move]);
  e.env.playSound('push_boulder');
  r.boulderDust = true;
}

/** DoBoulderDustAnimation, once the boulder's scripted step is done. */
export function* doBoulderDustAnimation(e: Engine): Co {
  if (e.scripted.active) return;
  const r = e.ram;
  // AnimateBoulderDust: 8 steps of 4 px drift, 3 frames each, two squares ahead of the player
  const p = e.state.player;
  const [dx, dy] = DIR_VEC[p.facing];
  for (let t = 0; t < 8; t++) {
    r.fieldEffect = { kind: 'dust', x: p.x + dx * 2, y: p.y + dy * 2, t, frames: 8 };
    yield* e.delayFrames(3);
  }
  r.fieldEffect = undefined;
  r.joyHeld = 0;
  r.joyPressed = 0;
  r.joyIgnore = 0;
  resetBoulderPushFlags(e);
  r.pushedBoulder = true;
  r.spriteIndex = r.boulderSpriteIndex; // hSpriteIndex (map scripts' CheckBoulderCoords read it)
  const s = e.sprites[r.boulderSpriteIndex];
  if (s) s.movementByte2 = c('map_object', 'BOULDER_MOVEMENT_BYTE_2');
  e.env.playSound('cut');
}

function resetBoulderPushFlags(e: Engine): void {
  e.ram.boulderDust = false;
  e.ram.triedPushBoulder = false;
}
