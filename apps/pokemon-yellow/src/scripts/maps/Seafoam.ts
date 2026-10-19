/**
 * The Seafoam Islands (scripts/SeafoamIslands1F.asm … B4F.asm) and Route 20
 * (scripts/Route20.asm): boulders pushed down the holes reappear a floor
 * below; two boulders on B3F/B4F calm the currents; the holes themselves are
 * dungeon warps; Articuno waits on B4F.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_UP } from '../../engine/pad';
import { c } from '../../rom/constants';
import { isPlayerOnDungeonWarp } from '../../field/warpAnims';
import { endTrainerBattle, talkToTrainer, trainerMapScript } from '../../engine/trainers';

const LOST_BATTLE = 0xff;
const both = (e: ScriptEnv, a: string, b: string) => e.checkEvent(a) && e.checkEvent(b);

/**
 * The boulder-hole check shared by every floor: after a push (BIT_PUSHED_BOULDER), a
 * boulder on one of `holes` ([y, x]) falls through. Returns true when one did.
 */
function boulderFell(e: ScriptEnv, n: number, holes: [number, number][], below: [string, string], above: [string, string]): boolean {
  if (!e.ram.pushedBoulder) return false;
  e.ram.pushedBoulder = false;
  // CheckBoulderCoords: the pushed boulder's square (wBoulderSpriteIndex)
  const s = e.e.sprites[e.ram.boulderSpriteIndex];
  const i = s ? holes.findIndex(([y, x]) => s.mapX === x && s.mapY === y) : -1;
  if (i < 0) return false;
  e.setEvent(`EVENT_SEAFOAM${n}_BOULDER${i + 1}_DOWN_HOLE`);
  e.hideObject(above[i]);
  e.showObject(below[i]);
  return true;
}

function holeFloor(map: string, n: number, holes: [number, number][], above: [string, string], below: [string, string], nextMap: string, prelude?: (e: ScriptEnv) => void): MapScript {
  return {
    map,
    *run(e) {
      e.enableAutoTextBoxDrawing();
      prelude?.(e);
      if (e.ram.pushedBoulder) {
        boulderFell(e, n, holes, below, above);
        return;
      }
      e.ram.dungeonWarpDestinationMap = c('map', nextMap);
      isPlayerOnDungeonWarp(e.e, holes);
    },
  };
}

export const SeafoamIslands1F = holeFloor(
  'SEAFOAM_ISLANDS_1F',
  1,
  [[6, 17], [6, 24]],
  ['TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_2'],
  ['TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_2'],
  'SEAFOAM_ISLANDS_B1F',
  (e) => e.setEvent('EVENT_IN_SEAFOAM_ISLANDS'),
);
export const SeafoamIslandsB1F = holeFloor(
  'SEAFOAM_ISLANDS_B1F',
  2,
  [[6, 18], [6, 23]],
  ['TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_2'],
  ['TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_2'],
  'SEAFOAM_ISLANDS_B2F',
);
export const SeafoamIslandsB2F = holeFloor(
  'SEAFOAM_ISLANDS_B2F',
  3,
  [[6, 19], [6, 22]],
  ['TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B2F_BOULDER_2'],
  ['TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_3', 'TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_4'],
  'SEAFOAM_ISLANDS_B3F',
);

/** The current: simulated presses while surfing. */
function current(e: ScriptEnv, rle: number[]): void {
  e.simulateRLE(rle);
  e.startSimulatingJoypadStates();
}

// ------------------------------------------------------------------ B3F
const B3 = (s: string) => c('map_script', `SCRIPT_SEAFOAMISLANDSB3F_${s}`);
const SEAFOAM4_HOLES: [number, number][] = [[16, 3], [16, 6]];
const b3fScripts: ScriptFn[] = [
  // SeafoamIslandsB3FDefaultScript: a strong current near the steps
  function* (e) {
    if (!both(e, 'EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE')) return;
    if (e.y !== 8 || e.x !== 15) return;
    current(e, [PAD_DOWN, 6, PAD_RIGHT, 5, PAD_DOWN, 3]);
    e.ram.forcedWarp = true;
    e.curScript = B3('OBJECT_MOVING1');
  },
  // SeafoamIslandsB3FObjectMoving1Script
  function* (e) {
    if (e.simulatedIndex) return;
    e.curScript = B3('DEFAULT');
  },
  // SeafoamIslandsB3FMoveObjectScript (CheckForceBikeOrSurf: dropped in through a hole)
  function* (e) {
    if (!both(e, 'EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE')) return;
    let rle: number[];
    if (e.x === 18) rle = [PAD_DOWN, 6, PAD_RIGHT, 2, PAD_DOWN, 4];
    else if (e.x === 19) rle = [PAD_DOWN, 6, PAD_RIGHT, 2, PAD_DOWN, 4, PAD_LEFT, 1];
    else {
      e.curScript = B3('DEFAULT');
      return;
    }
    e.simulateRLE(rle);
    e.sprite(0).movementByte1 = 0;
    e.ram.scriptedMovementState = true;
    e.ram.forcedWarp = true;
    e.curScript = B3('OBJECT_MOVING2');
  },
  // SeafoamIslandsB3FObjectMoving2Script
  function* (e) {
    if (e.simulatedIndex) return;
    e.curScript = B3('DEFAULT');
  },
];

export const SeafoamIslandsB3F: MapScript = {
  map: 'SEAFOAM_ISLANDS_B3F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    if (e.ram.pushedBoulder) {
      if (!boulderFell(e, 4, SEAFOAM4_HOLES, ['TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_2'], ['TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_1', 'TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_2'])) return;
    } else {
      e.ram.dungeonWarpDestinationMap = c('map', 'SEAFOAM_ISLANDS_B4F');
      isPlayerOnDungeonWarp(e.e, SEAFOAM4_HOLES);
      if (e.ram.dungeonWarp) return;
    }
    yield* b3fScripts[e.curScript](e);
  },
};

// ------------------------------------------------------------------ B4F
const B4 = (s: string) => c('map_script', `SCRIPT_SEAFOAMISLANDSB4F_${s}`);
const b4fScripts: ScriptFn[] = [
  // SeafoamIslandsB4FDefaultScript: up out of the water at the surf exit
  function* (e) {
    if (!both(e, 'EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE')) return;
    const i = e.arePlayerCoordsInArray([[17, 20], [17, 21], [16, 20], [16, 21]]);
    if (!i) return;
    e.setSimulatedJoypad(i >= 3 ? [PAD_UP] : [PAD_UP, PAD_UP], i >= 3 ? 1 : 2);
    e.startSimulatingJoypadStates();
    e.ram.forcedWarp = false;
    e.curScript = B4('OBJECT_MOVING1');
  },
  // SeafoamIslandsB4FObjectMoving1Script
  function* (e) {
    if (e.simulatedIndex) return;
    e.joyIgnore = 0;
    e.curScript = B4('DEFAULT');
  },
  // SeafoamIslandsB4FMoveObjectScript: the strong current by the boulders
  function* (e) {
    if (!both(e, 'EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE')) {
      e.curScript = B4('DEFAULT');
      return;
    }
    const i = e.arePlayerCoordsInArray([[14, 4], [14, 5]]);
    if (!i) {
      e.curScript = B4('DEFAULT');
      return;
    }
    current(e, i === 1 ? [PAD_UP, 3, PAD_RIGHT, 3, PAD_UP, 1] : [PAD_UP, 3, PAD_RIGHT, 2, PAD_UP, 1]);
    e.curScript = B4('OBJECT_MOVING2');
  },
  // SeafoamIslandsB4FObjectMoving2Script: on the last press, back to walking
  function* (e) {
    if (e.simulatedIndex === 1) {
      e.e.store.dispatch({ type: 'setMode', mode: 'walk' }, { undoable: false });
      e.playDefaultMusic(); // ForceBikeOrSurf
    }
    if (e.simulatedIndex) return;
    e.curScript = B4('DEFAULT');
  },
  // SeafoamIslandsB4FObjectMoving3Script: after the Articuno battle
  function* (e) {
    if (e.ram.isInBattle === LOST_BATTLE) {
      e.joyIgnore = 0;
      e.curScript = B4('DEFAULT');
      return;
    }
    yield* endTrainerBattle(e);
    e.curScript = B4('DEFAULT');
  },
];

export const SeafoamIslandsB4F: MapScript = {
  map: 'SEAFOAM_ISLANDS_B4F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* b4fScripts[e.curScript](e);
  },
  texts: {
    *SeafoamIslandsB4FArticunoText(e) {
      yield* talkToTrainer(e, 0);
      e.curScript = B4('OBJECT_MOVING3');
    },
  },
};

// ------------------------------------------------------------------ Route 20
/** Route20BoulderScript: leaving the islands resets the boulders that fell. */
function route20Boulders(e: ScriptEnv): void {
  if (both(e, 'EVENT_SEAFOAM3_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM3_BOULDER2_DOWN_HOLE')) {
    e.showObject('TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_1');
    e.showObject('TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_2');
    for (const t of ['B1F_BOULDER_1', 'B1F_BOULDER_2', 'B2F_BOULDER_1', 'B2F_BOULDER_2', 'B3F_BOULDER_3', 'B3F_BOULDER_4']) e.hideObject(`TOGGLE_SEAFOAM_ISLANDS_${t}`);
  }
  if (both(e, 'EVENT_SEAFOAM4_BOULDER1_DOWN_HOLE', 'EVENT_SEAFOAM4_BOULDER2_DOWN_HOLE')) {
    e.showObject('TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_1');
    e.showObject('TOGGLE_SEAFOAM_ISLANDS_B3F_BOULDER_2');
    e.hideObject('TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_1');
    e.hideObject('TOGGLE_SEAFOAM_ISLANDS_B4F_BOULDER_2');
  }
}

const route20 = trainerMapScript('ROUTE_20');
export const Route20: MapScript = {
  ...route20,
  *run(e): Co {
    if (e.checkEvent('EVENT_IN_SEAFOAM_ISLANDS')) {
      e.resetEvent('EVENT_IN_SEAFOAM_ISLANDS');
      route20Boulders(e);
    }
    yield* route20.run!(e);
  },
};
