/**
 * The Rocket Hideout under the Game Corner: scripts/RocketHideoutB1F.asm (the door
 * that opens once the last B1F grunt is beaten), RocketHideoutB2F/B3F.asm (arrow
 * tiles) and RocketHideoutB4F.asm (Jessie & James, then Giovanni and the Silph Scope).
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_SELECT, PAD_START } from '../../engine/pad';
import { FACING_DOWN, FACING_LEFT, FACING_RIGHT } from '../../engine/sprites';
import {
  checkFightingMapTrainers,
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  engageMapTrainer,
  initBattleEnemyParameters,
  talkToTrainer,
} from '../../engine/trainers';
import { playerSpinning, spinnerDefault } from '../spinners';
import { c } from '../../rom/constants';

export const RocketHideoutB1F: MapScript = {
  map: 'ROCKET_HIDEOUT_B1F',
  *run(e) {
    // RocketHideoutB1FDoorCallbackScript
    if (e.takeMapLoaded1()) {
      let block = 0x54; // door
      if (e.checkEvent('EVENT_ENTERED_ROCKET_HIDEOUT')) block = 0x0e;
      else if (e.checkEvent('EVENT_BEAT_ROCKET_HIDEOUT_1_TRAINER_4')) {
        // BUG (kept): the event is only checked, never set, so this plays on every entry
        e.playSound('go_inside');
        block = 0x0e;
      }
      e.e.world.replaceBlock(12, 8, block);
    }
    e.enableAutoTextBoxDrawing();
    yield* [checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle][e.curScript](e);
  },
};

const spinnerMap = (map: string, table: string, label: string): MapScript => {
  const scripts: ScriptFn[] = [
    spinnerDefault(table, () => c('map_script', `SCRIPT_${label}_PLAYER_SPINNING`)),
    displayEnemyTrainerTextAndStartBattle,
    endTrainerBattle,
    playerSpinning,
  ];
  return {
    map,
    *run(e) {
      e.enableAutoTextBoxDrawing();
      yield* scripts[e.curScript](e);
    },
  };
};

export const RocketHideoutB2F = spinnerMap('ROCKET_HIDEOUT_B2F', 'RocketHideout2', 'ROCKETHIDEOUTB2F');
export const RocketHideoutB3F = spinnerMap('ROCKET_HIDEOUT_B3F', 'RocketHideout3', 'ROCKETHIDEOUTB3F');

// ------------------------------------------------------------------ B4F
const S = (n: string) => c('map_script', `SCRIPT_ROCKETHIDEOUTB4F_${n}`);
const ALL_INPUT = PAD_BUTTONS | PAD_CTRL_PAD;
const NO_PAD = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
const onLeft = (e: ScriptEnv) => e.checkEvent('EVENT_ROCKET_HIDEOUT_4_JESSIE_JAMES_ON_LEFT');
const JAMES_SLOT = 2;
const JESSIE_SLOT = 3;

function standFacing(e: ScriptEnv, slot: number, facing: number): void {
  const s = e.e.sprites[slot];
  if (!s) return;
  s.movementStatus = 2;
  s.facing = facing;
}

/** RocketHideoutB4FResetScripts */
function resetScripts(e: ScriptEnv): void {
  if (e.checkEvent('EVENT_6A0')) {
    e.resetEvent('EVENT_6A0');
    e.hideObject('TOGGLE_ROCKET_HIDEOUT_B4F_JAMES');
    e.hideObject('TOGGLE_ROCKET_HIDEOUT_B4F_JESSIE');
  }
  e.joyIgnore = 0;
  e.curScript = 0;
}

function* showObject(e: ScriptEnv, toggle: string) {
  e.showObject(toggle);
  e.updateSprites();
  yield* e.delay3();
}

/** RocketHideoutB4FScript_455a5: Jessie & James appear when the player reaches row 14. */
function* jessieJamesAppear(e: ScriptEnv) {
  if (e.y !== 14) return;
  e.resetEvent('EVENT_ROCKET_HIDEOUT_4_JESSIE_JAMES_ON_LEFT');
  if (e.x !== 24) {
    if (e.x !== 25) return;
    e.setEvent('EVENT_ROCKET_HIDEOUT_4_JESSIE_JAMES_ON_LEFT');
  }
  e.joyHeld = 0;
  e.joyIgnore = NO_PAD;
  e.stopAllMusic();
  e.playMusic('MUSIC_MEET_JESSIE_JAMES');
  e.updateSprites();
  yield* e.delay3();
  e.updateSprites();
  yield* e.delay3();
  e.doNotWaitForButtonPress = true;
  yield* e.displayTextID('TEXT_ROCKETHIDEOUTB4F_TEXT11');
  e.doNotWaitForButtonPress = false;
  e.joyIgnore = ALL_INPUT;
  yield* showObject(e, 'TOGGLE_ROCKET_HIDEOUT_B4F_JAMES');
  yield* showObject(e, 'TOGGLE_ROCKET_HIDEOUT_B4F_JESSIE');
  e.curScript = S('SCRIPT4');
}

/** RocketHideoutB4FJessieJamesMovementData_45605 (4 steps down) and _45606 (3 steps). */
const MOVES_4 = [0x04, 0x04, 0x04, 0x04];
const MOVES_3 = [0x04, 0x04, 0x04];

function* script6(e: ScriptEnv) {
  standFacing(e, JAMES_SLOT, onLeft(e) ? FACING_DOWN : FACING_LEFT);
  yield* e.delay3();
  e.joyIgnore = NO_PAD;
  yield* script7(e);
}

function* script7(e: ScriptEnv) {
  e.moveSprite('ROCKETHIDEOUTB4F_JESSIE', onLeft(e) ? MOVES_4 : MOVES_3);
  e.joyIgnore = ALL_INPUT;
  e.curScript = S('SCRIPT8');
}

function* script9(e: ScriptEnv) {
  standFacing(e, JESSIE_SLOT, onLeft(e) ? FACING_RIGHT : FACING_DOWN);
  yield* e.delay3();
  yield* e.displayTextID('TEXT_ROCKETHIDEOUTB4F_TEXT12');
  script10(e);
}

function script10(e: ScriptEnv): void {
  e.startTrainerBattle('OPP_ROCKET', 0x2b, 'RocketHideoutB4FJessieJamesEndBattleText', 'RocketHideoutB4FJessieJamesEndBattleText');
  e.joyHeld = 0;
  e.joyIgnore = 0;
  e.setEvent('EVENT_6A0');
  e.curScript = S('SCRIPT11');
}

const b4fScripts: ScriptFn[] = [
  // RocketHideoutB4FDefaultScript
  function* (e) {
    if (!e.checkEvent('EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES')) yield* jessieJamesAppear(e);
    if (!e.checkEvent('EVENT_BEAT_ROCKET_HIDEOUT_4_TRAINER_2')) yield* checkFightingMapTrainers(e);
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  // RocketHideoutB4FBeatGiovanniScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) return resetScripts(e);
    e.joyIgnore = NO_PAD;
    e.setEvent('EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI');
    yield* e.displayTextID('TEXT_ROCKETHIDEOUTB4F_GIOVANNI_HOPE_WE_MEET_AGAIN');
    yield* e.fadeToBlack();
    e.hideObject('TOGGLE_ROCKET_HIDEOUT_B4F_GIOVANNI');
    e.showObject('TOGGLE_ROCKET_HIDEOUT_B4F_ITEM_4');
    e.updateSprites();
    yield* e.fadeFromBlack();
    e.joyIgnore = 0;
    e.e.ram.curMapLoaded1 = true;
    e.curScript = S('DEFAULT');
  },
  // RocketHideoutB4FScript4: James walks down
  function* (e) {
    e.moveSprite('ROCKETHIDEOUTB4F_JAMES', onLeft(e) ? MOVES_3 : MOVES_4);
    e.joyIgnore = ALL_INPUT;
    e.curScript = S('SCRIPT5');
  },
  // RocketHideoutB4FScript5 (falls through to 6 and 7)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    yield* script6(e);
  },
  script6,
  script7,
  // RocketHideoutB4FScript8 (falls through to 9 and 10)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    e.joyIgnore = NO_PAD;
    yield* script9(e);
  },
  script9,
  function* (e) {
    script10(e);
  },
  // RocketHideoutB4FScript11
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.ram.isInBattle === 0xff) return resetScripts(e);
    standFacing(e, JAMES_SLOT, FACING_DOWN);
    standFacing(e, JESSIE_SLOT, FACING_DOWN);
    e.joyIgnore = NO_PAD;
    e.doNotWaitForButtonPress = true;
    yield* e.displayTextID('TEXT_ROCKETHIDEOUTB4F_TEXT13');
    e.doNotWaitForButtonPress = false;
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_JESSIE_JAMES');
    e.joyIgnore = ALL_INPUT;
    e.curScript = S('SCRIPT12');
  },
  // RocketHideoutB4FScript12
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    yield* e.fadeToBlack();
    e.hideObject('TOGGLE_ROCKET_HIDEOUT_B4F_JAMES');
    e.hideObject('TOGGLE_ROCKET_HIDEOUT_B4F_JESSIE');
    e.updateSprites();
    yield* e.delay3();
    yield* e.fadeFromBlack();
    e.curScript = S('SCRIPT13');
  },
  // RocketHideoutB4FScript13
  function* (e) {
    e.playDefaultMusic();
    e.joyHeld = 0;
    e.joyIgnore = 0;
    e.setEvent('EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES');
    e.curScript = S('DEFAULT');
  },
];

export const RocketHideoutB4F: MapScript = {
  map: 'ROCKET_HIDEOUT_B4F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    const fn = b4fScripts[e.curScript];
    if (!fn) throw new Error(`ROCKET_HIDEOUT_B4F: script index ${e.curScript} out of range`);
    yield* fn(e);
  },
  texts: {
    *RocketHideoutB4FText11(e) {
      yield* e.delayFrames(10);
      e.setPlayerMovingDirection('up');
      yield* e.emotionBubble(0, 'EXCLAMATION_BUBBLE');
      yield* e.delayFrames(20);
    },
    *RocketHideoutB4FText13(e) {
      yield* e.delayFrames(64);
    },
    *RocketHideoutB4FGiovanniText(e) {
      if (e.checkEvent('EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI')) return yield* e.printText('RocketHideoutB4FGiovanniHopeWeMeetAgainText');
      yield* e.printText('RocketHideoutB4FGiovanniText.ImpressedYouGotHereText');
      const r = e.ram;
      r.talkedToTrainer = true;
      r.printEndBattleText = true;
      r.endBattleWinText = 'RocketHideoutB4FGiovanniText.WhatCannotBeText';
      r.endBattleLoseText = 'RocketHideoutB4FGiovanniText.WhatCannotBeText';
      engageMapTrainer(e, e.spriteIndex);
      initBattleEnemyParameters(e);
      e.joyHeld = 0;
      e.curScript = S('BEAT_GIOVANNI');
    },
    *RocketHideoutB4FRocketText(e) {
      yield* talkToTrainer(e, 0);
    },
    *RocketHideoutB4FRocketEndBattleText(e) {
      e.setEvent('EVENT_ROCKET_DROPPED_LIFT_KEY');
      e.showObject('TOGGLE_ROCKET_HIDEOUT_B4F_ITEM_5');
    },
  },
};
