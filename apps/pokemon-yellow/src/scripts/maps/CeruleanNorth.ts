/**
 * North of Cerulean: Nugget Bridge (scripts/Route24.asm), Route 25
 * (scripts/Route25.asm) and Bill's house with the Cell Separator
 * (scripts/BillsHouse.asm, BillsHouse_2.asm), including Yellow's Pikachu scenes.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import type { Co } from '../../engine/Engine';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_DOWN, PAD_RIGHT, PAD_SELECT, PAD_START } from '../../engine/pad';
import { NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP, FACING_DOWN, FACING_RIGHT, FACING_UP } from '../../engine/sprites';
import { c } from '../../rom/constants';
import {
  checkFightingMapTrainers,
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  engageMapTrainer,
  initBattleEnemyParameters,
  trainerMapScript,
} from '../../engine/trainers';
import { PIKA_NOT_FOLLOWING } from '../../engine/pikachu';
import { talkToPikachu } from '../../engine/pikachuEmotions';
import { isStarterPikachu } from '../../game/pikachu';

const LOST_BATTLE = 0xff;
/** PIKAMOVEMENT_* commands, $3f-terminated */
const pikaMove = (...names: string[]) => [...names.map((n) => c('pikachu_emotion', `PIKAMOVEMENT_${n}`)), 0x3f];
const pikachuNotFollowing = (e: ScriptEnv) => (e.e.ram.pikachuOverworldStateFlags & PIKA_NOT_FOLLOWING) !== 0;

// ------------------------------------------------------------------ Route 24
const R24 = (n: string) => c('map_script', `SCRIPT_ROUTE24_${n}`);

const route24Scripts: ScriptFn[] = [
  // Route24DefaultScript: the Rocket stops you at the bridge's end until you take the Nugget
  function* (e) {
    if (e.checkEvent('EVENT_GOT_NUGGET') || !e.arePlayerCoordsInArray([[15, 10]])) return yield* checkFightingMapTrainers(e);
    e.joyHeld = 0;
    yield* e.displayTextID('TEXT_ROUTE24_COOLTRAINER_M1');
    if (!e.checkEvent('EVENT_NUGGET_REWARD_AVAILABLE')) return;
    e.resetEvent('EVENT_NUGGET_REWARD_AVAILABLE');
    e.setSimulatedJoypad([PAD_DOWN], 1);
    e.startSimulatingJoypadStates();
    e.curScript = R24('PLAYER_MOVING');
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  // Route24AfterRocketBattleScript
  function* (e) {
    if (e.ram.isInBattle === LOST_BATTLE) {
      e.joyIgnore = 0;
      e.curScript = R24('DEFAULT');
      return;
    }
    e.updateSprites();
    e.joyIgnore = PAD_CTRL_PAD;
    e.setEvent('EVENT_BEAT_ROUTE24_ROCKET');
    yield* e.displayTextID('TEXT_ROUTE24_COOLTRAINER_M1');
    e.joyIgnore = 0;
    e.curScript = R24('DEFAULT');
  },
  // Route24PlayerMovingScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delayFrames(3);
    e.curScript = R24('DEFAULT');
  },
];

/** Route24CooltrainerM1Text: the Nugget, then the Team Rocket recruitment battle */
function* route24Rocket(e: ScriptEnv): Co {
  const T = (n: string) => `Route24CooltrainerM1Text.${n}`;
  e.resetEvent('EVENT_NUGGET_REWARD_AVAILABLE');
  if (e.checkEvent('EVENT_GOT_NUGGET')) return yield* e.printText(T('YouCouldBecomeATopLeaderText'));
  yield* e.printText(T('YouBeatOurContestText'));
  if (!e.giveItem('NUGGET')) {
    yield* e.printText(T('NoRoomText'));
    e.setEvent('EVENT_NUGGET_REWARD_AVAILABLE');
    return;
  }
  e.setEvent('EVENT_GOT_NUGGET');
  yield* e.printText(T('ReceivedNuggetText'));
  yield* e.printText(T('JoinTeamRocketText'));
  const r = e.ram;
  r.talkedToTrainer = true;
  r.printEndBattleText = true;
  r.endBattleWinText = T('DefeatedText');
  r.endBattleLoseText = T('DefeatedText');
  engageMapTrainer(e, r.spriteIndex);
  initBattleEnemyParameters(e);
  e.joyHeld = 0;
  e.curScript = R24('AFTER_ROCKET_BATTLE');
}

/** Damian (Yellow): gives CHARMANDER once */
function* route24Damian(e: ScriptEnv): Co {
  if (e.checkEvent('EVENT_54F')) return yield* e.printText('Route24Text_515ee');
  yield* e.printText('Route24Text_515de');
  if (!(yield* e.yesNoChoice())) return yield* e.printText('Route24Text_515e9');
  e.getMonName(c('pokemon', 'CHARMANDER'));
  e.doNotWaitForButtonPress = true;
  const before = e.e.state.party.length;
  if (!(yield* e.givePokemon('CHARMANDER', 10))) return;
  if (e.e.state.party.length === before) yield* e.e.waitForTextScrollButtonPress(); // wAddedToParty == 0
  e.doNotWaitForButtonPress = true;
  yield* e.printText('Route24Text_515e3');
  e.setEvent('EVENT_54F');
}

export const Route24: MapScript = {
  map: 'ROUTE_24',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    const fn = route24Scripts[e.curScript];
    if (!fn) throw new Error(`ROUTE_24 script ${e.curScript}`);
    yield* fn(e);
  },
  texts: { Route24CooltrainerM1Text: route24Rocket, Route24CooltrainerM4Text: route24Damian },
};

// ------------------------------------------------------------------ Route 25
/** Route25ToggleBillsScript: Bill appears as a Pokémon, then as himself after the SS Ticket. */
function* toggleBills(e: ScriptEnv): Co {
  e.e.ram.pikachuMapScriptActive = false;
  e.setMapScript('BILLS_HOUSE', 'SCRIPT_BILLSHOUSE_SCRIPT0');
  if (!e.takeMapLoaded2()) return;
  if (e.checkEvent('EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING')) return;
  if (!e.checkEvent('EVENT_MET_BILL_2')) {
    e.resetEvent('EVENT_BILL_SAID_USE_CELL_SEPARATOR');
    e.showObject('TOGGLE_BILL_POKEMON');
    return;
  }
  if (!e.checkEvent('EVENT_GOT_SS_TICKET')) return;
  e.setEvent('EVENT_LEFT_BILLS_HOUSE_AFTER_HELPING');
  e.hideObject('TOGGLE_NUGGET_BRIDGE_GUY');
  e.hideObject('TOGGLE_BILL_1');
  e.showObject('TOGGLE_BILL_2');
}

const route25 = trainerMapScript('ROUTE_25');
export const Route25: MapScript = {
  ...route25,
  *run(e) {
    yield* route25.run!(e);
    yield* toggleBills(e);
  },
};

// ------------------------------------------------------------------ Bill's house
const B = (n: number) => c('map_script', `SCRIPT_BILLSHOUSE_SCRIPT${n}`);
const BILL_POKEMON = 'BILLSHOUSE_BILL_POKEMON';
const BILL1 = 'BILLSHOUSE_BILL1';

const billsScripts: ScriptFn[] = [
  // BillsHouseScript0: a confused Pikachu wanders off toward the machine
  function* (e) {
    // CheckPikachuStatusCondition: not when the starter Pikachu has a status ailment
    const st = e.e.state;
    if (e.pikachuSpawnStarter && !st.party.some((m) => isStarterPikachu(st, m) && m.status)) {
      // BillsHousePikachuConfused
      e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
      e.e.ram.playerMovingDirection = 0;
      e.updateSprites();
      e.updateSprites();
      yield* e.e.pikachu.applyMovementData(pikaMove('DELAY', 'STEP_RIGHT', 'STEP_RIGHT', 'STEP_RIGHT', 'STEP_UP'));
      yield* e.emotionBubble(e.e.pikachuSlot, 'QUESTION_BUBBLE');
      e.e.ram.pikachuOverworldStateFlags |= PIKA_NOT_FOLLOWING; // DisablePikachuFollowingPlayer
      yield* talkToPikachu(e.e); // InitializePikachuTextID
    }
    e.joyIgnore = 0;
    e.curScript = B(1);
  },
  // BillsHouseScript1
  function* () {},
  // BillsHouseScript2: Bill walks into the Cell Separator
  function* (e) {
    e.joyIgnore = PAD_BUTTONS | PAD_CTRL_PAD;
    let path = [NPC_MOVEMENT_UP, NPC_MOVEMENT_UP, NPC_MOVEMENT_UP];
    if (e.sprite(0).facing === FACING_DOWN) {
      if (!pikachuNotFollowing(e)) {
        // BillsHousePikachuWatchPlayer
        yield* e.e.pikachu.tryApplyMovementData(FACING_UP, pikaMove('DELAY', 'STEP_LEFT', 'STEP_DOWN', 'LOOK_RIGHT'));
        yield* e.e.pikachu.tryApplyMovementData(FACING_RIGHT, pikaMove('DELAY', 'STEP_UP', 'STEP_LEFT', 'STEP_LEFT', 'STEP_DOWN', 'LOOK_RIGHT'));
      }
      path = [NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP, NPC_MOVEMENT_UP, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_UP];
    }
    e.moveSprite(BILL_POKEMON, path);
    e.curScript = B(3);
  },
  // BillsHouseScript3
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_BILL_POKEMON');
    if (pikachuNotFollowing(e)) {
      // the confused Pikachu follows Bill into the machine
      const down = e.sprite(0).facing === FACING_DOWN;
      yield* e.e.pikachu.applyMovementData(
        down
          ? pikaMove('DELAY', 'STEP_UP', 'STEP_LEFT', 'STEP_UP', 'STEP_UP', 'STEP_RIGHT', 'LOOK_UP')
          : pikaMove('DELAY', 'STEP_UP', 'STEP_UP', 'STEP_UP'),
      );
      yield* talkToPikachu(e.e);
    }
    e.joyIgnore = 0;
    e.setEvent('EVENT_BILL_SAID_USE_CELL_SEPARATOR');
    e.curScript = B(4);
  },
  // BillsHouseScript4: wait for the player to run the Cell Separator (BillsHouseCellSeparator hidden event)
  function* (e) {
    if (!e.checkEvent('EVENT_USED_CELL_SEPARATOR_ON_BILL')) return;
    e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
    e.curScript = B(5);
  },
  // BillsHouseScript5: Bill steps out of the machine
  function* (e) {
    e.setSpriteMapPosition(BILL1, 5, 6);
    e.showObject('TOGGLE_BILL_1');
    yield* e.delayFrames(8);
    if (e.pikachuSpawnStarter && pikachuNotFollowing(e)) {
      yield* e.setSpriteFacingDirectionAndDelay(BILL1, 'down');
      yield* e.e.pikachu.applyMovementData(pikaMove('DELAY', 'LOOK_LEFT'));
      yield* e.emotionBubble(e.e.pikachuSlot, 'EXCLAMATION_BUBBLE');
      yield* talkToPikachu(e.e);
    }
    e.moveSprite(BILL1, [NPC_MOVEMENT_DOWN, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_DOWN]);
    e.curScript = B(6);
  },
  // BillsHouseScript6
  function* (e) {
    if (e.npcMoving) return;
    e.setEvent('EVENT_MET_BILL_2');
    e.setEvent('EVENT_MET_BILL');
    e.curScript = B(7);
  },
  // BillsHouseScript7: three steps right toward Bill
  function* (e) {
    e.e.ram.playerMovingDirection = 0;
    e.setPlayerFacing('up');
    e.joyIgnore = PAD_SELECT | PAD_START | PAD_CTRL_PAD;
    e.simulateRLE([PAD_RIGHT, 3]);
    e.startSimulatingJoypadStates();
    e.curScript = B(8);
  },
  // BillsHouseScript8
  function* (e) {
    if (e.simulatedIndex) return;
    e.e.ram.playerMovingDirection = 0;
    e.setPlayerFacing('up');
    yield* e.setSpriteFacingDirectionAndDelay(BILL1, 'down');
    e.joyIgnore = 0;
    yield* e.displayTextID('TEXT_BILLSHOUSE_BILL_SS_TICKET');
    e.curScript = B(9);
  },
  // BillsHouseScript9
  function* () {},
];

export const BillsHouse: MapScript = {
  map: 'BILLS_HOUSE',
  *run(e) {
    // BillsHouse_CheckMetBill (once per visit, while the Pikachu map script runs)
    if (!e.e.ram.pikachuMapScriptActive) {
      e.e.ram.pikachuMapScriptActive = true;
      e.curScript = B(e.checkEvent('EVENT_MET_BILL_2') ? 9 : 0);
    }
    e.enableAutoTextBoxDrawing();
    const fn = billsScripts[e.curScript];
    if (!fn) throw new Error(`BILLS_HOUSE script ${e.curScript}`);
    yield* fn(e);
  },
  texts: {
    // BillsHousePrintBillPokemonText
    *BillsHouseBillPokemonText(e) {
      const T = (n: string) => `BillsHousePrintBillPokemonText.${n}`;
      yield* e.printText(T('ImNotAPokemonText'));
      if (!(yield* e.yesNoChoice())) yield* e.printText(T('NoYouGottaHelpText'));
      yield* e.printText(T('UseSeparationSystemText'));
      e.curScript = B(2);
    },
    // BillsHousePrintBillSSTicketText
    *BillsHouseBillSSTicketText(e) {
      const T = (n: string) => `BillsHousePrintBillSSTicketText.${n}`;
      if (!e.checkEvent('EVENT_GOT_SS_TICKET')) {
        yield* e.printText(T('ThankYouText'));
        if (!e.giveItem('S_S_TICKET')) return yield* e.printText(T('SSTicketNoRoomText'));
        yield* e.printText(T('SSTicketReceivedText'));
        e.setEvent('EVENT_GOT_SS_TICKET');
        e.showObject('TOGGLE_CERULEAN_GUARD_1');
        e.hideObject('TOGGLE_CERULEAN_GUARD_2');
      }
      yield* e.printText(T('WhyDontYouGoInsteadOfMeText'));
    },
    *BillsHouseBillCheckOutMyRarePokemonText(e) {
      yield* e.printText('BillsHousePrintBillCheckOutMyRarePokemonText.text');
    },
  },
};
