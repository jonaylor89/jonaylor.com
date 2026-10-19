/**
 * The Cycling Road gates (scripts/Route16Gate1F.asm, Route18Gate1F.asm): no
 * pedestrians without a BICYCLE; inside, BIT_ALWAYS_ON_BIKE is cleared.
 */
import type { MapScript, ScriptFn } from '../types';
import type { Co } from '../../engine/Engine';
import { PAD_CTRL_PAD, PAD_RIGHT, PAD_UP } from '../../engine/pad';
import { c } from '../../rom/constants';

function bikeGate(map: string, label: string, prefix: string, stopText: string, rows: number[], [bikeText, noBikeText]: [string, string]): MapScript {
  const S = (n: string) => c('map_script', `SCRIPT_${prefix}_${n}`);
  const T = (n: string) => `TEXT_${prefix}_${n}`;
  // the guard's speech, then one step right toward the counter
  const guard = function* (e: Parameters<ScriptFn>[0]): Co {
    yield* e.displayTextID(T('GUARD'));
    e.setSimulatedJoypad([PAD_RIGHT], 1);
    e.startSimulatingJoypadStates();
    e.curScript = S('PLAYER_MOVING_RIGHT');
  };
  const scripts: ScriptFn[] = [
    // DefaultScript
    function* (e) {
      if (e.isItemInBag('BICYCLE')) return;
      const i = e.arePlayerCoordsInArray(rows.map((y) => [y, 4] as [number, number]));
      if (!i) return;
      yield* e.displayTextID(T(stopText));
      e.joyHeld = 0;
      if (i === 1) {
        e.curScript = S('GUARD');
        return;
      }
      // walk up to the counter row
      e.setSimulatedJoypad(new Array(i - 1).fill(PAD_UP), i - 1);
      e.startSimulatingJoypadStates();
      e.curScript = S('PLAYER_MOVING_UP');
    },
    // PlayerMovingUpScript, falling through to the guard
    function* (e) {
      if (e.simulatedIndex) return;
      e.joyIgnore = PAD_CTRL_PAD;
      yield* guard(e);
    },
    guard,
    // PlayerMovingRightScript
    function* (e) {
      if (e.simulatedIndex) return;
      e.joyIgnore = 0;
      e.e.ram.scriptedMovementState = false;
      e.curScript = S('DEFAULT');
    },
  ];
  return {
    map,
    *run(e) {
      e.e.ram.alwaysOnBike = false;
      e.enableAutoTextBoxDrawing();
      const fn = scripts[e.curScript];
      if (!fn) throw new Error(`${map} script ${e.curScript}`);
      yield* fn(e);
    },
    texts: {
      *[`${label}GuardText`](e) {
        const T2 = (n: string) => `${label}GuardText.${n}`;
        yield* e.printText(T2(e.isItemInBag('BICYCLE') ? bikeText : noBikeText));
      },
    },
  };
}

export const Route16Gate1F = bikeGate('ROUTE_16_GATE_1F', 'Route16Gate1F', 'ROUTE16GATE1F', 'GUARD_WAIT_UP', [7, 8, 9, 10], ['CyclingRoadExplanationText', 'NoPedestriansAllowedText']);
export const Route18Gate1F = bikeGate('ROUTE_18_GATE_1F', 'Route18Gate1F', 'ROUTE18GATE1F', 'GUARD_EXCUSE_ME', [3, 4, 5, 6], ['CyclingRoadUphillText', 'YouNeedABicycleText']);
