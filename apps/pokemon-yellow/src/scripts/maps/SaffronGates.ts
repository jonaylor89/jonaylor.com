/**
 * The four gates into Saffron City (scripts/Route5Gate.asm … Route8Gate.asm):
 * the thirsty guard turns the player back until given a drink
 * (RemoveGuardDrink, engine/events/saffron_guards.asm).
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import type { Facing } from '../../world/movement';
import { PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_UP } from '../../engine/pad';
import { c } from '../../rom/constants';

const GAVE_DRINK = () => 1 << c('ram', 'BIT_GAVE_SAFFRON_GUARDS_DRINK');
const gaveDrink = (e: ScriptEnv) => (e.getVar('wStatusFlags1') & GAVE_DRINK()) !== 0;
const setGaveDrink = (e: ScriptEnv) => e.setVar('wStatusFlags1', e.getVar('wStatusFlags1') | GAVE_DRINK());

/** RemoveGuardDrink: the first drink in the bag (GuardDrinksList order) is taken; 0 if none. */
function removeGuardDrink(e: ScriptEnv): number {
  const drink = e.e.bundle.misc.guardDrinks.find((d) => e.e.state.bag.some((s) => s.item === d)) ?? 0;
  if (drink) e.e.store.dispatch({ type: 'takeItem', item: drink, qty: 1 }, { undoable: false });
  return drink;
}

/** <Gate>Move…Script: one simulated step back the way the player came. */
function pushBack(e: ScriptEnv, pad: number): void {
  e.setSimulatedJoypad([pad], 1);
  e.startSimulatingJoypadStates();
}

/** SaffronGateGuardText (shared; it sets Route 5 Gate's script, as in the original). */
export const saffronGateGuardText: ScriptFn = function* (e) {
  if (gaveDrink(e)) return yield* e.printText('SaffronGateGuardThanksForTheDrinkText');
  if (removeGuardDrink(e)) {
    yield* e.printText('SaffronGateGuardGiveDrinkText');
    setGaveDrink(e);
    return;
  }
  yield* e.printText('SaffronGateGuardGeeImThirstyText');
  pushBack(e, PAD_UP); // Route5GateMovePlayerUpScript
  e.setMapScript('ROUTE_5_GATE', 'SCRIPT_ROUTE5GATE_PLAYER_MOVING');
};

interface Gate {
  map: string;
  /** script-constant prefix, e.g. ROUTE5GATE (Route 7's are ROUTE7GATE too) */
  prefix: string;
  /** dbmapcoord pairs as [y, x] */
  coords: [number, number][];
  facing: Facing;
  pushPad: number;
  /** some gates set the flag before the text, others after */
  flagFirst: boolean;
}

function gate(g: Gate): MapScript {
  const T = (n: string) => `TEXT_${g.prefix}_GUARD_${n}`;
  const S = (n: string) => c('map_script', `SCRIPT_${g.prefix}_${n}`);
  const scripts: ScriptFn[] = [
    // DefaultScript
    function* (e): Co {
      if (gaveDrink(e)) return;
      if (!e.arePlayerCoordsInArray(g.coords)) return;
      e.setPlayerMovingDirection(g.facing);
      e.joyHeld = 0;
      if (removeGuardDrink(e)) {
        if (g.flagFirst) setGaveDrink(e);
        yield* e.displayTextID(T('GIVE_DRINK'));
        if (!g.flagFirst) setGaveDrink(e);
        return;
      }
      yield* e.displayTextID(T('GEE_IM_THIRSTY'));
      pushBack(e, g.pushPad);
      e.curScript = S('PLAYER_MOVING');
    },
    // PlayerMovingScript
    function* (e): Co {
      if (e.simulatedIndex) return;
      yield* e.delayFrames(3);
      e.joyIgnore = 0;
      e.curScript = S('DEFAULT');
    },
  ];
  return {
    map: g.map,
    *run(e) {
      e.enableAutoTextBoxDrawing();
      const fn = scripts[e.curScript];
      if (!fn) throw new Error(`${g.map} script ${e.curScript}`);
      yield* fn(e);
    },
  };
}

export const Route5Gate = gate({ map: 'ROUTE_5_GATE', prefix: 'ROUTE5GATE', coords: [[3, 3], [3, 4]], facing: 'left', pushPad: PAD_UP, flagFirst: false });
export const Route6Gate = gate({ map: 'ROUTE_6_GATE', prefix: 'ROUTE6GATE', coords: [[2, 3], [2, 4]], facing: 'right', pushPad: PAD_DOWN, flagFirst: true });
export const Route7Gate = gate({ map: 'ROUTE_7_GATE', prefix: 'ROUTE7GATE', coords: [[3, 3], [4, 3]], facing: 'up', pushPad: PAD_LEFT, flagFirst: false });
export const Route8Gate = gate({ map: 'ROUTE_8_GATE', prefix: 'ROUTE8GATE', coords: [[3, 2], [4, 2]], facing: 'up', pushPad: PAD_RIGHT, flagFirst: true });
