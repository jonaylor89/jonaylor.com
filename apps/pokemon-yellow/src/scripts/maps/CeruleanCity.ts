/** Port of scripts/CeruleanCity.asm and CeruleanCity_2.asm: the rival on the bridge and the Rocket thief. */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_CTRL_PAD } from '../../engine/pad';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NONE, FACING_DOWN, FACING_UP } from '../../engine/sprites';
import { engageMapTrainer, initBattleEnemyParameters } from '../../engine/trainers';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_CERULEANCITY_${n}`);
const RIVAL = 'CERULEANCITY_RIVAL';

/** CeruleanCityClearScripts */
function clearScripts(e: ScriptEnv): void {
  e.joyIgnore = 0;
  e.curScript = S('DEFAULT');
  e.hideObject('TOGGLE_CERULEAN_RIVAL');
}

function* faceRival(e: ScriptEnv) {
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'down');
}

const scripts: ScriptFn[] = [
  // CeruleanCityDefaultScript
  function* (e) {
    if (!e.checkEvent('EVENT_BEAT_CERULEAN_ROCKET_THIEF')) {
      const hit = e.arePlayerCoordsInArray([
        [7, 30],
        [9, 30],
      ]);
      if (hit) {
        // wCoordIndex 0 = (30, 7): PLAYER_DIR_UP, the thief faces down; 1 = (30, 9): the reverse
        const first = hit === 1;
        e.setPlayerMovingDirection(first ? 'up' : 'down');
        e.sprite(2).facing = first ? FACING_DOWN : FACING_UP;
        yield* e.delay3();
        yield* e.displayTextID('TEXT_CERULEANCITY_ROCKET');
        return;
      }
    }
    if (e.checkEvent('EVENT_BEAT_CERULEAN_RIVAL')) return;
    if (
      !e.arePlayerCoordsInArray([
        [6, 20],
        [6, 21],
      ])
    )
      return;
    if (e.e.state.player.mode !== 'walk') e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL');
    e.joyHeld = 0;
    e.joyIgnore = PAD_CTRL_PAD;
    // the rival comes down on the same column as the player
    if (e.x !== 20) e.sprite(RIVAL).mapX = 25 - 4;
    e.showObject('TOGGLE_CERULEAN_RIVAL');
    e.moveSprite(RIVAL, [NPC_MOVEMENT_DOWN, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_DOWN]);
    e.curScript = S('RIVAL_BATTLE');
  },
  // CeruleanCityRivalBattleScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = 0;
    yield* e.displayTextID('TEXT_CERULEANCITY_RIVAL');
    e.startTrainerBattle('OPP_RIVAL1', 3, 'CeruleanCityRivalDefeatedText', 'CeruleanCityRivalVictoryText');
    e.joyHeld = 0;
    yield* faceRival(e);
    e.curScript = S('RIVAL_DEFEATED');
  },
  // CeruleanCityRivalDefeatedScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) return clearScripts(e);
    yield* faceRival(e);
    e.joyIgnore = PAD_CTRL_PAD;
    e.setEvent('EVENT_BEAT_CERULEAN_RIVAL');
    yield* e.displayTextID('TEXT_CERULEANCITY_RIVAL');
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL'); // Music_RivalAlternateStart
    e.sprite(RIVAL).movementByte2 = NONE;
    const sideStep = e.x === 20 ? NPC_MOVEMENT_RIGHT : NPC_MOVEMENT_LEFT;
    e.moveSprite(RIVAL, [sideStep, ...new Array(6).fill(NPC_MOVEMENT_DOWN)]);
    e.curScript = S('RIVAL_CLEANUP');
  },
  // CeruleanCityRivalCleanupScript
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_CERULEAN_RIVAL');
    e.joyIgnore = 0;
    e.playDefaultMusic();
    e.curScript = S('DEFAULT');
  },
  // CeruleanCityRocketDefeatedScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) return clearScripts(e);
    e.joyIgnore = PAD_CTRL_PAD;
    e.setEvent('EVENT_BEAT_CERULEAN_ROCKET_THIEF');
    yield* e.displayTextID('TEXT_CERULEANCITY_ROCKET');
    e.joyIgnore = 0;
    e.curScript = S('DEFAULT');
  },
];

export const CeruleanCity: MapScript = {
  map: 'CERULEAN_CITY',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* scripts[e.curScript](e);
  },
  texts: {
    *CeruleanCityRivalText(e) {
      yield* e.printText(e.checkEvent('EVENT_BEAT_CERULEAN_RIVAL') ? 'CeruleanCityRivalIWentToBillsText' : 'CeruleanCityRivalText.PreBattleText');
    },
    *CeruleanCityRocketText(e) {
      const T = (n: string) => `CeruleanCityRocketText.${n}`;
      if (!e.checkEvent('EVENT_BEAT_CERULEAN_ROCKET_THIEF')) {
        yield* e.printText(T('Text'));
        const r = e.ram;
        r.talkedToTrainer = true;
        r.printEndBattleText = true;
        r.endBattleWinText = T('IGiveUpText');
        r.endBattleLoseText = T('IGiveUpText');
        engageMapTrainer(e, e.spriteIndex);
        initBattleEnemyParameters(e);
        e.curScript = S('ROCKET_DEFEATED');
        return;
      }
      yield* e.printText(T('IllReturnTheTMText'));
      if (!e.giveItem('TM_DIG')) {
        yield* e.printText(T('TM28NoRoomText'));
        return;
      }
      e.doNotWaitForButtonPress = true;
      yield* e.printText(T('ReceivedTM28Text'));
      // CeruleanHideRocket
      yield* e.fadeToBlack();
      e.showObject('TOGGLE_CERULEAN_GUARD_1');
      e.hideObject('TOGGLE_CERULEAN_GUARD_2');
      e.hideObject('TOGGLE_CERULEAN_ROCKET');
      yield* e.fadeFromBlack();
    },
  },
};
