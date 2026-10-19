/**
 * Map-change animations (engine/overworld/player_animations.asm): Fly's bird,
 * the Teleport/Escape Rope/Dig spin, warp pads, holes and dungeon warps, plus
 * HandleFlyWarpOrDungeonWarp / PrepareForSpecialWarp (home/overworld.asm,
 * engine/overworld/special_warps.asm).
 */
import type { Co, Engine } from '../engine/Engine';
import type { Facing } from '../world/movement';
import { c } from '../rom/constants';

/** The player's screen position during these animations: normally x $40, y $3c. */
const NORMAL_X = 0x40;
const NORMAL_Y = 0x3c;
/** GetPlayerTeleportAnimFrameDelay: 3 frames on a (Super) Game Boy Color without SGB. */
const TELEPORT_FRAME_DELAY = 3;

/** PlayerSpinningFacingOrder */
const SPIN_ORDER: Facing[] = ['down', 'left', 'up', 'right'];

/** FlyAnimationEnterScreenCoords / ScreenCoords1 / ScreenCoords2: [y, x] */
const FLY_ENTER = [[0x05, 0x98], [0x0f, 0x90], [0x18, 0x88], [0x20, 0x80], [0x27, 0x78], [0x2d, 0x70], [0x32, 0x68], [0x36, 0x60], [0x39, 0x58], [0x3b, 0x50], [0x3c, 0x48], [0x3c, 0x40]];
const FLY_1 = [[0x3c, 0x48], [0x3c, 0x50], [0x3b, 0x58], [0x3a, 0x60], [0x39, 0x68], [0x37, 0x70], [0x37, 0x78], [0x33, 0x80], [0x30, 0x88], [0x2d, 0x90], [0x2a, 0x98], [0x27, 0xa0]];
const FLY_2 = [[0x1a, 0x90], [0x19, 0x80], [0x17, 0x70], [0x15, 0x60], [0x12, 0x50], [0x0f, 0x40], [0x0c, 0x30], [0x09, 0x20], [0x05, 0x10], [0x00, 0x00], [0xf0, 0x00]];

/** IsPlayerStandingOnWarpPadOrHole: 0 none, 1 warp pad, 2 hole. */
export function standingOnWarpPadOrHole(e: Engine): number {
  const p = e.state.player;
  const tile = e.world.collisionTile(p.x, p.y);
  return e.bundle.tileTables.warpPadsAndHoles.find((w) => w.tileset === e.world.data.tileset && w.tile === tile)?.kind ?? 0;
}

function anim(e: Engine) {
  return (e.ram.playerAnim ??= { y: NORMAL_Y, x: NORMAL_X, facing: e.state.player.facing });
}

/** InitFacingDirectionList: the spin starts from the current facing. */
function spinner(e: Engine) {
  let i = SPIN_ORDER.indexOf(e.state.player.facing);
  return () => {
    anim(e).facing = SPIN_ORDER[i];
    i = (i + 1) & 3;
  };
}

/** PlayerSpinInPlace */
function* spinInPlace(e: Engine, spin: () => void, delay: number, delta: number, end: number, sound?: string): Co {
  for (;;) {
    spin();
    if ((delay & 3) === 0 && sound) e.env.playSound(sound);
    delay = (delay + delta) & 0xff;
    if (delay === end) return;
    yield* e.delayFrames(delay);
  }
}

/** PlayerSpinWhileMovingUpOrDown */
function* spinWhileMoving(e: Engine, spin: () => void, dy: number, maxY: number): Co {
  for (;;) {
    spin();
    const a = anim(e);
    a.y = (a.y + dy) & 0xff;
    if (a.y === maxY) return;
    yield* e.delayFrames(TELEPORT_FRAME_DELAY);
  }
}

/** DoFlyAnimation: the bird flaps (image index xor 1) every 3 frames, optionally along a path. */
function* flyAnimation(e: Engine, facing: Facing, count: number, path?: number[][]): Co {
  const a = anim(e);
  a.bird = true;
  a.facing = facing;
  for (let i = 0; i < count; i++) {
    a.flap = !a.flap;
    yield* e.delayFrames(3);
    if (path) [a.y, a.x] = path[i];
  }
}

function* fadeToWhite(e: Engine): Co {
  for (let i = 0; i <= 8; i++) {
    e.hooks.fade?.(i / 8, 'white');
    yield;
  }
}
function* fadeFromWhite(e: Engine): Co {
  for (let i = 8; i >= 0; i--) {
    e.hooks.fade?.(i / 8, 'white');
    yield;
  }
}

/** _LeaveMapAnim */
export function* leaveMapAnim(e: Engine): Co {
  e.setPikachuHidden(true); // Func_1510
  const spin = spinner(e);
  const pad = standingOnWarpPadOrHole(e);
  if (pad === 2) {
    // LeaveMapThroughHoleAnim: the upper half drops 8 px, then disappears
    anim(e).y = NORMAL_Y + 8;
    anim(e).halfHidden = true;
    yield* e.delayFrames(2);
    anim(e).hidden = true;
    yield* fadeToWhite(e);
    return restore(e);
  }
  if (pad === 0) {
    e.stopAllMusic();
    if (!e.ram.escapeWarp) {
      // the bird flaps in place, then flies off
      yield* flyAnimation(e, 'right', 8);
      e.env.playSound('fly');
      yield* flyAnimation(e, 'right', 12, FLY_1);
      yield* e.delayFrames(40);
      yield* flyAnimation(e, 'left', 11, FLY_2);
      yield* fadeToWhite(e);
      return restore(e);
    }
    // going to the last Pokémon Center: spin faster and faster in place
    yield* spinInPlace(e, spin, 16, -1, 0, 'teleport_exit2');
  }
  // .spinWhileMovingUp
  e.env.playSound('teleport_exit1');
  yield* spinWhileMoving(e, spin, -0x10, 0xec);
  if (pad !== 1) yield* e.delayFrames(10);
  yield* fadeToWhite(e);
  restore(e);
}

/** EnterMapAnim (after a Fly, dungeon or teleport warp) */
export function* enterMapAnim(e: Engine): Co {
  const spin = spinner(e);
  anim(e).y = 0xec;
  yield* e.delayFrames(3);
  yield* fadeFromWhite(e);
  if (e.ram.usedFly) {
    e.ram.usedFly = false;
    e.env.playSound('fly');
    yield* flyAnimation(e, 'left', 12, FLY_ENTER);
    e.pikachu.spawnState = 1;
    e.playDefaultMusic();
  } else {
    e.env.playSound('teleport_enter1');
    if (e.ram.dungeonWarp) {
      yield* e.delayFrames(50);
      yield* spinWhileMoving(e, spin, 0x10, NORMAL_Y);
      e.pikachu.spawnState = 0;
    } else {
      yield* spinWhileMoving(e, spin, 0x10, NORMAL_Y);
      e.env.playSound('teleport_enter2');
      if (!standingOnWarpPadOrHole(e)) {
        yield* spinInPlace(e, spin, 0, 1, 8);
        e.pikachu.spawnState = 1;
        e.playDefaultMusic();
      }
    }
  }
  e.setPikachuHidden(false); // Func_151d
  restore(e);
}

/** RestoreFacingDirectionAndYScreenPos */
function restore(e: Engine): void {
  e.ram.playerAnim = undefined;
}

/** HandleFlyWarpOrDungeonWarp + PrepareForSpecialWarp + SpecialEnterMap */
export function* handleFlyWarpOrDungeonWarp(e: Engine): Co {
  e.updateSprites();
  yield* e.delayFrames(3);
  e.ram.battleResult = 0;
  e.ram.isInBattle = 0;
  e.ram.mapPalOffset = 0;
  e.ram.alwaysOnBike = false;
  yield* leaveMapAnim(e);
  // StopBikeSurf
  if (e.state.player.mode !== 'walk') {
    e.store.dispatch({ type: 'setMode', mode: 'walk' }, { undoable: false });
    if (e.ram.dungeonWarp) e.playDefaultMusic();
  }
  // LoadSpecialWarpData
  let map: number;
  let at: { x: number; y: number };
  if (e.ram.dungeonWarp) {
    e.ram.onDungeonWarp = false;
    map = e.ram.dungeonWarpDestinationMap;
    const d = e.bundle.specialWarps.dungeon.find((w) => w.map === map && w.warp === e.ram.whichDungeonWarp);
    if (!d) throw new Error(`no dungeon warp ${e.ram.whichDungeonWarp} to map ${map}`);
    at = d;
  } else {
    map = e.ram.escapeWarp ? (e.env.vars.wLastBlackoutMap ?? c('map', 'PALLET_TOWN')) : e.ram.destinationMap;
    e.ram.escapeWarp = false;
    const f = e.bundle.specialWarps.fly[map];
    if (!f) throw new Error(`no fly warp data for map ${map}`);
    at = f;
  }
  e.ram.destinationWarpId = 0xff; // exclude normal warps
  const lastMap = e.ram.dungeonWarp ? e.state.player.lastMap : map;
  e.store.dispatch({ type: 'setPosition', map, x: at.x, y: at.y, facing: 'down', lastMap }, { undoable: false });
  e.ram.walkCounter = 0;
  e.ram.standingOnDoor = false;
  yield* e.enterMap();
}

/** IsPlayerOnDungeonWarp (map scripts with holes): arms a dungeon warp when on one of `coords`. */
export function isPlayerOnDungeonWarp(e: Engine, coords: [number, number][]): void {
  e.ram.whichDungeonWarp = 0;
  if (e.ram.onDungeonWarp) return;
  const p = e.state.player;
  const i = coords.findIndex(([y, x]) => x === p.x && y === p.y);
  if (i < 0) return;
  e.ram.whichDungeonWarp = i + 1;
  e.ram.onDungeonWarp = true;
  e.ram.dungeonWarp = true;
}

/** The bird's sprite while flying */
export const BIRD_SPRITE = () => c('sprite', 'SPRITE_BIRD');
