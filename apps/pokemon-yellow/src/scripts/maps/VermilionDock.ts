/**
 * Vermilion Dock (scripts/VermilionDock.asm): after HM01, coming off the
 * S.S. ANNE watches the ship sail away (the hull slides left while smoke puffs
 * drift), then the player walks back up the gangway.
 */
import type { MapScript } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_UP } from '../../engine/pad';

/** Tile $14 (water) and block $0d (open water) */
const WATER_TILE = 0x14;
const WATER_BLOCK = 0x0d;

/** VermilionDockSSAnneLeavesScript */
function* ssAnneLeaves(e: ScriptEnv): Co {
  e.setEvent('EVENT_SS_ANNE_LEFT');
  e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
  e.stopAllMusic();
  e.playMusic('MUSIC_SURFING');
  e.setPlayerFacing('down');
  yield* e.delayFrames(120);
  const world = e.e.world;
  const p = e.e.state.player;
  // screen rows 10-15 (the three squares below the player) become water, the ship slides off
  const region: [number, number, number, number] = [p.x - 4, p.y + 1, p.x + 6, p.y + 4];
  const ship = world.snapshot();
  for (let sy = region[1]; sy < region[3]; sy++)
    for (let sx = region[0]; sx < region[2]; sx++) for (let k = 0; k < 4; k++) world.overrideTile(sx * 2 + (k & 1), sy * 2 + (k >> 1), WATER_TILE);
  const slide = (e.e.ram.slide = { world: ship, region, dx: 0, puffs: [] as { x: number; y: number }[] });
  let smokeX = 88; // wSSAnneSmokeX
  yield* e.playSoundWaitForCurrent('ss_anne_horn');
  yield* e.delayFrames(30);
  // 8 steps of 16 px, each with 16 smoke drifts of 8 scanline-synced frames
  for (let step = 0; step < 8; step++) {
    // VermilionDock_EmitSmokePuff: a new puff above the front smokestack (screen x, y 100)
    smokeX -= 16;
    slide.puffs.push({ x: smokeX, y: 100 });
    for (let d = 0; d < 16; d++) {
      slide.dx = -(step * 16 + d);
      for (const puff of slide.puffs) puff.x += 2; // VermilionDock_AnimSmokePuffDriftRight
      yield* e.delayFrames(8);
    }
  }
  e.e.ram.slide = undefined;
  // VermilionDock_EraseSSAnne: the lower half of the ship's blocks become water too
  for (let bx = 5; bx <= 8; bx++) world.replaceBlock(bx, 2, WATER_BLOCK);
  e.playSound('ss_anne_horn');
  yield* e.delayFrames(120);
  // the dock's warp into the ship is gone (wNumberOfWarps - 1)
  world.numberOfWarps = world.data.warps.length - 1;
}

export const VermilionDock: MapScript = {
  map: 'VERMILION_DOCK',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    if (e.checkEvent('EVENT_STARTED_WALKING_OUT_OF_DOCK')) {
      if (e.checkEvent('EVENT_WALKED_OUT_OF_DOCK')) return;
      if (e.simulatedIndex) return;
      e.joyIgnore = 0;
      e.setEvent('EVENT_WALKED_OUT_OF_DOCK');
      return;
    }
    if (!e.checkEvent('EVENT_GOT_HM01')) return;
    if (e.ram.destinationWarpId !== 1) return;
    if (!e.checkEvent('EVENT_SS_ANNE_LEFT')) return yield* ssAnneLeaves(e);
    e.setEvent('EVENT_STARTED_WALKING_OUT_OF_DOCK');
    yield* e.delayFrames(3);
    e.setSimulatedJoypad([PAD_UP, PAD_UP, PAD_UP], 3);
    e.startSimulatingJoypadStates();
    e.joyIgnore = 0xff;
  },
};
