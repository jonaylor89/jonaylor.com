/** Port of scripts/PalletTown.asm */
import type { MapScript, ScriptFn } from '../types';
import { callScript } from '../types';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_SELECT, PAD_START } from '../../engine/pad';

const OAK = 'PALLETTOWN_OAK';

const DefaultScript: ScriptFn = function* (e) {
  if (e.checkEvent('EVENT_FOLLOWED_OAK_INTO_LAB')) return;
  if (e.y !== 0) return; // player at the north exit?
  e.resetEvent('EVENT_PLAYER_AT_RIGHT_EXIT_TO_PALLET_TOWN');
  if (e.x !== 10) e.setEvent('EVENT_PLAYER_AT_RIGHT_EXIT_TO_PALLET_TOWN');
  e.joyHeld = 0;
  e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
  e.setPlayerMovingDirection('up');
  e.stopAllMusic();
  e.playMusic('MUSIC_MEET_PROF_OAK');
  e.setEvent('EVENT_OAK_APPEARED_IN_PALLET');
  e.curScript = e.s('SCRIPT_PALLETTOWN_OAK_HEY_WAIT');
};

const OakHeyWaitScript: ScriptFn = function* (e) {
  e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
  e.setVar('wOakWalkedToPlayer', 0);
  yield* e.displayTextID('TEXT_PALLETTOWN_OAK');
  e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
  e.setSpriteMapPosition(OAK, 14 - 4, 8 - 4);
  e.showObject('TOGGLE_PALLET_TOWN_OAK');
  e.setMovementStatus(OAK, 2);
  e.setSpriteFacing(OAK, 'up');
  e.curScript = e.s('SCRIPT_PALLETTOWN_OAK_WALKS_TO_PLAYER');
};

const OakWalksToPlayerScript: ScriptFn = function* (e) {
  yield* e.delay3();
  e.setPlayerCoords(e.x, 0);
  const path = e.findPathToPlayer(OAK, -1);
  e.moveSprite(OAK, path);
  e.curScript = e.s('SCRIPT_PALLETTOWN_OAK_GREETS_PLAYER');
};

const OakGreetsPlayerScript: ScriptFn = function* (e) {
  if (e.npcMoving) return;
  e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
  e.setVar('wOakWalkedToPlayer', 1);
  e.setMovementStatus(OAK, 2);
  e.setSpriteFacing(OAK, 'up');
  yield* e.displayTextID('TEXT_PALLETTOWN_OAK');
  // Oak faces the patch of grass next to him to watch Pikachu.
  e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
  e.setMovementStatus(OAK, 2);
  e.setSpriteFacing(OAK, e.checkEvent('EVENT_PLAYER_AT_RIGHT_EXIT_TO_PALLET_TOWN') ? 'left' : 'right');
  e.curScript = e.s('SCRIPT_PALLETTOWN_PIKACHU_BATTLE');
};

const PikachuBattleScript: ScriptFn = function* (e) {
  e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
  e.startWildBattle('STARTER_PIKACHU', 5, 'BATTLE_TYPE_PIKACHU');
  e.curScript = e.s('SCRIPT_PALLETTOWN_AFTER_PIKACHU_BATTLE');
};

const AfterPikachuBattleScript: ScriptFn = function* (e) {
  e.setVar('wOakWalkedToPlayer', 2);
  yield* e.displayTextID('TEXT_PALLETTOWN_OAK');
  e.setMovementStatus(OAK, 2);
  e.setSpriteFacing(OAK, 'up');
  yield* e.displayTextID('TEXT_PALLETTOWN_OAK_COME_WITH_ME');
  e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
  e.curScript = e.s('SCRIPT_PALLETTOWN_OAK_NOT_SAFE_COME_WITH_ME');
};

const OakNotSafeComeWithMeScript: ScriptFn = function* (e) {
  e.setPlayerFacing('down');
  e.startNpcMovementScript(1, OAK);
  e.curScript = e.s('SCRIPT_PALLETTOWN_PLAYER_FOLLOWS_OAK');
};

const PlayerFollowsOakScript: ScriptFn = function* (e) {
  if (e.npcMovementScriptActive) return;
  e.curScript = e.s('SCRIPT_PALLETTOWN_DAISY');
};

const DaisyScript: ScriptFn = function* (e) {
  if (!e.checkEvent('EVENT_DAISY_WALKING') && e.checkEvent('EVENT_GOT_TOWN_MAP') && e.checkEvent('EVENT_ENTERED_BLUES_HOUSE')) {
    e.setEvent('EVENT_DAISY_WALKING');
    e.hideObject('TOGGLE_DAISY_SITTING');
    e.showObject('TOGGLE_DAISY_WALKING');
    return;
  }
  if (!e.checkEvent('EVENT_GOT_POKEBALLS_FROM_OAK')) return;
  e.setEvent('EVENT_PALLET_AFTER_GETTING_POKEBALLS_2');
};

const NoopScript: ScriptFn = function* () {};

const scripts: ScriptFn[] = [
  DefaultScript,
  OakHeyWaitScript,
  OakWalksToPlayerScript,
  OakGreetsPlayerScript,
  PikachuBattleScript,
  AfterPikachuBattleScript,
  OakNotSafeComeWithMeScript,
  PlayerFollowsOakScript,
  DaisyScript,
  NoopScript,
];

export const PalletTown: MapScript = {
  map: 'PALLET_TOWN',
  *run(e) {
    if (e.checkEvent('EVENT_GOT_POKEBALLS_FROM_OAK')) e.setEvent('EVENT_PALLET_AFTER_GETTING_POKEBALLS');
    e.enableAutoTextBoxDrawing();
    yield* callScript(e, scripts);
  },
  texts: {
    *PalletTownOakText(e) {
      const walked = e.getVar('wOakWalkedToPlayer');
      if (walked === 0) {
        e.doNotWaitForButtonPress = true;
        yield* e.printText('PalletTownOakText.HeyWaitDontGoOutText');
      } else if (walked === 1) {
        yield* e.printText('PalletTownOakText.ThatWasCloseText');
      } else {
        yield* e.printText('PalletTownOakText.WhewText');
      }
    },
    *'PalletTownOakText.HeyWaitDontGoOutText'(e) {
      yield* e.delayFrames(10);
      e.setPlayerMovingDirection('down');
      e.updateSprites();
      yield* e.emotionBubble(0, 'EXCLAMATION_BUBBLE');
    },
  },
};
