/**
 * Cinnabar Gym (scripts/CinnabarGym.asm, CinnabarGym_2.asm, CinnabarGym_3.asm):
 * quiz gates (the quiz itself is the PrintCinnabarQuiz hidden event), the super
 * nerd who walks over to battle after a wrong answer, and Blaine.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_CTRL_PAD } from '../../engine/pad';
import { FACING_DOWN, FACING_RIGHT, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_UP } from '../../engine/sprites';
import { engageMapTrainer, initBattleEnemyParameters } from '../../engine/trainers';
import { updateCinnabarGymGateTileBlocks } from '../../engine/hiddenEvents';
import { loadGymNames, setEventRange } from '../gym';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_CINNABARGYM_${n}`);
const SUPER_NERD3 = 4;
const BLAINE = 1;
const ev = (n: string) => c('event', n);
const flag = (e: ScriptEnv, n: number) => !!(e.e.state.eventFlags[n >> 3] & (1 << (n & 7)));
const setFlag = (e: ScriptEnv, n: number) => e.e.store.dispatch({ type: 'setEvent', flag: n, value: true }, { undoable: false });

/** CinnabarGymResetScripts */
function resetScripts(e: ScriptEnv): void {
  e.joyIgnore = 0;
  e.curScript = 0;
  e.setVar('wOpponentAfterWrongAnswer', 0);
}

/** CinnabarGymScript_753e9: test and clear wd474 bit 7 (a wrong-answer battle) */
function takeQuizBattle(e: ScriptEnv): boolean {
  const v = e.e.ram.cinnabarQuizWrong;
  e.e.ram.cinnabarQuizWrong = false;
  return v;
}

/** CinnabarGymStartBattleScript */
function startBattle(e: ScriptEnv): void {
  engageMapTrainer(e, e.spriteIndex);
  initBattleEnemyParameters(e);
  e.ram.talkedToTrainer = true;
  e.ram.printEndBattleText = true;
  e.curScript = e.spriteIndex === BLAINE ? S('BLAINE_POST_BATTLE') : S('OPEN_GATE');
}

/** CinnabarGymScript_75041: unlock the trainer's gate and redraw the gates. */
function unlockGate(e: ScriptEnv, bit: number): void {
  setFlag(e, ev('EVENT_CINNABAR_GYM_GATE0_UNLOCKED') + bit - 2);
  updateCinnabarGymGateTileBlocks(e.e);
}

/** CinnabarGymReceiveTM38 */
function* receiveTM38(e: ScriptEnv) {
  yield* e.displayTextID('TEXT_CINNABARGYM_BLAINE_VOLCANO_BADGE_INFO');
  e.setEvent('EVENT_BEAT_BLAINE');
  if (e.giveItem('TM_FIRE_BLAST')) {
    yield* e.displayTextID('TEXT_CINNABARGYM_BLAINE_RECEIVED_TM38');
    e.setEvent('EVENT_GOT_TM38');
  } else yield* e.displayTextID('TEXT_CINNABARGYM_BLAINE_TM38_NO_ROOM');
  const bit = c('ram', 'BIT_VOLCANOBADGE');
  e.e.store.dispatch({ type: 'setBadge', badge: bit, value: true }, { undoable: false });
  e.setVar('wBeatGymFlags', e.getVar('wBeatGymFlags') | (1 << bit));
  setEventRange(e, 'EVENT_BEAT_CINNABAR_GYM_TRAINER_0', 'EVENT_BEAT_CINNABAR_GYM_TRAINER_6');
  e.e.ram.curMapLoaded1 = true;
  resetScripts(e);
}

const scripts: ScriptFn[] = [
  // CinnabarGymDefaultScript: after a wrong answer, that gate's trainer walks over
  function* (e) {
    const opp = e.getVar('wOpponentAfterWrongAnswer');
    if (!opp) return;
    e.e.ram.spriteIndex = opp; // hSpriteIndex
    const pika = e.e.pikachu;
    let path: number[];
    if (opp === SUPER_NERD3) {
      e.setPlayerMovingDirection('down');
      if (e.pikachuSpawnStarter && pika.directionFromPlayer() === FACING_DOWN) yield* pika.applyMovementData([0x00, 0x20, 0x1e, 0x35, 0x3f]);
      path = [NPC_MOVEMENT_LEFT, NPC_MOVEMENT_UP];
    } else {
      e.setPlayerMovingDirection('right');
      if (e.pikachuSpawnStarter && pika.directionFromPlayer() === FACING_RIGHT) yield* pika.applyMovementData([0x00, 0x1d, 0x1f, 0x38, 0x3f]);
      path = [NPC_MOVEMENT_LEFT];
    }
    e.moveSprite(opp, path);
    e.curScript = S('GET_OPPONENT_TEXT');
  },
  // CinnabarGymGetOpponentTextScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = 0;
    const opp = e.getVar('wOpponentAfterWrongAnswer');
    e.e.ram.trainerHeaderFlagBit = opp;
    yield* e.displayTextID(opp);
  },
  // CinnabarGymOpenGateScript
  function* (e) {
    takeQuizBattle(e);
    if (e.ram.isInBattle === 0xff) return resetScripts(e);
    const bit = e.e.ram.trainerHeaderFlagBit;
    const wasOpen = flag(e, ev('EVENT_CINNABAR_GYM_GATE0_UNLOCKED') + bit - 2);
    setFlag(e, ev('EVENT_BEAT_CINNABAR_GYM_TRAINER_0') + bit - 2); // CinnabarGymScript_75023
    if (!wasOpen && bit !== 2) {
      yield* e.delayFrames(30);
      unlockGate(e, bit);
      e.playSound('go_inside');
    } else unlockGate(e, bit);
    e.joyIgnore = 0;
    e.setVar('wOpponentAfterWrongAnswer', 0);
    e.curScript = S('DEFAULT');
  },
  // CinnabarGymBlainePostBattleScript
  function* (e) {
    takeQuizBattle(e);
    if (e.ram.isInBattle === 0xff) return resetScripts(e);
    e.joyIgnore = PAD_CTRL_PAD;
    yield* receiveTM38(e);
  },
];

/** CinnabarGymSuperNerd<n>: a quiz trainer (n = 1..7, sprite n + 1). */
const superNerd = (n: number): ScriptFn =>
  function* (e) {
    const T = (s: string) => `CinnabarGymSuperNerd${n}.${s}`;
    const bit = e.spriteIndex; // CinnabarGymSetTrainerHeader: wTrainerHeaderFlagBit = hTextID
    e.e.ram.trainerHeaderFlagBit = bit;
    if (flag(e, ev('EVENT_BEAT_CINNABAR_GYM_TRAINER_0') + n - 1)) return yield* e.printText(T('AfterBattleText'));
    // in Yellow, nerds 2-7 only fight after a wrong answer; until their gate opens they just talk
    if (n > 1 && !e.e.ram.cinnabarQuizWrong && !flag(e, ev('EVENT_CINNABAR_GYM_GATE0_UNLOCKED') + n - 1)) {
      const lines = ['CinnabarGymText_f2169', 'CinnabarGymText_f216e', 'CinnabarGymText_f2173', 'CinnabarGymText_f2178', 'CinnabarGymText_f217d', 'CinnabarGymText_f2182'];
      return yield* e.printText(lines[n - 2]);
    }
    yield* e.printText(T('BattleText'));
    e.ram.endBattleWinText = T('EndBattleText');
    e.ram.endBattleLoseText = T('EndBattleText');
    startBattle(e);
  };

export const CinnabarGym: MapScript = {
  map: 'CINNABAR_GYM',
  *run(e) {
    // CinnabarGymSetMapAndTiles
    loadGymNames(e, 'CinnabarGym', 2, 'CinnabarGymSetMapAndTiles');
    if (e.takeMapLoaded1()) updateCinnabarGymGateTileBlocks(e.e);
    e.resetEvent('EVENT_2A7');
    e.enableAutoTextBoxDrawing();
    yield* scripts[e.curScript](e);
  },
  texts: {
    *CinnabarGymBlaineText(e) {
      const T = (s: string) => `CinnabarGymBlaineText.${s}`;
      if (e.checkEvent('EVENT_BEAT_BLAINE')) {
        if (e.checkEvent('EVENT_GOT_TM38')) return yield* e.printText(T('PostBattleAdviceText'));
        yield* receiveTM38(e);
        e.doNotWaitForButtonPress = true;
        return;
      }
      yield* e.printText(T('PreBattleText'));
      e.ram.endBattleWinText = T('ReceivedVolcanoBadgeText');
      e.ram.endBattleLoseText = T('ReceivedVolcanoBadgeText');
      e.ram.gymLeaderNo = 7;
      startBattle(e);
    },
    CinnabarGymSuperNerd1: superNerd(1),
    CinnabarGymSuperNerd2: superNerd(2),
    CinnabarGymSuperNerd3: superNerd(3),
    CinnabarGymSuperNerd4: superNerd(4),
    CinnabarGymSuperNerd5: superNerd(5),
    CinnabarGymSuperNerd6: superNerd(6),
    CinnabarGymSuperNerd7: superNerd(7),
    *CinnabarGymGymGuideText(e) {
      yield* e.printText(e.checkEvent('EVENT_BEAT_BLAINE') ? 'CinnabarGymPrintGymGuideText.BeatBlaineText' : 'CinnabarGymPrintGymGuideText.ChampInMakingText');
    },
  },
};
