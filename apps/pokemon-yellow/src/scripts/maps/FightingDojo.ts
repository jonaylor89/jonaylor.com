/**
 * The Fighting Dojo (scripts/FightingDojo.asm): the Karate Master's challenge
 * and the HITMONLEE / HITMONCHAN reward (only one may be taken).
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_CTRL_PAD } from '../../engine/pad';
import { c } from '../../rom/constants';
import { checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle, engageMapTrainer, initBattleEnemyParameters } from '../../engine/trainers';
import { displayPokedex } from '../../engine/hiddenEvents';
import { setEventRange } from '../gym';

const S = (n: string) => c('map_script', `SCRIPT_FIGHTINGDOJO_${n}`);
const MASTER = 'FIGHTINGDOJO_KARATE_MASTER';
const LOST_BATTLE = 0xff;

const scripts: ScriptFn[] = [
  // FightingDojoDefaultScript: walking up beside the master starts the challenge
  function* (e) {
    if (e.checkEvent('EVENT_DEFEATED_FIGHTING_DOJO')) return;
    const before = e.curScript;
    yield* checkFightingMapTrainers(e);
    if (e.curScript !== before) return; // a blackbelt spotted the player
    if (e.checkEvent('EVENT_BEAT_KARATE_MASTER')) return;
    e.joyHeld = 0;
    e.setVar('wSavedCoordIndex', 0);
    if (e.y !== 3 || e.x !== 4) return;
    e.setVar('wSavedCoordIndex', 1);
    e.setPlayerMovingDirection('right');
    yield* e.setSpriteFacingDirectionAndDelay(MASTER, 'left');
    yield* e.displayTextID('TEXT_FIGHTINGDOJO_KARATE_MASTER');
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  // FightingDojoKarateMasterPostBattleScript
  function* (e) {
    if (e.ram.isInBattle === LOST_BATTLE) {
      e.joyIgnore = 0;
      e.curScript = S('DEFAULT');
      return;
    }
    if (e.getVar('wSavedCoordIndex')) {
      e.setPlayerMovingDirection('right');
      yield* e.setSpriteFacingDirectionAndDelay(MASTER, 'left');
    }
    e.joyIgnore = PAD_CTRL_PAD;
    setEventRange(e, 'EVENT_BEAT_KARATE_MASTER', 'EVENT_BEAT_FIGHTING_DOJO_TRAINER_3');
    yield* e.displayTextID('TEXT_FIGHTINGDOJO_KARATE_MASTER_I_WILL_GIVE_YOU_A_POKEMON');
    e.joyIgnore = 0;
    e.curScript = S('DEFAULT');
  },
];

function* karateMaster(e: ScriptEnv): Co {
  const T = (n: string) => `FightingDojoKarateMasterText.${n}`;
  if (e.checkEvent('EVENT_DEFEATED_FIGHTING_DOJO')) return yield* e.printText(T('StayAndTrainWithUsText'));
  if (e.checkEvent('EVENT_BEAT_KARATE_MASTER')) return yield* e.printText(T('IWillGiveYouAPokemonText'));
  yield* e.printText(T('Text'));
  const r = e.ram;
  r.talkedToTrainer = true;
  r.printEndBattleText = true;
  r.endBattleWinText = T('DefeatedText');
  r.endBattleLoseText = T('DefeatedText');
  engageMapTrainer(e, r.spriteIndex);
  initBattleEnemyParameters(e);
  e.curScript = S('KARATE_MASTER_POST_BATTLE');
}

function gift(species: string, label: string, toggle: string, event: string) {
  return function* (e: ScriptEnv): Co {
    if (e.checkEvent('EVENT_GOT_HITMONLEE') || e.checkEvent('EVENT_GOT_HITMONCHAN')) return yield* e.printText('FightingDojoBetterNotGetGreedyText');
    yield* displayPokedex(e.e, c('pokemon', species));
    yield* e.printText(`${label}.Text`);
    if (!(yield* e.yesNoChoice())) return;
    if (!(yield* e.givePokemon(species, 30))) return;
    e.hideObject(toggle);
    e.setEvent(event);
    e.setEvent('EVENT_DEFEATED_FIGHTING_DOJO');
  };
}

export const FightingDojo: MapScript = {
  map: 'FIGHTING_DOJO',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* scripts[e.curScript](e);
  },
  texts: {
    FightingDojoKarateMasterText: karateMaster,
    FightingDojoHitmonleePokeBallText: gift('HITMONLEE', 'FightingDojoHitmonleePokeBallText', 'TOGGLE_FIGHTING_DOJO_GIFT_1', 'EVENT_GOT_HITMONLEE'),
    FightingDojoHitmonchanPokeBallText: gift('HITMONCHAN', 'FightingDojoHitmonchanPokeBallText', 'TOGGLE_FIGHTING_DOJO_GIFT_2', 'EVENT_GOT_HITMONCHAN'),
  },
};
