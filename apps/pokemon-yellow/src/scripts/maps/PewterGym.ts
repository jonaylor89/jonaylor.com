/** Port of scripts/PewterGym.asm */
import type { MapScript } from '../types';
import { trainerMapScript, trainerText } from '../../engine/trainers';
import { gymLeaderPostBattle, gymLeaderText, loadGymNames, type GymLeader } from '../gym';
import { c } from '../../rom/constants';

const BROCK: GymLeader = {
  gym: 'PewterGym',
  number: 1,
  beatEvent: 'EVENT_BEAT_BROCK',
  tmEvent: 'EVENT_GOT_TM34',
  tm: 'TM_BIDE',
  badgeBit: 'BIT_BOULDERBADGE',
  waitText: 'TEXT_PEWTERGYM_BROCK_WAIT_TAKE_THIS',
  receivedTmText: 'TEXT_PEWTERGYM_RECEIVED_TM34',
  noRoomText: 'TEXT_PEWTERGYM_TM34_NO_ROOM',
  preBattleText: 'PewterGymBrockText.PreBattleText',
  postBattleText: 'PewterGymBrockText.PostBattleAdviceText',
  badgeText: 'PewterGymBrockReceivedBoulderBadgeText',
  postBattleScript: c('map_script', 'SCRIPT_PEWTERGYM_BROCK_POST_BATTLE'),
  onVictory(e) {
    e.hideObject('TOGGLE_GYM_GUY');
    e.hideObject('TOGGLE_ROUTE_22_RIVAL_1');
    e.resetEvent('EVENT_1ST_ROUTE22_RIVAL_BATTLE');
    e.resetEvent('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
    // deactivate gym trainers
    e.setEvent('EVENT_BEAT_PEWTER_GYM_TRAINER_0');
  },
};

export const PewterGym: MapScript = trainerMapScript(
  'PEWTER_GYM',
  [gymLeaderPostBattle(BROCK)],
  {
    PewterGymBrockText: gymLeaderText(BROCK),
    PewterGymCooltrainerMText: trainerText(0),
    *PewterGymGuideText(e) {
      if (e.getVar('wBeatGymFlags') & (1 << c('ram', 'BIT_BOULDERBADGE'))) {
        yield* e.printText('PewterGymGuidePostBattleText');
        return;
      }
      yield* e.printText('PewterGymGuidePreAdviceText');
      if (yield* e.yesNoChoice()) {
        if (e.pikachuSpawnStarter) {
          yield* e.printText('PewterGymText_5c41c');
          return;
        }
        yield* e.printText('PewterGymGuideBeginAdviceText');
      } else yield* e.printText('PewterGymGuideFreeServiceText');
      yield* e.printText('PewterGymGuideAdviceText');
    },
  },
  function* (e) {
    loadGymNames(e, 'PewterGym');
  },
);
