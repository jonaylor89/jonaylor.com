/**
 * The road to the Pokémon League: Route 22's gate (scripts/Route22Gate.asm,
 * BOULDERBADGE check) and Route 23's seven badge guards (scripts/Route23.asm).
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_DOWN } from '../../engine/pad';
import { c } from '../../rom/constants';
import { FACING_LEFT } from '../../engine/sprites';

/** <Map>MovePlayerDownScript */
function movePlayerDown(e: ScriptEnv): void {
  e.setSimulatedJoypad([PAD_DOWN], 1);
  e.setPlayerFacing('down');
  e.joyIgnore = 0;
  e.startSimulatingJoypadStates();
}

// ------------------------------------------------------------------ Route 22 gate
const G = (n: string) => c('map_script', `SCRIPT_ROUTE22GATE_${n}`);
const gateScripts: ScriptFn[] = [
  // Route22GateDefaultScript
  function* (e) {
    if (!e.arePlayerCoordsInArray([[2, 4], [2, 5]])) return;
    e.joyHeld = 0;
    e.sprite(1).facing = FACING_LEFT;
    yield* e.displayTextID('TEXT_ROUTE22GATE_GUARD');
  },
  // Route22GatePlayerMovingScript
  function* (e) {
    if (e.simulatedIndex) return;
    e.joyIgnore = 0;
    yield* e.delayFrames(3);
    e.curScript = G('DEFAULT');
  },
  // Route22GateNoopScript
  function* () {},
];

export const Route22Gate: MapScript = {
  map: 'ROUTE_22_GATE',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* gateScripts[e.curScript](e);
    // the north half leads to Route 23, the south half back to Route 22
    e.e.store.dispatch({ type: 'setLastMap', map: c('map', e.y < 4 ? 'ROUTE_23' : 'ROUTE_22') }, { undoable: false });
  },
  texts: {
    *Route22GateGuardText(e) {
      if (e.e.state.badges & (1 << c('ram', 'BIT_BOULDERBADGE'))) {
        yield* e.printText('Route22GateGuardGoRightAheadText');
        e.curScript = G('NOOP');
        return;
      }
      yield* e.printText('Route22GateGuardNoBoulderbadgeText');
      movePlayerDown(e);
      e.curScript = G('PLAYER_MOVING');
    },
  },
};

// ------------------------------------------------------------------ Route 23
const R = (n: string) => c('map_script', `SCRIPT_ROUTE23_${n}`);
/** BadgeTextPointers order: index 0 = CASCADEBADGE (badge bit index + 1) … 6 = EARTHBADGE */
const BADGE_TEXTS = ['CascadeBadgeText', 'ThunderBadgeText', 'RainbowBadgeText', 'SoulBadgeText', 'MarshBadgeText', 'VolcanoBadgeText', 'EarthBadgeText'];
/** Route23GuardsYCoords, guard 1 (Earth) first */
const GUARD_Y = [35, 56, 85, 96, 105, 119, 136];
const passedEvent = (badge: number) => c('event', 'EVENT_PASSED_CASCADEBADGE_CHECK') + badge;

/** Route23CopyBadgeTextScript */
function copyBadgeName(e: ScriptEnv, badge: number): void {
  e.e.ram.nameBuffer = e.e.bundle.strings[BADGE_TEXTS[badge]];
}

/** Route23CheckForBadgeScript */
function* checkForBadge(e: ScriptEnv, badge: number): Co {
  copyBadgeName(e, badge);
  if (!(e.e.state.badges & (1 << (badge + 1)))) {
    yield* e.printText('Route23YouDontHaveTheBadgeYetText');
    movePlayerDown(e);
    e.curScript = R('PLAYER_MOVING');
    return;
  }
  yield* e.printText('Route23OhThatIsTheBadgeText');
  e.e.store.dispatch({ type: 'setEvent', flag: passedEvent(badge), value: true }, { undoable: false });
  e.curScript = R('RESET_TO_DEFAULT');
}

const route23Scripts: ScriptFn[] = [
  // Route23DefaultScript: walking up to a guard whose badge wasn't checked yet
  function* (e) {
    const i = GUARD_Y.indexOf(e.y);
    if (i < 0) return;
    if (i === 0 && e.x >= 14) return; // past Victory Road's entrance
    const badge = 6 - i;
    if (e.checkEventFlag(passedEvent(badge))) return;
    copyBadgeName(e, badge);
    e.e.ram.spriteIndex = i + 1;
    yield* e.displayTextID(i + 1);
    e.joyHeld = 0;
  },
  // Route23PlayerMovingScript
  function* (e) {
    if (e.simulatedIndex) return;
    e.curScript = R('DEFAULT');
  },
  // Route23ResetToDefaultScript
  function* (e) {
    e.curScript = R('DEFAULT');
  },
];

/** Route23SetVictoryRoadBoulders, once per map load */
function setVictoryRoadBoulders(e: ScriptEnv): void {
  if (!e.takeMapLoaded2()) return;
  for (const ev of [
    'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1',
    'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2',
    'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1',
    'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2',
  ])
    e.resetEvent(ev);
  e.showObject('TOGGLE_VICTORY_ROAD_3F_BOULDER');
  e.hideObject('TOGGLE_VICTORY_ROAD_2F_BOULDER');
}

const guardText = (badge: number): ScriptFn =>
  function* (e) {
    yield* checkForBadge(e, badge);
  };

export const Route23: MapScript = {
  map: 'ROUTE_23',
  *run(e) {
    setVictoryRoadBoulders(e);
    e.enableAutoTextBoxDrawing();
    yield* route23Scripts[e.curScript](e);
  },
  texts: {
    Route23Guard1Text: guardText(6),
    Route23Guard2Text: guardText(5),
    Route23Swimmer1Text: guardText(4),
    Route23Swimmer2Text: guardText(3),
    Route23Guard3Text: guardText(2),
    Route23Guard4Text: guardText(1),
    Route23Guard5Text: guardText(0),
  },
};
