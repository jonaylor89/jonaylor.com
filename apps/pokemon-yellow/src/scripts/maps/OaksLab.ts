/** Port of scripts/OaksLab.asm */
import type { MapScript, ScriptFn } from '../types';
import { callScript } from '../types';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_SELECT, PAD_START, PAD_UP } from '../../engine/pad';
import { NPC_CHANGE_FACING, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP } from '../../engine/sprites';
import { c } from '../../rom/constants';
import { playPikachuCry, pikachuCry } from '../../engine/pikachuEmotions';

const RIVAL = 'OAKSLAB_RIVAL';
const OAK1 = 'OAKSLAB_OAK1';
const OAK2 = 'OAKSLAB_OAK2';
const S = (n: string) => c('map_script', `SCRIPT_OAKSLAB_${n}`);
const IGNORE_MENU = PAD_SELECT | PAD_START | PAD_CTRL_PAD;

const DefaultScript: ScriptFn = function* (e) {
  if (!e.checkEvent('EVENT_OAK_APPEARED_IN_PALLET')) return;
  if (e.npcMovementScriptFunction) return;
  e.showObject('TOGGLE_OAKS_LAB_OAK_2');
  e.noBattles = false;
  e.curScript = S('OAK_ENTERS_LAB');
};

const OakEntersLabScript: ScriptFn = function* (e) {
  e.moveSprite(OAK2, [NPC_MOVEMENT_UP, NPC_MOVEMENT_UP, NPC_MOVEMENT_UP]);
  e.curScript = S('TOGGLE_OAKS');
};

const ToggleOaksScript: ScriptFn = function* (e) {
  if (e.npcMoving) return;
  e.hideObject('TOGGLE_OAKS_LAB_OAK_2');
  e.showObject('TOGGLE_OAKS_LAB_OAK_1');
  e.curScript = S('PLAYER_ENTERS_LAB');
};

const PlayerEntersLabScript: ScriptFn = function* (e) {
  yield* e.delay3();
  e.simulateRLE([PAD_UP, 8]);
  e.startSimulatingJoypadStates();
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'down');
  yield* e.setSpriteFacingDirectionAndDelay(OAK1, 'down');
  e.curScript = S('FOLLOWED_OAK');
};

const FollowedOakScript: ScriptFn = function* (e) {
  if (e.simulatedIndex) return;
  e.setEvent('EVENT_FOLLOWED_OAK_INTO_LAB');
  e.setEvent('EVENT_FOLLOWED_OAK_INTO_LAB_2');
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'up');
  e.noMapMusic = false;
  e.playDefaultMusic();
  e.curScript = S('OAK_CHOOSE_MON_SPEECH');
};

const OakChooseMonSpeechScript: ScriptFn = function* (e) {
  e.setEvent('EVENT_OAK_ASKED_TO_CHOOSE_MON');
  e.joyIgnore = IGNORE_MENU;
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_FED_UP_WITH_WAITING');
  yield* e.delay3();
  yield* e.displayTextID('TEXT_OAKSLAB_OAK_CHOOSE_MON');
  yield* e.delay3();
  e.setMovementStatus(1, 2);
  e.setSpriteFacing(1, 'up');
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_WHAT_ABOUT_ME');
  yield* e.delay3();
  yield* e.displayTextID('TEXT_OAKSLAB_OAK_BE_PATIENT');
  e.joyIgnore = 0;
  e.curScript = S('PLAYER_DONT_GO_AWAY_SCRIPT');
};

const PlayerDontGoAwayScript: ScriptFn = function* (e) {
  if (e.y !== 6) return;
  yield* e.setSpriteFacingDirectionAndDelay(OAK1, 'down');
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'down');
  e.updateSprites();
  yield* e.displayTextID('TEXT_OAKSLAB_OAK_DONT_GO_AWAY_YET');
  e.setSimulatedJoypad([PAD_UP], 1);
  e.startSimulatingJoypadStates();
  e.setPlayerMovingDirection('up');
  e.curScript = S('PLAYER_FORCED_TO_WALK_BACK_SCRIPT');
};

const PlayerForcedToWalkBackScript: ScriptFn = function* (e) {
  if (e.simulatedIndex) return;
  yield* e.delay3();
  e.curScript = S('PLAYER_DONT_GO_AWAY_SCRIPT');
};

const ChoseStarterScript: ScriptFn = function* (e) {
  // .RivalPushesPlayerAwayFromEeveeBall: down, then three fast steps right
  e.moveSprite(RIVAL, [0x00, 0x07, 0x07, 0x07]);
  e.curScript = S('RIVAL_TAKES_POKEBALL');
};

const RivalTakesPokeballScript: ScriptFn = function* (e) {
  if (e.npcMoving) {
    if (e.y !== 4) return;
    if (e.numScriptedSteps !== 1) return;
    e.setPlayerMovingDirection('left');
    e.setSimulatedJoypad([PAD_RIGHT, PAD_RIGHT], 2);
    e.startSimulatingJoypadStates();
    return;
  }
  e.hideObject('TOGGLE_STARTER_BALL_1');
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'up');
  e.setVar('wRivalStarter', c('pokemon', 'RIVAL_STARTER_JOLTEON'));
  e.getMonName(c('pokemon', 'EEVEE'));
  e.joyIgnore = IGNORE_MENU;
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_RECEIVED_MON');
  e.curScript = S('PLAYER_WALKS_TO_OAK');
};

const PlayerWalksToOakScript: ScriptFn = function* (e) {
  if (e.y === 4) e.simulateRLE([PAD_UP, 2, PAD_LEFT, 3, PAD_DOWN, 1, PAD_LEFT, 1]);
  else e.setSimulatedJoypad([PAD_LEFT], 1);
  e.startSimulatingJoypadStates();
  e.curScript = S('PLAYER_RECEIVES_PIKACHU');
};

const PlayerReceivesPikachuScript: ScriptFn = function* (e) {
  if (e.simulatedIndex) return;
  yield* e.displayTextID('TEXT_OAKSLAB_PLAYER_RECEIVED_MON');
  e.joyIgnore = 0;
  e.curScript = S('RIVAL_CHALLENGES_PLAYER');
};

const RivalChallengesPlayerScript: ScriptFn = function* (e) {
  if (e.y !== 6) return;
  e.setPlayerMovingDirection('up');
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'down');
  e.playMusic('MUSIC_MEET_RIVAL');
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_ILL_TAKE_YOU_ON');
  const path = e.findPathToPlayer(RIVAL, -1);
  e.moveSprite(RIVAL, path);
  e.curScript = S('RIVAL_START_BATTLE');
};

const RivalStartBattleScript: ScriptFn = function* (e) {
  if (e.npcMoving) return;
  const pos = e.getSpritePosition(RIVAL); // GetSpritePosition1
  e.setVar('wSavedSpriteMapX', pos.x);
  e.setVar('wSavedSpriteMapY', pos.y);
  e.startTrainerBattle('OPP_RIVAL1', 1, 'OaksLabRivalIPickedTheWrongPokemonText', 'OaksLabRivalAmIGreatOrWhatText');
  e.joyIgnore = 0;
  e.setPlayerMovingDirection('up');
  e.curScript = S('RIVAL_END_BATTLE');
};

const RivalEndBattleScript: ScriptFn = function* (e) {
  e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
  // Beat him here: Eevee becomes Jolteon/Flareon later; lose: Vaporeon.
  e.setVar('wRivalStarter', c('pokemon', e.battleResult ? 'RIVAL_STARTER_VAPOREON' : 'RIVAL_STARTER_FLAREON'));
  e.joyIgnore = IGNORE_MENU;
  e.setPlayerMovingDirection('up');
  e.updateSprites();
  e.setSpriteMapPosition(RIVAL, e.getVar('wSavedSpriteMapX'), e.getVar('wSavedSpriteMapY')); // SetSpritePosition1
  e.setMovementStatus(1, 2);
  e.setSpriteFacing(1, 'down');
  e.healParty();
  e.setEvent('EVENT_BATTLED_RIVAL_IN_OAKS_LAB');
  e.curScript = S('RIVAL_STARTS_EXIT');
};

const RivalStartsExitScript: ScriptFn = function* (e) {
  yield* e.delayFrames(20);
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_SMELL_YOU_LATER');
  e.playMusic('MUSIC_MEET_RIVAL'); // Music_RivalAlternateStart
  e.moveSprite(RIVAL, [NPC_CHANGE_FACING, NPC_MOVEMENT_DOWN, 0x04, 0x04, 0x04, 0x04, 0x04]);
  // step left or right first depending on where the player stands
  e.setScriptedDirection(0, e.x === 4 ? NPC_MOVEMENT_RIGHT : NPC_MOVEMENT_LEFT);
  e.curScript = S('PLAYER_WATCH_RIVAL_EXIT');
};

const PlayerWatchRivalExitScript: ScriptFn = function* (e) {
  if (e.npcMoving) {
    // keep facing the rival as he walks away
    const n = e.numScriptedSteps;
    if (n === 5) e.setPlayerFacing(e.x === 4 ? 'right' : 'left');
    else if (n === 4) e.setPlayerFacing('down');
    return;
  }
  e.joyIgnore = IGNORE_MENU;
  e.hideObject('TOGGLE_OAKS_LAB_RIVAL');
  e.playDefaultMusic();
  e.curScript = S('PIKACHU_ESCAPES_POKEBALL');
};

const PikachuEscapesPokeballScript: ScriptFn = function* (e) {
  // Pikachu comes out
  e.setPlayerFacing('up');
  e.e.pikachu.spawnState = 2;
  e.e.pikachu.scheduleSpawnForAfterText();
  e.enablePikachuOverworldSpriteDrawing();
  yield* e.displayTextID('TEXT_OAKSLAB_PIKACHU_DISLIKES_POKEBALLS1');
  e.curScript = S('PIKACHU_DISLIKES_POKEBALLS');
};

const PikachuDislikesPokeballsScript: ScriptFn = function* (e) {
  yield* e.displayTextID('TEXT_OAKSLAB_PIKACHU_DISLIKES_POKEBALLS2');
  e.joyIgnore = 0;
  e.curScript = S('NOOP');
};

const RivalArrivesAtOaksRequestScript: ScriptFn = function* (e) {
  e.joyHeld = 0;
  e.enableAutoTextBoxDrawing();
  e.stopAllMusic();
  e.playMusic('MUSIC_MEET_RIVAL');
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_GRAMPS');
  // OaksLabCalcRivalMovementScript
  let steps: number;
  let y: number;
  if (e.y === 3) [steps, y] = [4, 11];
  else if (e.y === 1) [steps, y] = [2, 9];
  else [steps, y] = [3, 10];
  e.setSpriteMapPosition(RIVAL, 8 - 4, y - 4);
  e.showObject('TOGGLE_OAKS_LAB_RIVAL');
  e.setVar('wSavedNPCMovementDirections2Index', steps);
  e.moveSprite(RIVAL, new Array(steps).fill(NPC_MOVEMENT_UP));
  e.curScript = S('OAK_GIVES_POKEDEX');
};

function* rivalFaceUpOakFaceDown(e: Parameters<ScriptFn>[0]) {
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'up');
  yield* e.setSpriteFacingDirectionAndDelay(OAK2, 'down');
}

const OakGivesPokedexScript: ScriptFn = function* (e) {
  if (e.npcMoving) return;
  e.enableAutoTextBoxDrawing();
  e.playDefaultMusic();
  e.joyIgnore = IGNORE_MENU;
  yield* rivalFaceUpOakFaceDown(e);
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_MY_POKEMON_HAS_GROWN_STRONGER');
  yield* e.delayFrame();
  yield* rivalFaceUpOakFaceDown(e);
  yield* e.displayTextID('TEXT_OAKSLAB_OAK_I_HAVE_A_REQUEST');
  yield* e.delayFrame();
  yield* rivalFaceUpOakFaceDown(e);
  yield* e.displayTextID('TEXT_OAKSLAB_OAK_MY_INVENTION_POKEDEX');
  yield* e.delayFrame();
  yield* e.displayTextID('TEXT_OAKSLAB_OAK_GOT_POKEDEX');
  yield* e.delay3();
  e.hideObject('TOGGLE_POKEDEX_1');
  e.hideObject('TOGGLE_POKEDEX_2');
  yield* rivalFaceUpOakFaceDown(e);
  yield* e.displayTextID('TEXT_OAKSLAB_OAK_THAT_WAS_MY_DREAM');
  yield* e.setSpriteFacingDirectionAndDelay(RIVAL, 'right');
  yield* e.delay3();
  yield* e.displayTextID('TEXT_OAKSLAB_RIVAL_LEAVE_IT_ALL_TO_ME');
  e.setEvent('EVENT_GOT_POKEDEX');
  e.setMapScript('VIRIDIAN_CITY', 'SCRIPT_VIRIDIANCITY_AFTER_POKEDEX');
  e.setEvent('EVENT_OAK_GOT_PARCEL');
  e.hideObject('TOGGLE_LYING_OLD_MAN');
  e.showObject('TOGGLE_OLD_MAN_2');
  const n = e.getVar('wSavedNPCMovementDirections2Index');
  e.stopAllMusic();
  e.playMusic('MUSIC_MEET_RIVAL');
  e.moveSprite(RIVAL, new Array(n).fill(NPC_MOVEMENT_DOWN));
  e.curScript = S('RIVAL_LEAVES_WITH_POKEDEX');
};

const RivalLeavesWithPokedexScript: ScriptFn = function* (e) {
  if (e.npcMoving) return;
  e.playDefaultMusic();
  e.hideObject('TOGGLE_OAKS_LAB_RIVAL');
  e.setEvent('EVENT_1ST_ROUTE22_RIVAL_BATTLE');
  e.resetEvent('EVENT_2ND_ROUTE22_RIVAL_BATTLE');
  e.setEvent('EVENT_ROUTE22_RIVAL_WANTS_BATTLE');
  e.showObject('TOGGLE_ROUTE_22_RIVAL_1');
  e.joyIgnore = 0;
  e.curScript = S('NOOP');
};

const NoopScript: ScriptFn = function* () {};

const scripts: ScriptFn[] = [
  DefaultScript,
  OakEntersLabScript,
  ToggleOaksScript,
  PlayerEntersLabScript,
  FollowedOakScript,
  OakChooseMonSpeechScript,
  PlayerDontGoAwayScript,
  PlayerForcedToWalkBackScript,
  ChoseStarterScript,
  RivalTakesPokeballScript,
  PlayerWalksToOakScript,
  PlayerReceivesPikachuScript,
  RivalChallengesPlayerScript,
  RivalStartBattleScript,
  RivalEndBattleScript,
  RivalStartsExitScript,
  PlayerWatchRivalExitScript,
  PikachuEscapesPokeballScript,
  PikachuDislikesPokeballsScript,
  RivalArrivesAtOaksRequestScript,
  OakGivesPokedexScript,
  RivalLeavesWithPokedexScript,
  NoopScript,
];

/** `ld hl, .Text; call PrintText; jp TextScriptEnd` wrappers. */
const printOnly = (label: string): ScriptFn =>
  function* (e) {
    yield* e.printText(label);
  };

export const OaksLab: MapScript = {
  map: 'OAKS_LAB',
  *run(e) {
    // OaksLabLoadTextPointers2Script swaps to an equivalent table; nothing to do here.
    e.disableAutoTextBoxDrawing();
    yield* callScript(e, scripts);
  },
  texts: {
    *OaksLabRivalText(e) {
      if (!e.checkEvent('EVENT_FOLLOWED_OAK_INTO_LAB_2')) yield* e.printText('OaksLabRivalText.GrampsIsntAroundText');
      else if (!e.checkEvent('EVENT_GOT_STARTER')) yield* e.printText('OaksLabRivalText.IllGetABetterPokemonThanYou');
      else yield* e.printText('OaksLabRivalText.MyPokemonLooksStrongerText');
    },
    *OaksLabEeveePokeBallText(e) {
      e.doNotWaitForButtonPress = true;
      if (e.checkEvent('EVENT_OAK_ASKED_TO_CHOOSE_MON')) {
        // OaksLabRivalExclamationScript
        yield* e.emotionBubble(RIVAL, 'EXCLAMATION_BUBBLE');
        e.curScript = S('CHOSE_STARTER_SCRIPT');
        return;
      }
      e.doNotWaitForButtonPress = false;
      yield* e.printText('OaksLabEeveePokeBallText.Text');
    },
    *OaksLabOak1Text(e) {
      const L = (s: string) => `OaksLabOak1Text.${s}`;
      const owned = e.pokedexOwnedCount();
      if (e.checkEvent('EVENT_PALLET_AFTER_GETTING_POKEBALLS') || owned >= 2) {
        yield* e.printText(L('HowIsYourPokedexComingText'));
        e.doNotWaitForButtonPress = true;
        yield* e.displayDexRating();
        return;
      }
      if (e.isItemInBag('POKE_BALL') || owned >= 2) {
        yield* e.printText(L('ComeSeeMeSometimesText'));
        return;
      }
      if (e.checkEvent('EVENT_BEAT_ROUTE22_RIVAL_1ST_BATTLE')) {
        if (e.checkAndSetEvent('EVENT_GOT_POKEBALLS_FROM_OAK')) {
          yield* e.printText(L('ComeSeeMeSometimesText'));
          return;
        }
        e.giveItem('POKE_BALL', 5);
        yield* e.printText(L('GivePokeballsText'));
        return;
      }
      if (e.checkEvent('EVENT_GOT_POKEDEX')) {
        yield* e.printText(L('PokemonAroundTheWorldText'));
        return;
      }
      if (e.checkEvent('EVENT_BATTLED_RIVAL_IN_OAKS_LAB')) {
        if (!e.isItemInBag('OAKS_PARCEL')) {
          yield* e.printText(L('YouShouldTalkToIt'));
          return;
        }
        yield* e.printText(L('DeliverParcelText'));
        e.removeItem('OAKS_PARCEL', 1);
        e.curScript = S('RIVAL_ARRIVES_AT_OAKS_REQUEST');
        return;
      }
      yield* e.printText(e.getVar('flag:GOT_STARTER') ? L('YourPokemonCanFightText') : L('GoAheadItsYours'));
    },
    OaksLabPokedexText: printOnly('OaksLabPokedexText.Text'),
    OaksLabGirlText: printOnly('OaksLabGirlText.Text'),
    OaksLabRivalFedUpWithWaitingText: printOnly('OaksLabRivalFedUpWithWaitingText.Text'),
    OaksLabOakChooseMonText: printOnly('OaksLabOakChooseMonText.Text'),
    OaksLabRivalWhatAboutMeText: printOnly('OaksLabRivalWhatAboutMeText.Text'),
    OaksLabOakBePatientText: printOnly('OaksLabOakBePatientText.Text'),
    OaksLabOakDontGoAwayYetText: printOnly('OaksLabOakDontGoAwayYetText.Text'),
    OaksLabRivalIllTakeYouOnText: printOnly('OaksLabRivalIllTakeYouOnText.Text'),
    OaksLabRivalSmellYouLaterText: printOnly('OaksLabRivalSmellYouLaterText.Text'),
    OaksLabPikachuDislikesPokeballsText2: printOnly('OaksLabPikachuDislikesPokeballsText2.Text'),
    OaksLabScientistText: printOnly('OaksLabScientistText.Text'),
    *OaksLabRivalReceivedMonText(e) {
      for (let i = 1; i <= 5; i++) yield* e.printText(`OaksLabRivalTakesText${i}`);
    },
    *OaksLabPlayerReceivedMonText(e) {
      e.setVar('wPlayerStarter', c('pokemon', 'STARTER_PIKACHU'));
      e.getMonName(c('pokemon', 'STARTER_PIKACHU'));
      e.doNotWaitForButtonPress = true;
      yield* e.printText('OaksLabOakGivesText');
      yield* e.printText('OaksLabReceivedText');
      yield* e.addPartyMon('STARTER_PIKACHU', 5, true);
      e.setPartyCatchRate(0, c('item', 'LIGHT_BALL_GSC'));
      e.disablePikachuOverworldSpriteDrawing();
      e.setEvent('EVENT_GOT_STARTER');
      e.setVar('flag:GOT_STARTER', 1);
    },
    *OaksLabPikachuDislikesPokeballsText1(e) {
      yield* playPikachuCry(e.e, pikachuCry(2));
      yield* e.printText('OaksLabPikachuDislikesPokeballsText1.Text');
    },
  },
};
