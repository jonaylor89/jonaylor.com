/**
 * Spinner (arrow) tiles: DecodeArrowMovementRLE (home/map_objects.asm) starts a
 * simulated slide; LoadSpinnerArrowTiles (engine/overworld/spinners.asm) turns
 * the player each frame of it (SpinnerPlayerFacingDirections).
 */
import type { ScriptFn } from './types';
import type { ScriptEnv } from '../engine/ScriptEnv';
import type { Facing } from '../world/movement';
import { PAD_BUTTONS, PAD_CTRL_PAD } from '../engine/pad';
import { checkFightingMapTrainers } from '../engine/trainers';

/** down → left → up → right → down */
export const NEXT_SPIN: Record<Facing, Facing> = { down: 'left', up: 'right', left: 'up', right: 'down' };

/** <Map>DefaultScript of a spinner map: on an arrow tile start sliding, else watch for trainers. */
export function spinnerDefault(table: string, spinningScript: () => number): ScriptFn {
  return function* (e) {
    const entry = e.e.bundle.misc.arrowTiles[table]?.find((t) => t.x === e.x && t.y === e.y);
    if (!entry) return yield* checkFightingMapTrainers(e);
    e.simulateRLE(entry.rle);
    e.startSimulatingJoypadStates();
    e.e.ram.spinning = true;
    e.playSound('arrow_tiles');
    e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
    e.curScript = spinningScript();
  };
}

/** <Map>PlayerSpinningScript */
export const playerSpinning: ScriptFn = function* (e: ScriptEnv) {
  if (e.simulatedIndex) {
    // LoadSpinnerArrowTiles: the next facing in the spin; arrow graphics alternate with the index
    e.setPlayerFacing(NEXT_SPIN[e.playerFacing]);
    e.e.ram.spinnerArrowsAnimated = (e.simulatedIndex & 1) !== 0;
    return;
  }
  e.joyIgnore = 0;
  e.e.ram.spinning = false;
  e.curScript = 0;
};
