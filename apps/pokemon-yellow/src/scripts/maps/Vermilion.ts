/**
 * Vermilion City (scripts/VermilionCity.asm, VermilionCity_2.asm): the S.S.
 * ANNE ticket check at the harbor, the trash-can lock seed for Lt. Surge's
 * gym, and Officer Jenny's SQUIRTLE.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_UP } from '../../engine/pad';
import { FACING_DOWN, FACING_RIGHT } from '../../engine/sprites';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_VERMILIONCITY_${n}`);
/** SSAnneTicketCheckCoords */
const TICKET_CHECK: [number, number][] = [[30, 18]];

const scripts: ScriptFn[] = [
  // VermilionCityDefaultScript
  function* (e) {
    if (e.sprite(0).facing !== FACING_DOWN) return;
    if (!e.arePlayerCoordsInArray(TICKET_CHECK)) return;
    e.joyHeld = 0;
    e.setVar('wSavedCoordIndex', 0);
    yield* e.displayTextID('TEXT_VERMILIONCITY_SAILOR1');
    if (!e.checkEvent('EVENT_SS_ANNE_LEFT') && e.isItemInBag('S_S_TICKET')) return;
    e.setSimulatedJoypad([PAD_UP], 1);
    e.startSimulatingJoypadStates();
    e.curScript = S('PLAYER_MOVING_UP1');
  },
  // VermilionCityPlayerMovingUp1Script
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delayFrames(10);
    e.curScript = S('DEFAULT');
  },
  // VermilionCityPlayerExitShipScript: walked off the departed ship, two steps up
  function* (e) {
    e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
    e.setSimulatedJoypad([PAD_UP, PAD_UP], 2);
    e.startSimulatingJoypadStates();
    e.curScript = S('PLAYER_MOVING_UP2');
  },
  // VermilionCityPlayerMovingUp2Script
  function* (e) {
    if (e.simulatedIndex) return;
    e.joyIgnore = 0;
    e.joyHeld = 0;
    e.curScript = S('DEFAULT');
  },
  // VermilionCityPlayerAllowedToPassScript
  function* (e) {
    if (e.arePlayerCoordsInArray(TICKET_CHECK)) return;
    e.curScript = S('DEFAULT');
  },
];

/** VermilionCityLeftSSAnneCallbackScript */
function leftSSAnneCallback(e: ScriptEnv): void {
  if (!e.checkEvent('EVENT_SS_ANNE_LEFT')) return;
  if (e.checkEvent('EVENT_WALKED_PAST_GUARD_AFTER_SS_ANNE_LEFT')) return;
  e.setEvent('EVENT_WALKED_PAST_GUARD_AFTER_SS_ANNE_LEFT');
  e.curScript = S('PLAYER_EXIT_SHIP');
}

export const VermilionCity: MapScript = {
  map: 'VERMILION_CITY',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    e.e.ram.pikachuMapScriptActive = false;
    if (e.takeMapLoaded2()) leftSSAnneCallback(e);
    if (e.takeMapLoaded1()) {
      // .setFirstLockTrashCanIndex: (hRandomAdd + hRandomSub + carry) & $e
      e.e.random();
      const sum = e.e.rng.hRandomAdd + e.e.rng.hRandomSub;
      e.setVar('wFirstLockTrashCanIndex', (sum + e.e.rng.carry) & 0xe);
    }
    const fn = scripts[e.curScript];
    if (!fn) throw new Error(`VERMILION_CITY script ${e.curScript}`);
    yield* fn(e);
    // .vermilionCityScript_19869
    if (!e.checkEvent('EVENT_LEFT_FANCLUB_AFTER_BIKE_VOUCHER') && e.checkEvent('EVENT_GOT_BIKE_VOUCHER')) e.setEvent('EVENT_LEFT_FANCLUB_AFTER_BIKE_VOUCHER');
  },
  texts: {
    *VermilionCitySailor1Text(e): Co {
      const T = (n: string) => `VermilionCitySailor1Text.${n}`;
      if (e.checkEvent('EVENT_SS_ANNE_LEFT')) return yield* e.printText(T('ShipSetSailText'));
      // facing right, or in front of / behind the guard: just a greeting
      if (e.sprite(0).facing === FACING_RIGHT || e.arePlayerCoordsInArray([[29, 19], [31, 19]])) {
        return yield* e.printText(T('WelcomeToSSAnneText'));
      }
      yield* e.printText(T('DoYouHaveATicketText'));
      if (!e.isItemInBag('S_S_TICKET')) return yield* e.printText(T('YouNeedATicketText'));
      yield* e.printText(T('FlashedTicketText'));
      e.curScript = S('PLAYER_ALLOWED_TO_PASS');
    },
    // VermilionCityPrintOfficerJennyText
    *VermilionCityOfficerJennyText(e): Co {
      if (e.checkEvent('EVENT_GOT_SQUIRTLE_FROM_OFFICER_JENNY')) return yield* e.printText('OfficerJennyText5');
      if (!(e.getVar('wBeatGymFlags') & (1 << c('ram', 'BIT_THUNDERBADGE')))) return yield* e.printText('OfficerJennyText1');
      yield* e.printText('OfficerJennyText2');
      if (!(yield* e.yesNoChoice())) return yield* e.printText('OfficerJennyText4');
      e.getMonName(c('pokemon', 'SQUIRTLE'));
      e.doNotWaitForButtonPress = true;
      const before = e.e.state.party.length;
      if (!(yield* e.givePokemon('SQUIRTLE', 10))) return;
      if (e.e.state.party.length === before) yield* e.e.waitForTextScrollButtonPress();
      e.doNotWaitForButtonPress = true;
      yield* e.printText('OfficerJennyText3');
      e.setEvent('EVENT_GOT_SQUIRTLE_FROM_OFFICER_JENNY');
    },
  },
};
