/**
 * The sleeping SNORLAX on Routes 12 and 16 (scripts/Route12.asm, Route16.asm):
 * once the POKé FLUTE sets EVENT_FIGHT_ROUTE<n>_SNORLAX, it wakes up and attacks.
 */
import type { MapScript, ScriptFn } from '../types';
import { checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle } from '../../engine/trainers';
import { c } from '../../rom/constants';

const LOST_BATTLE = 0xff;
/** wBattleResult: 2 = the wild Pokémon was caught */
const CAUGHT = 2;

function snorlaxRoute(map: string, n: 12 | 16, afterText: string): MapScript {
  const S = (s: string) => c('map_script', `SCRIPT_ROUTE${n}_${s}`);
  const scripts: ScriptFn[] = [
    // Route<n>DefaultScript
    function* (e) {
      if (e.checkEvent(`EVENT_BEAT_ROUTE${n}_SNORLAX`) || !e.checkEvent(`EVENT_FIGHT_ROUTE${n}_SNORLAX`)) {
        e.resetEvent(`EVENT_FIGHT_ROUTE${n}_SNORLAX`);
        return yield* checkFightingMapTrainers(e);
      }
      e.resetEvent(`EVENT_FIGHT_ROUTE${n}_SNORLAX`);
      yield* e.displayTextID(`TEXT_ROUTE${n}_SNORLAX_WOKE_UP`);
      e.startWildBattle('SNORLAX', 30);
      e.hideObject(`TOGGLE_ROUTE_${n}_SNORLAX`);
      e.curScript = S('SNORLAX_POST_BATTLE');
    },
    displayEnemyTrainerTextAndStartBattle,
    endTrainerBattle,
    // Route<n>SnorlaxPostBattleScript
    function* (e) {
      if (e.ram.isInBattle === LOST_BATTLE) {
        e.joyIgnore = 0;
        e.curScript = S('DEFAULT');
        return;
      }
      e.updateSprites();
      if (e.battleResult !== CAUGHT) yield* e.displayTextID(`TEXT_ROUTE${n}_SNORLAX_${afterText}`);
      e.setEvent(`EVENT_BEAT_ROUTE${n}_SNORLAX`);
      yield* e.delayFrames(3);
      e.curScript = S('DEFAULT');
    },
  ];
  return {
    map,
    *run(e) {
      e.enableAutoTextBoxDrawing();
      yield* scripts[e.curScript](e);
    },
  };
}

export const Route12 = snorlaxRoute('ROUTE_12', 12, 'CALMED_DOWN');
export const Route16 = snorlaxRoute('ROUTE_16', 16, 'RETURNED_TO_MOUNTAINS');
