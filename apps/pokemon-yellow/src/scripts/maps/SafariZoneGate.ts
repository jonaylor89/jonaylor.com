/**
 * The Safari Zone entrance (scripts/SafariZoneGate.asm, SafariZoneGate_2.asm):
 * the ¥500 admission, Yellow's cut-price and free entries for the broke, and
 * leaving (early, or after the PA calls the game over).
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_DOWN, PAD_RIGHT, PAD_UP } from '../../engine/pad';
import { displayMoneyBox } from '../../ui/mart';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_SAFARIZONEGATE_${n}`);
const ALL_INPUT = PAD_BUTTONS | PAD_CTRL_PAD;
/** wSafariSteps after paying (or getting in cheap) */
const SAFARI_STEPS = 502;

/** SafariZoneEntranceAutoWalk: c simulated presses of one button */
function autoWalk(e: ScriptEnv, pad: number, n: number): void {
  e.setSimulatedJoypad(Array(n).fill(pad), n);
  e.startSimulatingJoypadStates();
}

/** SafariZoneGateReturnSimulatedJoypadStateScript: still walking? */
const walking = (e: ScriptEnv) => e.simulatedIndex !== 0;

function* wouldYouLikeToJoin(e: ScriptEnv) {
  e.joyHeld = 0;
  e.joyIgnore = 0;
  e.updateSprites();
  yield* e.displayTextID('TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1_WOULD_YOU_LIKE_TO_JOIN');
  e.joyIgnore = ALL_INPUT;
}

const scripts: ScriptFn[] = [
  // SafariZoneGateDefaultScript
  function* (e) {
    const i = e.arePlayerCoordsInArray([
      [2, 3],
      [2, 4],
    ]);
    if (!i) return;
    yield* e.displayTextID('TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1_1');
    e.joyIgnore = ALL_INPUT;
    e.joyHeld = 0;
    e.setPlayerFacing('right');
    if (i !== 1) {
      e.curScript = S('WOULD_YOU_LIKE_TO_JOIN');
      return;
    }
    autoWalk(e, PAD_RIGHT, 1);
    e.joyIgnore = PAD_CTRL_PAD;
    e.curScript = S('PLAYER_MOVING_RIGHT');
  },
  // SafariZoneGatePlayerMovingRightScript
  function* (e) {
    if (walking(e)) return;
    yield* wouldYouLikeToJoin(e);
  },
  wouldYouLikeToJoin,
  // SafariZoneGatePlayerMovingUpScript
  function* (e) {
    if (walking(e)) return;
    e.joyIgnore = 0;
    e.curScript = S('LEAVING_SAFARI');
  },
  // SafariZoneGatePlayerMovingDownScript
  function* (e) {
    if (walking(e)) return;
    e.joyIgnore = 0;
    e.curScript = S('DEFAULT');
  },
  // SafariZoneGateLeavingSafariScript
  function* (e) {
    e.setPlayerMovingDirection('down');
    if (!e.checkEvent('EVENT_SAFARI_GAME_OVER')) return yield* e.displayTextID('TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1_LEAVING_EARLY');
    e.resetEvent('EVENT_SAFARI_GAME_OVER');
    e.resetEvent('EVENT_IN_SAFARI_ZONE');
    e.updateSprites();
    e.joyIgnore = PAD_CTRL_PAD;
    yield* e.displayTextID('TEXT_SAFARIZONEGATE_SAFARI_ZONE_WORKER1_GOOD_HAUL_COME_AGAIN');
    e.setVar('wNumSafariBalls', 0);
    // only the high byte of wSafariSteps is cleared (twice)
    e.setVar('wSafariSteps', (e.vars.wSafariSteps ?? 0) & 0xff);
    autoWalk(e, PAD_DOWN, 3);
    e.curScript = S('PLAYER_MOVING_DOWN');
  },
  // SafariZoneGateSetScriptAfterMoveScript
  function* (e) {
    if (walking(e)) return;
    yield* e.delay3();
    e.curScript = e.vars.wNextSafariZoneGateScript ?? 0;
  },
];

/** SafariZoneEntranceGetLowCostAdmissionText (no money at all): the fourth visit gets one ball free. */
function* lowCostAdmissionWithNoMoney(e: ScriptEnv): Co<number | undefined> {
  const steps = e.vars.wSafariSteps ?? 0;
  const visits = steps >> 8; // wSafariSteps' high byte counts the attempts
  e.setVar('wSafariSteps', (steps + 0x100) & 0xffff);
  const texts = ['SafariZoneEntranceText_f210a', 'SafariZoneEntranceText_f210f', 'SafariZoneEntranceText_f2114', 'SafariZoneEntranceText_f2119', 'SafariZoneEntranceText_f2119'];
  yield* e.printText(texts[Math.min(visits, 4)]);
  if (visits !== 3) return undefined;
  yield* e.e.textCommandProcessor(e.e.bundle.texts.SafariZoneEntranceText_f20f6, 1, 14);
  return 1;
}

/** SafariZoneEntranceCalculateLowCostAdmission: all the player's money buys one ball per ¥23, plus one. */
function* lowCostAdmission(e: ScriptEnv): Co<number> {
  const money = e.e.state.money;
  const quotient = Math.floor(money / 23) % 100; // the quotient's last BCD byte
  e.e.store.dispatch({ type: 'addMoney', amount: -money }, { undoable: false });
  yield* e.e.textCommandProcessor(e.e.bundle.texts.SafariZoneEntranceText_f20c4, 1, 14);
  displayMoneyBox(e.e);
  yield* e.printText('SafariZoneEntranceText_f20c9');
  return Math.min(quotient + 1, 29);
}

/** SafariZoneGatePrintSafariZoneWorker1WouldYouLikeToJoinText */
function* worker1WouldYouLikeToJoin(e: ScriptEnv) {
  const T = (n: string) => `SafariZoneGatePrintSafariZoneWorker1WouldYouLikeToJoinText.${n}`;
  yield* e.printText(T('WelcomeText'));
  displayMoneyBox(e.e);
  const cantPay = () => {
    autoWalk(e, PAD_DOWN, 1);
    e.curScript = S('PLAYER_MOVING_DOWN');
  };
  if (!(yield* e.yesNoChoice())) {
    yield* e.printText(T('PleaseComeAgainText'));
    return cantPay();
  }
  let balls: number | undefined;
  if (e.e.state.money === 0) {
    balls = yield* lowCostAdmissionWithNoMoney(e);
    if (balls === undefined) return cantPay();
  } else if (e.e.state.money < 500) {
    yield* e.printText(T('NotEnoughMoneyText'));
    balls = yield* lowCostAdmission(e);
  } else {
    e.e.store.dispatch({ type: 'addMoney', amount: -500 }, { undoable: false });
    displayMoneyBox(e.e);
    yield* e.playSoundWaitForCurrent('purchase');
    yield* e.waitForSoundToFinish();
    e.e.ram.mem.set(0xcd3d, 500); // wPriceTemp
    yield* e.printText(T('MakePaymentText'));
    balls = 30;
  }
  e.setVar('wNumSafariBalls', balls);
  e.setVar('wSafariSteps', SAFARI_STEPS);
  autoWalk(e, PAD_UP, 3);
  e.setEvent('EVENT_IN_SAFARI_ZONE');
  e.resetEvent('EVENT_SAFARI_GAME_OVER');
  e.curScript = S('PLAYER_MOVING');
}

export const SafariZoneGate: MapScript = {
  map: 'SAFARI_ZONE_GATE',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    const fn = scripts[e.curScript];
    if (!fn) throw new Error(`SAFARI_ZONE_GATE: script index ${e.curScript} out of range`);
    yield* fn(e);
  },
  texts: {
    SafariZoneGateSafariZoneWorker1WouldYouLikeToJoinText: worker1WouldYouLikeToJoin,
    *SafariZoneGateSafariZoneWorker1LeavingEarlyText(e) {
      const T = (n: string) => `SafariZoneGateSafariZoneWorker1LeavingEarlyText.${n}`;
      if (yield* e.yesNoChoice()) {
        yield* e.printText(T('ReturnSafariBallsText'));
        e.setPlayerFacing('down');
        autoWalk(e, PAD_DOWN, 3);
        e.resetEvent('EVENT_SAFARI_GAME_OVER');
        e.resetEvent('EVENT_IN_SAFARI_ZONE');
        e.setVar('wNextSafariZoneGateScript', S('DEFAULT'));
      } else {
        yield* e.printText(T('GoodLuckText'));
        e.setPlayerFacing('up');
        autoWalk(e, PAD_UP, 1);
        e.setVar('wNextSafariZoneGateScript', S('LEAVING_SAFARI'));
      }
      e.curScript = S('SET_SCRIPT_AFTER_MOVE');
    },
    *SafariZoneGateSafariZoneWorker2Text(e) {
      const T = (n: string) => `SafariZoneGatePrintSafariZoneWorker2Text.${n}`;
      yield* e.printText(T('FirstTimeHereText'));
      yield* e.printText(T((yield* e.yesNoChoice()) ? 'SafariZoneExplanationText' : 'YoureARegularHereText'));
    },
  },
};
