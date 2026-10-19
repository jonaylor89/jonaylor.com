/** Ports of scripts/ViridianCity.asm and ViridianCity_2.asm */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_CTRL_PAD, PAD_DOWN, PAD_SELECT, PAD_START } from '../../engine/pad';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_RIGHT } from '../../engine/sprites';
import { c } from '../../rom/constants';

const S = (n: string) => c('map_script', `SCRIPT_VIRIDIANCITY_${n}`);
const IGNORE_MENU = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
const OLD_MAN2 = 'VIRIDIANCITY_OLD_MAN2';

/** wObtainedBadges == ~(1 << BIT_EARTHBADGE): every badge except the Earth Badge. */
const sevenBadges = (e: ScriptEnv) => e.e.state.badges === (~(1 << c('ram', 'BIT_EARTHBADGE')) & 0xff);

function* checkGymOpenScript(e: ScriptEnv) {
  if (e.checkEvent('EVENT_VIRIDIAN_GYM_OPEN')) return;
  if (sevenBadges(e)) {
    e.setEvent('EVENT_VIRIDIAN_GYM_OPEN');
    return;
  }
  if (e.y !== 8 || e.x !== 32) return;
  yield* e.displayTextID('TEXT_VIRIDIANCITY_GYM_LOCKED');
  movePlayerDown(e);
  e.curScript = S('PLAYER_MOVING_DOWN_POST_TRAINING');
}

/** ViridianCityMovePlayerDownScript */
function movePlayerDown(e: ScriptEnv): void {
  e.startSimulatingJoypadStates();
  e.setSimulatedJoypad([PAD_DOWN], 1);
  e.setPlayerFacing('down');
  e.joyIgnore = 0;
  e.joyHeld = 0;
}

function* checkSleepingOldMan(e: ScriptEnv) {
  if (e.y !== 9 || e.x !== 19) return;
  yield* e.displayTextID('TEXT_VIRIDIANCITY_OLD_MAN_SLEEPY');
  e.joyHeld = 0;
  movePlayerDown(e);
  e.curScript = S('PLAYER_MOVING_DOWN');
}

function* checkWaitingOldMan(e: ScriptEnv) {
  if (e.checkEvent('EVENT_COMPLETED_CATCH_TRAINING')) return;
  if (e.y !== 9 || e.x !== 19) return;
  yield* e.setSpriteFacingDirectionAndDelay(OLD_MAN2, 'right');
  e.setPlayerFacing('left');
  yield* e.displayTextID('TEXT_VIRIDIANCITY_OLD_MAN2');
  e.joyIgnore = IGNORE_MENU;
}

/** .SetupBattle: the old man's catching demonstration (BATTLE_TYPE_OLD_MAN vs Rattata L5). */
function setupCatchBattle(e: ScriptEnv): void {
  e.startWildBattle('RATTATA', 5, 'BATTLE_TYPE_OLD_MAN');
}

const scripts: ScriptFn[] = [
  // ViridianCityDefaultScript
  function* (e) {
    yield* checkGymOpenScript(e);
    yield* checkSleepingOldMan(e);
  },
  // ViridianCityAfterPokedexScript (falls through to PostCatchTraining)
  function* (e) {
    yield* checkWaitingOldMan(e);
    yield* checkGymOpenScript(e);
  },
  // ViridianCityPostCatchTraining
  function* (e) {
    yield* checkGymOpenScript(e);
  },
  // ViridianCityOldManStartCatchTrainingScript
  function* (e) {
    // .SetupSprite saves sprite 3's position; sprites survive battles here, so nothing to save.
    setupCatchBattle(e);
    e.resetEvent('EVENT_INITIAL_CATCH_TRAINING');
    e.curScript = S('OLD_MAN_END_CATCH_TRAINING');
  },
  // ViridianCityOldManEndCatchTrainingScript
  function* (e) {
    e.updateSprites();
    yield* e.delay3();
    e.setEvent('EVENT_COMPLETED_CATCH_TRAINING_AGAIN');
    e.joyIgnore = 0;
    yield* e.displayTextID('TEXT_VIRIDIANCITY_OLD_MAN_YOU_NEED_TO_WEAKEN_THE_TARGET');
    e.ram.battleType = 0;
    e.joyIgnore = 0;
    e.curScript = S('POST_CATCH_TRAINING');
  },
  // ViridianCityPlayerMovingDownScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delay3();
    e.curScript = S('DEFAULT');
  },
  // ViridianCityPlayerMovingDownPostTrainingScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delay3();
    e.curScript = S('POST_CATCH_TRAINING');
  },
  // ViridianCityOldManInitialCatchTrainingScript
  function* (e) {
    setupCatchBattle(e);
    e.setEvent('EVENT_INITIAL_CATCH_TRAINING');
    e.joyIgnore = IGNORE_MENU;
    e.curScript = S('OLD_MAN_END_INITIAL_CATCH_TRAINING');
  },
  // ViridianCityOldManEndInitialCatchTrainingScript
  function* (e) {
    e.updateSprites();
    yield* e.delay3();
    e.setEvent('EVENT_COMPLETED_CATCH_TRAINING');
    e.joyIgnore = IGNORE_MENU;
    yield* e.displayTextID('TEXT_VIRIDIANCITY_OLD_MAN2');
    e.ram.battleType = 0;
    e.joyIgnore = 0xff;
    e.curScript = S('POST_INITIAL_CATCH_TRAINING');
  },
  // ViridianCityPostInitialCatchTraining
  function* (e) {
    const down6 = new Array(6).fill(NPC_MOVEMENT_DOWN);
    // Data1 = RIGHT then Data2; the player on x=19 blocks the old man's way down.
    // (ViridianCityMovePikachu: Pikachu side-step lands with the Pikachu engine, TASKS.md)
    e.moveSprite(OLD_MAN2, e.x === 19 ? down6 : [NPC_MOVEMENT_RIGHT, ...down6]);
    e.curScript = S('OLD_MAN_MOVING_DOWN');
  },
  // ViridianCityOldManMovingDownScript
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_OLD_MAN_2');
    e.joyIgnore = 0;
    e.curScript = S('POST_CATCH_TRAINING');
  },
];

const L = (s: string) => `ViridianCityPrint${s}`;

export const ViridianCity: MapScript = {
  map: 'VIRIDIAN_CITY',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    const fn = scripts[e.curScript];
    if (!fn) throw new Error(`VIRIDIAN_CITY script ${e.curScript}`);
    yield* fn(e);
  },
  texts: {
    *ViridianCityYoungster1Text(e) {
      yield* e.printText(L('Youngster1Text.text'));
    },
    *ViridianCityGambler1Text(e) {
      const returned = sevenBadges(e) || e.checkEvent('EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI');
      yield* e.printText(returned ? L('Gambler1Text.GymLeaderReturnedText') : L('Gambler1Text.GymAlwaysClosedText'));
    },
    *ViridianCityYoungster2Text(e) {
      yield* e.printText(L('Youngster2Text.YouWantToKnowAboutText'));
      const yes = yield* e.yesNoChoice();
      yield* e.printText(yes ? L('Youngster2Text.CaterpieAndWeedleDescriptionText') : L('Youngster2Text.OkThenText'));
    },
    *ViridianCityGirlText(e) {
      yield* e.printText(e.checkEvent('EVENT_GOT_POKEDEX') ? L('GirlText.WhenIGoShopText') : L('GirlText.HasntHadHisCoffeeYetText'));
    },
    *ViridianCityOldManSleepyText(e) {
      yield* e.printText(L('OldManSleepyText.PrivatePropertyText'));
      e.startSimulatingJoypadStates();
      e.setSimulatedJoypad([PAD_DOWN], 1);
      e.curScript = S('PLAYER_MOVING_DOWN');
    },
    *ViridianCityFisherText(e) {
      if (e.checkEvent('EVENT_GOT_TM42')) {
        yield* e.printText(L('FisherText.TM42ExplanationText'));
        return;
      }
      yield* e.printText(L('FisherText.YouCanHaveThisText'));
      if (!e.giveItem('TM_DREAM_EATER', 1)) {
        yield* e.printText(L('FisherText.TM42NoRoomText'));
        return;
      }
      yield* e.printText(L('FisherText.ReceivedTM42Text'));
      e.setEvent('EVENT_GOT_TM42');
    },
    *ViridianCityOldManText(e) {
      yield* e.printText(L('OldManText.WantMeToShowYouAgainText'));
      yield* e.delayFrames(2);
      if (yield* e.yesNoChoice()) {
        yield* e.printText(L('OldManText.WatchCloselyText'));
        e.curScript = S('OLD_MAN_START_CATCH_TRAINING');
      } else {
        yield* e.printText(L('OldManText.NotGoodEnoughForYouText'));
      }
    },
    *ViridianCityOldMan2Text(e) {
      if (e.checkEvent('EVENT_COMPLETED_CATCH_TRAINING')) {
        yield* e.printText('ViridianCityOldMan2Text.LosingMyTouchText');
        return;
      }
      yield* e.printText('ViridianCityOldMan2Text.HadMyCoffeeNowText');
      yield* e.delayFrames(2);
      e.curScript = S('OLD_MAN_INITIAL_CATCH_TRAINING');
    },
    *ViridianCitySignText(e) {
      yield* e.printText(L('SignText.text'));
    },
    *ViridianCityTrainerTips1Text(e) {
      yield* e.printText(L('TrainerTips1Text.text'));
    },
    *ViridianCityTrainerTips2Text(e) {
      yield* e.printText(L('TrainerTips2Text.text'));
    },
    *ViridianCityGymSignText(e) {
      yield* e.printText(L('GymSignText.text'));
    },
    *ViridianCityGymLockedText(e) {
      yield* e.printText(L('GymLockedText.text'));
    },
  },
};
