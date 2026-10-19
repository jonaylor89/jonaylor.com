/** Port of scripts/MtMoonB2F.asm and MtMoonB2F_2.asm: the fossils, the super nerd and Jessie & James. */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_SELECT, PAD_START, PAD_UP } from '../../engine/pad';
import { FACING_LEFT, FACING_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP, NONE } from '../../engine/sprites';
import { checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle, engageMapTrainer, initBattleEnemyParameters, trainerText } from '../../engine/trainers';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_MTMOONB2F_${n}`);
const NERD = 'MTMOONB2F_SUPER_NERD';
const JESSIE = 'MTMOONB2F_JESSIE';
const JAMES = 'MTMOONB2F_JAMES';
const ALL_INPUT = PAD_BUTTONS | PAD_CTRL_PAD;
const gotFossil = (e: ScriptEnv) => e.checkEvent('EVENT_GOT_DOME_FOSSIL') || e.checkEvent('EVENT_GOT_HELIX_FOSSIL');

/** MtMoonB2FResetScripts */
function resetScripts(e: ScriptEnv): void {
  if (e.checkEvent('EVENT_57E')) {
    e.resetEvent('EVENT_57E');
    e.hideObject('TOGGLE_MT_MOON_B2F_JESSIE');
    e.hideObject('TOGGLE_MT_MOON_B2F_JAMES');
  }
  e.joyIgnore = 0;
  e.curScript = 0;
}

function* showObject(e: ScriptEnv, toggle: string) {
  e.showObject(toggle);
  e.updateSprites();
  yield* e.delay3();
}

/** Two sprite slots get their movement status and facing set directly (wSpriteXXStateData1). */
function standFacing(e: ScriptEnv, slot: number, facing: number): void {
  const s = e.e.sprites[slot];
  if (!s) return;
  s.movementStatus = 2;
  s.facing = facing;
}

const scripts: ScriptFn[] = [
  // MtMoonB2FDefaultScript
  function* (e) {
    if (!gotFossil(e)) {
      // MtMoonB2FScript_49d28
      if (!e.checkEvent('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD') && e.y === 8 && e.x === 13) {
        e.joyHeld = 0;
        yield* e.displayTextID('TEXT_MTMOONB2F_SUPER_NERD');
      } else if (!gotFossil(e)) yield* checkFightingMapTrainers(e);
    }
    if (!e.checkEvent('EVENT_BEAT_MT_MOON_3_JESSIE_JAMES')) yield* jessieJamesAppear(e);
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  // MtMoonB2FDefeatedSuperNerdScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) return resetScripts(e);
    e.updateSprites();
    yield* e.delay3();
    e.setEvent('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD');
    e.joyIgnore = 0;
    e.curScript = S('DEFAULT');
  },
  // MtMoonB2FMoveSuperNerdScript
  function* (e) {
    e.sprite(NERD).movementByte2 = NONE; // SetSpriteMovementBytesToFF
    const at = (coords: [number, number][]) => e.arePlayerCoordsInArray(coords.map(([x, y]) => [y, x]));
    let path: number[];
    if (at([[12, 7]])) {
      yield* e.e.pikachu.tryApplyMovementData(FACING_RIGHT, [0x00, 0x35, 0x33, 0x3f], false);
      path = [NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP];
    } else if (at([[12, 7], [11, 6], [12, 5]])) path = [NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP];
    else if (at([[13, 7]])) {
      yield* e.e.pikachu.tryApplyMovementData(FACING_LEFT, [0x00, 0x35, 0x34, 0x3f], false);
      path = [NPC_MOVEMENT_UP];
    } else if (at([[13, 7], [14, 6], [14, 5]])) path = [NPC_MOVEMENT_UP];
    else {
      yield* checkFightingMapTrainers(e);
      return;
    }
    e.moveSprite(NERD, path);
    e.curScript = S('SUPER_NERD_TAKES_OTHER_FOSSIL');
  },
  // MtMoonB2FSuperNerdTakesOtherFossilScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = PAD_CTRL_PAD;
    e.doNotWaitForButtonPress = true;
    yield* e.displayTextID('TEXT_MTMOONB2F_SUPER_NERD_THEN_THIS_IS_MINE');
    e.hideObject(e.checkEvent('EVENT_GOT_HELIX_FOSSIL') ? 'TOGGLE_MT_MOON_B2F_FOSSIL_1' : 'TOGGLE_MT_MOON_B2F_FOSSIL_2');
    e.joyIgnore = 0;
    e.curScript = S('DEFAULT');
  },
  // MtMoonB2FScript6
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.simulatedIndex) return;
    yield* e.delay3();
    e.moveSprite(JESSIE, [0x06, 0x06, 0x06, 0x06, 0x06, 0x06]);
    e.joyIgnore = ALL_INPUT;
    e.curScript = S('SCRIPT7');
  },
  // MtMoonB2FScript7 (falls through to Script8 and Script9)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    yield* script8(e);
  },
  function* (e) {
    yield* script8(e);
  },
  function* (e) {
    yield* script9(e);
  },
  // MtMoonB2FScript10 (falls through to Script11 and Script12)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    yield* script11(e);
  },
  function* (e) {
    yield* script11(e);
  },
  function* (e) {
    script12(e);
  },
  // MtMoonB2FScript13
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.ram.isInBattle === 0xff) return resetScripts(e);
    standFacing(e, 2, 0);
    standFacing(e, 6, 0);
    e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
    e.doNotWaitForButtonPress = true;
    yield* e.displayTextID('TEXT_MTMOONB2F_TEXT14');
    e.doNotWaitForButtonPress = false;
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_JESSIE_JAMES');
    e.joyIgnore = ALL_INPUT;
    e.curScript = S('SCRIPT14');
  },
  // MtMoonB2FScript14
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    yield* e.fadeToBlack();
    e.hideObject('TOGGLE_MT_MOON_B2F_JESSIE');
    e.hideObject('TOGGLE_MT_MOON_B2F_JAMES');
    e.updateSprites();
    yield* e.delay3();
    yield* e.fadeFromBlack();
    e.curScript = S('SCRIPT15');
  },
  // MtMoonB2FScript15
  function* (e) {
    e.playDefaultMusic();
    e.joyHeld = 0;
    e.joyIgnore = 0;
    e.setEvent('EVENT_BEAT_MT_MOON_3_JESSIE_JAMES');
    e.resetEvent('EVENT_57E');
    e.curScript = S('DEFAULT');
  },
];

function* script8(e: ScriptEnv) {
  standFacing(e, 2, 0); // SPRITE_FACING_DOWN
  yield* script9(e);
}

function* script9(e: ScriptEnv) {
  e.moveSprite(JAMES, [0x06, 0x06, 0x06, 0x06, 0x06]);
  e.joyIgnore = ALL_INPUT;
  e.curScript = S('SCRIPT10');
}

function* script11(e: ScriptEnv) {
  standFacing(e, 6, FACING_LEFT);
  yield* e.delay3();
  e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
  yield* e.displayTextID('TEXT_MTMOONB2F_TEXT13');
  script12(e);
}

function script12(e: ScriptEnv): void {
  e.startTrainerBattle('OPP_ROCKET', 0x2a, 'MtMoonB2FJessieJamesEndBattleText', 'MtMoonB2FJessieJamesEndBattleText');
  e.joyHeld = 0;
  e.joyIgnore = 0;
  e.setEvent('EVENT_57E');
  e.curScript = S('SCRIPT13');
}

/** MtMoonB2FScript_49e15: Jessie & James block the exit. */
function* jessieJamesAppear(e: ScriptEnv) {
  if (e.x !== 3 || e.y !== 5) return;
  e.stopAllMusic();
  e.playMusic('MUSIC_MEET_JESSIE_JAMES');
  e.joyHeld = 0;
  e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
  yield* showObject(e, 'TOGGLE_MT_MOON_B2F_JESSIE');
  yield* showObject(e, 'TOGGLE_MT_MOON_B2F_JAMES');
  e.doNotWaitForButtonPress = true;
  yield* e.displayTextID('TEXT_MTMOONB2F_TEXT12');
  e.doNotWaitForButtonPress = false;
  e.setSimulatedJoypad([PAD_UP], 1);
  e.startSimulatingJoypadStates();
  e.joyIgnore = ALL_INPUT;
  e.curScript = S('SCRIPT6');
}

const fossil = (event: string, item: string, toggle: string, prompt: string): ScriptFn =>
  function* (e) {
    e.doNotWaitForButtonPress = true;
    yield* e.printText(prompt);
    if (!(yield* e.yesNoChoice())) return;
    if (!e.giveItem(item)) {
      yield* e.printText('MtMoonB2FYouHaveNoRoomText.Text');
      return;
    }
    yield* e.printText('MtMoonB2FReceivedFossilText.Text');
    e.hideObject(toggle);
    e.setEvent(event);
    e.curScript = S('MOVE_SUPER_NERD');
  };

export const MtMoonB2F: MapScript = {
  map: 'MT_MOON_B2F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    const fn = scripts[e.curScript];
    if (!fn) throw new Error(`MT_MOON_B2F: script index ${e.curScript} out of range`);
    yield* fn(e);
    if (!e.checkEvent('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD')) return;
    // no battles in the fossil area once the super nerd is beaten
    const inFossilArea = e.x >= 11 && e.x <= 14 && e.y >= 5 && e.y <= 8;
    e.noBattles = inFossilArea;
  },
  texts: {
    *MtMoonB2FText12(e) {
      yield* e.delayFrames(10);
      e.setPlayerMovingDirection('up');
      yield* e.emotionBubble(0, 'EXCLAMATION_BUBBLE');
      yield* e.delayFrames(20);
    },
    *MtMoonB2FText14(e) {
      yield* e.delayFrames(64);
    },
    *MtMoonB2FSuperNerdText(e) {
      if (e.checkEvent('EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD')) {
        yield* e.printText(gotFossil(e) ? 'MtMoonB2FSuperNerdTheresAPokemonLabText' : 'MtMoonB2fSuperNerdEachTakeOneText');
        return;
      }
      yield* e.printText('MtMoonB2FSuperNerdTheyreBothMineText');
      const r = e.ram;
      r.talkedToTrainer = true;
      r.printEndBattleText = true;
      r.endBattleWinText = 'MtMoonB2FSuperNerdOkIllShareText';
      r.endBattleLoseText = 'MtMoonB2FSuperNerdOkIllShareText';
      engageMapTrainer(e, e.spriteIndex);
      initBattleEnemyParameters(e);
      e.curScript = S('DEFEATED_SUPER_NERD');
    },
    MtMoonB2FRocket1Text: trainerText(0),
    MtMoonB2FRocket2Text: trainerText(1),
    MtMoonB2FRocket3Text: trainerText(2),
    MtMoonB2FDomeFossilText: fossil('EVENT_GOT_DOME_FOSSIL', 'DOME_FOSSIL', 'TOGGLE_MT_MOON_B2F_FOSSIL_1', 'MtMoonB2FDomeFossilText.YouWantText'),
    MtMoonB2FHelixFossilText: fossil('EVENT_GOT_HELIX_FOSSIL', 'HELIX_FOSSIL', 'TOGGLE_MT_MOON_B2F_FOSSIL_2', 'MtMoonB2FHelixFossilText.YouWantText'),
  },
};
