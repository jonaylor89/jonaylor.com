/** Port of scripts/Route22.asm and Route22_2.asm: the two rival battles at the League gate. */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_CTRL_PAD } from '../../engine/pad';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP } from '../../engine/sprites';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_ROUTE22_${n}`);
const RIVAL1 = 'ROUTE22_RIVAL1';
const RIVAL2 = 'ROUTE22_RIVAL2';
const LOST_BATTLE = 0xff;

/** Route22SetDefaultScript */
function setDefault(e: ScriptEnv): void {
  e.joyIgnore = 0;
  e.curScript = S('DEFAULT');
}

/** wSavedCoordIndex: 0 = upper square (29,4), 1 = lower square (29,5) */
const saved = (e: ScriptEnv) => e.getVar('wSavedCoordIndex');

/** Route22MoveRivalRightScript: one step fewer from the lower square. */
function* moveRivalRight(e: ScriptEnv, rival: string): Co {
  const steps = saved(e) === 1 ? 4 : 3;
  e.moveSprite(rival, new Array(steps).fill(NPC_MOVEMENT_RIGHT));
  yield* e.setSpriteFacingDirectionAndDelay(rival, 'right');
}

function* emotion(e: ScriptEnv, rival: string) {
  yield* e.emotionBubble(rival, 'EXCLAMATION_BUBBLE');
  if (e.e.state.player.mode !== 'walk') e.stopAllMusic();
}

const scripts: ScriptFn[] = [
  // Route22DefaultScript
  function* (e) {
    if (!e.checkEvent('EVENT_ROUTE22_RIVAL_WANTS_BATTLE')) return;
    const hit = e.arePlayerCoordsInArray([
      [4, 29],
      [5, 29],
    ]);
    if (!hit) return;
    e.setVar('wSavedCoordIndex', hit - 1);
    e.joyHeld = 0;
    e.joyIgnore = PAD_CTRL_PAD;
    e.setPlayerMovingDirection('left');
    if (e.checkEvent('EVENT_1ST_ROUTE22_RIVAL_BATTLE')) {
      // Route22FirstRivalBattleScript
      yield* emotion(e, RIVAL1);
      e.playMusic('MUSIC_MEET_RIVAL');
      yield* moveRivalRight(e, RIVAL1);
      e.curScript = S('RIVAL1_START_BATTLE');
    } else if (e.checkEvent('EVENT_2ND_ROUTE22_RIVAL_BATTLE')) {
      // Route22SecondRivalBattleScript (Music_RivalAlternateTempo)
      yield* emotion(e, RIVAL2);
      e.stopAllMusic();
      e.playMusic('MUSIC_MEET_RIVAL');
      yield* moveRivalRight(e, RIVAL2);
      e.curScript = S('RIVAL2_START_BATTLE');
    }
  },
  // Route22Rival1StartBattleScript
  function* (e) {
    if (e.npcMoving) return;
    if (saved(e) === 1) {
      e.setPlayerMovingDirection('down');
      yield* e.setSpriteFacingDirectionAndDelay(RIVAL1, 'up');
    } else yield* e.setSpriteFacingDirectionAndDelay(RIVAL1, 'right');
    e.joyIgnore = 0;
    yield* e.displayTextID('TEXT_ROUTE22_RIVAL1');
    e.startTrainerBattle('OPP_RIVAL1', 2, 'Route22Rival1DefeatedText', 'Route22Rival1VictoryText');
    e.curScript = S('RIVAL1_AFTER_BATTLE');
  },
  // Route22Rival1AfterBattleScript
  function* (e) {
    if (e.ram.isInBattle === LOST_BATTLE) {
      setDefault(e);
      return;
    }
    if (e.getVar('wRivalStarter') === c('pokemon', 'RIVAL_STARTER_FLAREON')) e.setVar('wRivalStarter', c('pokemon', 'RIVAL_STARTER_JOLTEON'));
    yield* e.setSpriteFacingDirectionAndDelay(RIVAL1, e.playerFacing === 'down' ? 'up' : 'right');
    e.joyIgnore = PAD_CTRL_PAD;
    e.setEvent('EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE');
    yield* e.displayTextID('TEXT_ROUTE22_RIVAL1');
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL'); // Music_RivalAlternateStart
    if (saved(e) === 1)
      e.moveSprite(RIVAL1, [NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, ...new Array(5).fill(NPC_MOVEMENT_DOWN)]);
    else e.moveSprite(RIVAL1, [NPC_MOVEMENT_UP, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, ...new Array(6).fill(NPC_MOVEMENT_DOWN)]);
    e.curScript = S('RIVAL1_EXIT');
  },
  // Route22Rival1ExitScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = 0;
    e.hideObject('TOGGLE_ROUTE_22_RIVAL_1');
    e.playDefaultMusic();
    e.resetEvent('EVENT_1ST_ROUTE22_RIVAL_BATTLE');
    e.resetEvent('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
    e.curScript = S('DEFAULT');
  },
  // Route22Rival2StartBattleScript
  function* (e) {
    if (e.npcMoving) return;
    if (saved(e) === 1) {
      e.setPlayerMovingDirection('down');
      yield* e.setSpriteFacingDirectionAndDelay(RIVAL2, 'up');
    } else {
      e.setPlayerMovingDirection('left');
      yield* e.setSpriteFacingDirectionAndDelay(RIVAL2, 'right');
    }
    e.joyIgnore = 0;
    yield* e.displayTextID('TEXT_ROUTE22_RIVAL2');
    // Route22Script_50ee1: trainer number = wRivalStarter + 7
    e.startTrainerBattle('OPP_RIVAL2', e.getVar('wRivalStarter') + 7, 'Route22Rival2DefeatedText', 'Route22Rival2VictoryText');
    e.curScript = S('RIVAL2_AFTER_BATTLE');
  },
  // Route22Rival2AfterBattleScript
  function* (e) {
    if (e.ram.isInBattle === LOST_BATTLE) {
      setDefault(e);
      return;
    }
    if (saved(e) === 1) {
      e.setPlayerMovingDirection('down');
      yield* e.setSpriteFacingDirectionAndDelay(RIVAL2, 'up');
    } else {
      e.setPlayerMovingDirection('left');
      yield* e.setSpriteFacingDirectionAndDelay(RIVAL2, 'right');
    }
    e.joyIgnore = PAD_CTRL_PAD;
    e.setEvent('EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE');
    yield* e.displayTextID('TEXT_ROUTE22_RIVAL2');
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL'); // Music_RivalAlternateStartAndTempo
    e.moveSprite(RIVAL2, new Array(saved(e) === 1 ? 4 : 3).fill(NPC_MOVEMENT_LEFT));
    e.curScript = S('RIVAL2_EXIT');
  },
  // Route22Rival2ExitScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = 0;
    e.hideObject('TOGGLE_ROUTE_22_RIVAL_2');
    e.playDefaultMusic();
    e.resetEvent('EVENT_2ND_ROUTE22_RIVAL_BATTLE');
    e.resetEvent('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
    e.curScript = S('NOOP');
  },
  // Route22NoopScript
  function* () {},
];

const rivalText = (event: string, before: string, after: string): ScriptFn =>
  function* (e) {
    yield* e.printText(e.checkEvent(event) ? after : before);
  };

export const Route22: MapScript = {
  map: 'ROUTE_22',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* scripts[e.curScript](e);
  },
  texts: {
    Route22Rival1Text: rivalText('EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE', 'Route22RivalBeforeBattleText1', 'Route22RivalAfterBattleText1'),
    Route22Rival2Text: rivalText('EVENT_BEAT_ROUTE22_RIVAL_2ND_BATTLE', 'Route22RivalBeforeBattleText2', 'Route22RivalAfterBattleText2'),
  },
};
