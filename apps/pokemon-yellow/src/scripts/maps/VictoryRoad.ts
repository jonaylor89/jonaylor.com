/**
 * Victory Road (scripts/VictoryRoad1F.asm … 3F.asm): boulders on the floor
 * switches open the way (ReplaceTileBlock), and 3F's hole drops a boulder to 2F.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { c } from '../../rom/constants';
import { checkFightingMapTrainers, trainerMapScript } from '../../engine/trainers';
import { isPlayerOnDungeonWarp } from '../../field/warpAnims';

/** CheckBoulderCoords: index (1-based) of `coords` ([y, x]) the sprite in hSpriteIndex stands on, else 0. */
function boulderOn(e: ScriptEnv, coords: [number, number][]): number {
  const s = e.e.sprites[e.ram.spriteIndex];
  if (!s) return 0;
  return coords.findIndex(([y, x]) => s.mapX === x && s.mapY === y) + 1;
}
const isPikachu = (e: ScriptEnv) => e.ram.spriteIndex === e.e.pikachuSlot;

/** A trainer map whose first script also watches a boulder switch; `onLoad` runs on BIT_CUR_MAP_LOADED_*. */
function switchMap(map: string, onLoad: (e: ScriptEnv) => void, first: ScriptFn, loaded2?: (e: ScriptEnv) => void): MapScript {
  const base = trainerMapScript(map);
  return {
    map,
    *run(e) {
      if (loaded2 && e.takeMapLoaded2()) loaded2(e);
      if (e.takeMapLoaded1()) onLoad(e);
      if (e.curScript === 0) {
        e.enableAutoTextBoxDrawing();
        return yield* first(e);
      }
      yield* base.run!(e);
    },
  };
}

export const VictoryRoad1F = switchMap(
  'VICTORY_ROAD_1F',
  (e) => {
    if (e.checkEvent('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH')) e.e.world.replaceBlock(4, 6, 0x1d);
  },
  function* (e) {
    if (e.checkEvent('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH') || !boulderOn(e, [[13, 17]]) || isPikachu(e)) return yield* checkFightingMapTrainers(e);
    e.ram.curMapLoaded1 = true;
    e.setEvent('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
  },
);

/** VictoryRoad2FCheckBoulderEventScript */
function vr2Blocks(e: ScriptEnv): void {
  if (e.checkEvent('EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1')) e.e.world.replaceBlock(3, 4, 0x15);
  if (e.checkEvent('EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2')) e.e.world.replaceBlock(11, 7, 0x1d);
}

export const VictoryRoad2F = switchMap(
  'VICTORY_ROAD_2F',
  vr2Blocks,
  function* (e) {
    const i = boulderOn(e, [[16, 1], [16, 9]]);
    if (!i || isPikachu(e)) return yield* checkFightingMapTrainers(e);
    const ev = `EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH${i}`;
    if (e.checkEvent(ev)) return;
    e.setEvent(ev);
    e.ram.curMapLoaded1 = true;
  },
  // VictoryRoad2FResetBoulderEventScript, then the block check
  (e) => {
    e.resetEvent('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
    vr2Blocks(e);
  },
);

const VR3_SWITCH_HOLE: [number, number][] = [[5, 3], [15, 23]];
export const VictoryRoad3F = switchMap(
  'VICTORY_ROAD_3F',
  (e) => {
    if (e.checkEvent('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1')) e.e.world.replaceBlock(3, 5, 0x1d);
  },
  function* (e) {
    if (e.ram.pushedBoulder) {
      e.ram.pushedBoulder = false;
      const i = boulderOn(e, VR3_SWITCH_HOLE);
      if (i === 1 && !isPikachu(e)) {
        e.ram.curMapLoaded1 = true;
        e.setEvent('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1');
        return;
      }
      if (i === 2 && !e.checkEvent('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2')) {
        e.setEvent('EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2');
        e.hideObject('TOGGLE_VICTORY_ROAD_3F_BOULDER');
        e.showObject('TOGGLE_VICTORY_ROAD_2F_BOULDER');
        return;
      }
    }
    // .check_switch_hole: the hole is a dungeon warp, the switch square isn't
    e.ram.dungeonWarpDestinationMap = c('map', 'VICTORY_ROAD_2F');
    const wasOn = e.ram.onDungeonWarp;
    isPlayerOnDungeonWarp(e.e, VR3_SWITCH_HOLE);
    const p = e.e.state.player;
    if (!wasOn && p.x === 3 && p.y === 5) {
      e.ram.onDungeonWarp = false;
      e.ram.dungeonWarp = false;
      return;
    }
    if (!e.ram.onDungeonWarp) yield* checkFightingMapTrainers(e);
  },
);
