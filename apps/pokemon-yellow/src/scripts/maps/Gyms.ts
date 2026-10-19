/**
 * Ports of scripts/CeruleanGym.asm, VermilionGym.asm, CeladonGym.asm,
 * FuchsiaGym.asm and SaffronGym.asm (Pewter, Cinnabar and Viridian have their
 * own files). The gym trainers' and guides' texts are compiled from the ROM.
 */
import type { MapScript, ScriptFn } from '../types';
import { spinnerDefault, playerSpinning } from '../spinners';
import { displayEnemyTrainerTextAndStartBattle, endTrainerBattle } from '../../engine/trainers';
import { trainerMapScript } from '../../engine/trainers';
import { gymLeaderPostBattle, gymLeaderText, loadGymNames, setEventRange, type GymLeader } from '../gym';
import { c } from '../../rom/constants';

function gym(map: string, label: string, leader: GymLeader, leaderText: string, prelude?: MapScript['run']): MapScript {
  return trainerMapScript(map, [gymLeaderPostBattle(leader)], { [leaderText]: gymLeaderText(leader) }, function* (e) {
    if (prelude) yield* prelude(e);
    else loadGymNames(e, label);
  });
}

const MISTY: GymLeader = {
  gym: 'CeruleanGym',
  number: 2,
  beatEvent: 'EVENT_BEAT_MISTY',
  tmEvent: 'EVENT_GOT_TM11',
  tm: 'TM_BUBBLEBEAM',
  badgeBit: 'BIT_CASCADEBADGE',
  waitText: 'TEXT_CERULEANGYM_MISTY_CASCADE_BADGE_INFO',
  receivedTmText: 'TEXT_CERULEANGYM_MISTY_RECEIVED_TM11',
  noRoomText: 'TEXT_CERULEANGYM_MISTY_TM11_NO_ROOM',
  preBattleText: 'CeruleanGymMistyText.PreBattleText',
  postBattleText: 'CeruleanGymMistyText.TM11ExplanationText',
  badgeText: 'CeruleanGymMistyReceivedCascadeBadgeText',
  postBattleScript: c('map_script', 'SCRIPT_CERULEANGYM_MISTY_POST_BATTLE'),
  onVictory: (e) => setEventRange(e, 'EVENT_BEAT_CERULEAN_GYM_TRAINER_0', 'EVENT_BEAT_CERULEAN_GYM_TRAINER_1'),
};

const LT_SURGE: GymLeader = {
  gym: 'VermilionGym',
  number: 3,
  beatEvent: 'EVENT_BEAT_LT_SURGE',
  tmEvent: 'EVENT_GOT_TM24',
  tm: 'TM_THUNDERBOLT',
  badgeBit: 'BIT_THUNDERBADGE',
  waitText: 'TEXT_VERMILIONGYM_LT_SURGE_THUNDER_BADGE_INFO',
  receivedTmText: 'TEXT_VERMILIONGYM_LT_SURGE_RECEIVED_TM24',
  noRoomText: 'TEXT_VERMILIONGYM_LT_SURGE_TM24_NO_ROOM',
  preBattleText: 'VermilionGymLTSurgeText.PreBattleText',
  postBattleText: 'VermilionGymLTSurgeText.PostBattleAdviceText',
  badgeText: 'VermilionGymLTSurgeReceivedThunderBadgeText',
  postBattleScript: c('map_script', 'SCRIPT_VERMILIONGYM_LT_SURGE_AFTER_BATTLE'),
  onVictory: (e) => setEventRange(e, 'EVENT_BEAT_VERMILION_GYM_TRAINER_0', 'EVENT_BEAT_VERMILION_GYM_TRAINER_2'),
};

const ERIKA: GymLeader = {
  gym: 'CeladonGym',
  number: 4,
  beatEvent: 'EVENT_BEAT_ERIKA',
  tmEvent: 'EVENT_GOT_TM21',
  tm: 'TM_MEGA_DRAIN',
  badgeBit: 'BIT_RAINBOWBADGE',
  waitText: 'TEXT_CELADONGYM_RAINBOWBADGE_INFO',
  receivedTmText: 'TEXT_CELADONGYM_RECEIVED_TM21',
  noRoomText: 'TEXT_CELADONGYM_TM21_NO_ROOM',
  preBattleText: 'CeladonGymErikaText.PreBattleText',
  postBattleText: 'CeladonGymErikaText.PostBattleAdviceText',
  badgeText: 'CeladonGymErikaText.ReceivedRainbowBadgeText',
  postBattleScript: c('map_script', 'SCRIPT_CELADONGYM_ERIKA_POST_BATTLE'),
  onVictory: (e) => setEventRange(e, 'EVENT_BEAT_CELADON_GYM_TRAINER_0', 'EVENT_BEAT_CELADON_GYM_TRAINER_6'),
};

const KOGA: GymLeader = {
  gym: 'FuchsiaGym',
  number: 5,
  beatEvent: 'EVENT_BEAT_KOGA',
  tmEvent: 'EVENT_GOT_TM06',
  tm: 'TM_TOXIC',
  badgeBit: 'BIT_SOULBADGE',
  waitText: 'TEXT_FUCHSIAGYM_KOGA_SOUL_BADGE_INFO',
  receivedTmText: 'TEXT_FUCHSIAGYM_KOGA_RECEIVED_TM06',
  noRoomText: 'TEXT_FUCHSIAGYM_KOGA_TM06_NO_ROOM',
  preBattleText: 'FuchsiaGymKogaText.BeforeBattleText',
  postBattleText: 'FuchsiaGymKogaText.PostBattleAdviceText',
  badgeText: 'FuchsiaGymKogaText.ReceivedSoulBadgeText',
  postBattleScript: c('map_script', 'SCRIPT_FUCHSIAGYM_KOGA_POST_BATTLE'),
  onVictory: (e) => setEventRange(e, 'EVENT_BEAT_FUCHSIA_GYM_TRAINER_0', 'EVENT_BEAT_FUCHSIA_GYM_TRAINER_5'),
};

const SABRINA: GymLeader = {
  gym: 'SaffronGym',
  number: 6,
  beatEvent: 'EVENT_BEAT_SABRINA',
  tmEvent: 'EVENT_GOT_TM46',
  tm: 'TM_PSYWAVE',
  badgeBit: 'BIT_MARSHBADGE',
  waitText: 'TEXT_SAFFRONGYM_SABRINA_MARSH_BADGE_INFO',
  receivedTmText: 'TEXT_SAFFRONGYM_SABRINA_RECEIVED_TM46',
  noRoomText: 'TEXT_SAFFRONGYM_SABRINA_TM46_NO_ROOM',
  preBattleText: 'SaffronGymSabrinaText.Text',
  postBattleText: 'SaffronGymSabrinaText.PostBattleAdviceText',
  badgeText: 'SaffronGymSabrinaText.ReceivedMarshBadgeText',
  postBattleScript: c('map_script', 'SCRIPT_SAFFRONGYM_SABRINA_POST_BATTLE'),
  onVictory: (e) => setEventRange(e, 'EVENT_BEAT_SAFFRON_GYM_TRAINER_0', 'EVENT_BEAT_SAFFRON_GYM_TRAINER_6'),
};

export const CeruleanGym = gym('CERULEAN_GYM', 'CeruleanGym', MISTY, 'CeruleanGymMistyText');

export const VermilionGym = gym('VERMILION_GYM', 'VermilionGym', LT_SURGE, 'VermilionGymLTSurgeText', function* (e) {
  loadGymNames(e, 'VermilionGym', 1);
  if (!e.takeMapLoaded2()) return;
  // VermilionGymSetDoorTile: the double door until both trash can locks are open
  const open = e.checkEvent('EVENT_2ND_LOCK_OPENED');
  if (open) e.playSound('go_inside');
  e.e.world.replaceBlock(2, 2, open ? 0x05 : 0x24);
});

export const CeladonGym = gym('CELADON_GYM', 'CeladonGym', ERIKA, 'CeladonGymErikaText');
export const FuchsiaGym = gym('FUCHSIA_GYM', 'FuchsiaGym', KOGA, 'FuchsiaGymKogaText');
export const SaffronGym = gym('SAFFRON_GYM', 'SaffronGym', SABRINA, 'SaffronGymSabrinaText');

// ------------------------------------------------------------------ Viridian Gym (scripts/ViridianGym.asm)
const GIOVANNI: GymLeader = {
  gym: 'ViridianGym',
  number: 8,
  beatEvent: 'EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI',
  tmEvent: 'EVENT_GOT_TM27',
  tm: 'TM_FISSURE',
  badgeBit: 'BIT_EARTHBADGE',
  waitText: 'TEXT_VIRIDIANGYM_GIOVANNI_EARTH_BADGE_INFO',
  receivedTmText: 'TEXT_VIRIDIANGYM_GIOVANNI_RECEIVED_TM27',
  noRoomText: 'TEXT_VIRIDIANGYM_GIOVANNI_TM27_NO_ROOM',
  preBattleText: 'ViridianGymGiovanniText.PreBattleText',
  postBattleText: 'ViridianGymGiovanniText.PostBattleAdviceText',
  badgeText: 'ViridianGymGiovanniText.ReceivedEarthBadgeText',
  postBattleScript: c('map_script', 'SCRIPT_VIRIDIANGYM_GIOVANNI_POST_BATTLE'),
  onVictory: (e) => {
    setEventRange(e, 'EVENT_BEAT_VIRIDIAN_GYM_TRAINER_0', 'EVENT_BEAT_VIRIDIAN_GYM_TRAINER_7');
    e.showObject('TOGGLE_ROUTE_22_RIVAL_2');
    e.setEvent('EVENT_2ND_ROUTE22_RIVAL_BATTLE');
    e.setEvent('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
  },
};

const giovanniText = gymLeaderText(GIOVANNI);
const viridianScripts: ScriptFn[] = [
  spinnerDefault('ViridianGym', () => c('map_script', 'SCRIPT_VIRIDIANGYM_PLAYER_SPINNING')),
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  gymLeaderPostBattle(GIOVANNI),
  playerSpinning,
];

export const ViridianGym: MapScript = {
  map: 'VIRIDIAN_GYM',
  *run(e) {
    loadGymNames(e, 'ViridianGym');
    e.enableAutoTextBoxDrawing();
    yield* viridianScripts[e.curScript](e);
  },
  texts: {
    *ViridianGymGiovanniText(e) {
      // after the badge and TM, Giovanni disappears (the fade to black)
      if (e.checkEvent('EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI') && e.checkEvent('EVENT_GOT_TM27')) {
        e.doNotWaitForButtonPress = true;
        yield* e.printText('ViridianGymGiovanniText.PostBattleAdviceText');
        yield* e.fadeToBlack();
        e.hideObject('TOGGLE_VIRIDIAN_GYM_GIOVANNI');
        e.updateSprites();
        yield* e.delayFrames(3);
        yield* e.fadeFromBlack();
        return;
      }
      yield* giovanniText(e);
    },
  },
};
