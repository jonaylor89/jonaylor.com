/**
 * The Pokémon League: scripts/IndigoPlateauLobby.asm, LoreleisRoom.asm,
 * BrunosRoom.asm, AgathasRoom.asm, LancesRoom.asm, ChampionsRoom.asm and
 * HallOfFame.asm.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_UP } from '../../engine/pad';
import { NONE, NPC_MOVEMENT_UP, STAY } from '../../engine/sprites';
import { checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle } from '../../engine/trainers';
import { resetEventRange } from '../gym';
import { hallOfFamePC } from '../../ui/hallOfFame';
import { c } from '../../rom/constants';

const ALL_INPUT = PAD_BUTTONS | PAD_CTRL_PAD;
const ELITE4_STARTED = () => 1 << c('ram', 'BIT_STARTED_ELITE_4');

export const IndigoPlateauLobby: MapScript = {
  map: 'INDIGO_PLATEAU_LOBBY',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    if (!e.takeMapLoaded2()) return;
    e.resetEvent('EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
    // a challenge that was started before is reset
    const flags = e.getVar('wElite4Flags');
    if (!(flags & ELITE4_STARTED())) return;
    e.setVar('wElite4Flags', flags & ~ELITE4_STARTED());
    resetEventRange(e, 'INDIGO_PLATEAU_EVENTS_START', 'EVENT_LANCES_ROOM_LOCK_DOOR');
  },
};

/** SetSpriteMovementBytesToFF */
function stay(e: ScriptEnv, obj: string): void {
  const s = e.sprite(obj);
  s.movementByte1 = STAY;
  s.movementByte2 = NONE;
}

interface E4Room {
  map: string;
  /** LORELEISROOM etc. (script and text constant infix) */
  id: string;
  /** EVENT_BEAT_<ROOM>_TRAINER_0 */
  beatEvent: string;
  autowalkEvent: string;
  /** exit block when beaten / when not */
  exitOpen: number;
  exitShut: number;
  /** TEXT_* of the leader and of "Don't run away!" */
  leaderText: string;
  dontRunAwayText: string;
  /** Lorelei writes all six UPs; Bruno and Agatha only write the first of the six */
  fullWalk: boolean;
  onEnter?: (e: ScriptEnv) => void;
  afterWin?: (e: ScriptEnv) => void;
}

function e4Room(r: E4Room): MapScript {
  const S = (n: string) => c('map_script', `SCRIPT_${r.id}_${n}`);
  const scripts: ScriptFn[] = [
    // <Room>DefaultScript
    function* (e) {
      const i = e.arePlayerCoordsInArray([
        [10, 4],
        [10, 5],
        [11, 4],
        [11, 5],
      ]);
      if (!i) return yield* checkFightingMapTrainers(e);
      e.joyHeld = 0;
      e.ram.joyPressed = 0;
      e.setSimulatedJoypad([0], 0);
      if (i >= 3 && !e.checkEvent(r.autowalkEvent)) {
        e.setEvent(r.autowalkEvent);
        // <Room>ScriptWalkIntoRoom: six steps up
        e.setSimulatedJoypad(r.fullWalk ? Array(6).fill(PAD_UP) : [PAD_UP], 6);
        e.startSimulatingJoypadStates();
        e.curScript = S('PLAYER_IS_MOVING');
        return;
      }
      yield* e.displayTextID(r.dontRunAwayText);
      e.setSimulatedJoypad([PAD_UP], 1);
      e.startSimulatingJoypadStates();
      e.curScript = S('PLAYER_IS_MOVING');
    },
    displayEnemyTrainerTextAndStartBattle,
    // <Room><Leader>EndBattleScript
    function* (e) {
      yield* endTrainerBattle(e);
      if (e.ram.isInBattle === 0xff) {
        e.curScript = 0;
        return;
      }
      yield* e.displayTextID(r.leaderText);
      r.afterWin?.(e);
    },
    // <Room>PlayerIsMovingScript
    function* (e) {
      if (e.simulatedIndex) return;
      yield* e.delay3();
      e.joyIgnore = 0;
      e.curScript = 0;
    },
    function* () {},
  ];
  return {
    map: r.map,
    *run(e) {
      // <Leader>ShowOrHideExitBlock
      if (e.takeMapLoaded1()) {
        r.onEnter?.(e);
        e.e.world.replaceBlock(2, 0, e.checkEvent(r.beatEvent) ? r.exitOpen : r.exitShut);
      }
      e.enableAutoTextBoxDrawing();
      yield* scripts[e.curScript](e);
    },
  };
}

export const LoreleisRoom = e4Room({
  map: 'LORELEIS_ROOM',
  id: 'LORELEISROOM',
  beatEvent: 'EVENT_BEAT_LORELEIS_ROOM_TRAINER_0',
  autowalkEvent: 'EVENT_AUTOWALKED_INTO_LORELEIS_ROOM',
  exitOpen: 0x05,
  exitShut: 0x24,
  leaderText: 'TEXT_LORELEISROOM_LORELEI',
  dontRunAwayText: 'TEXT_LORELEISROOM_DONT_RUN_AWAY',
  fullWalk: true,
  onEnter: (e) => e.setVar('wElite4Flags', e.getVar('wElite4Flags') | ELITE4_STARTED()),
});

export const BrunosRoom = e4Room({
  map: 'BRUNOS_ROOM',
  id: 'BRUNOSROOM',
  beatEvent: 'EVENT_BEAT_BRUNOS_ROOM_TRAINER_0',
  autowalkEvent: 'EVENT_AUTOWALKED_INTO_BRUNOS_ROOM',
  exitOpen: 0x05,
  exitShut: 0x24,
  leaderText: 'TEXT_BRUNOSROOM_BRUNO',
  dontRunAwayText: 'TEXT_BRUNOSROOM_BRUNO_DONT_RUN_AWAY',
  fullWalk: false,
});

export const AgathasRoom = e4Room({
  map: 'AGATHAS_ROOM',
  id: 'AGATHASROOM',
  beatEvent: 'EVENT_BEAT_AGATHAS_ROOM_TRAINER_0',
  autowalkEvent: 'EVENT_AUTOWALKED_INTO_AGATHAS_ROOM',
  exitOpen: 0x0e,
  exitShut: 0x3b,
  leaderText: 'TEXT_AGATHASROOM_AGATHA',
  dontRunAwayText: 'TEXT_AGATHASROOM_AGATHA_DONT_RUN_AWAY',
  fullWalk: false,
  afterWin: (e) => e.setMapScript('CHAMPIONS_ROOM', 'SCRIPT_CHAMPIONSROOM_PLAYER_ENTERS'),
});

// ------------------------------------------------------------------ Lance
const SL = (n: string) => c('map_script', `SCRIPT_LANCESROOM_${n}`);

function lanceEntranceBlocks(e: ScriptEnv): void {
  const [a, b] = e.checkEvent('EVENT_LANCES_ROOM_LOCK_DOOR') ? [0x72, 0x73] : [0x31, 0x32];
  e.e.world.replaceBlock(2, 6, a);
  e.e.world.replaceBlock(3, 6, b);
}

const lanceScripts: ScriptFn[] = [
  // LancesRoomDefaultScript
  function* (e) {
    if (e.checkEvent('EVENT_BEAT_LANCE')) return;
    const i = e.arePlayerCoordsInArray([
      [1, 5],
      [2, 6],
      [11, 5],
      [11, 6],
      [16, 24],
    ]);
    if (!i) return yield* checkFightingMapTrainers(e);
    e.joyHeld = 0;
    if (i < 3) return yield* e.displayTextID('TEXT_LANCESROOM_LANCE');
    if (i === 5) {
      // WalkToLance: down the hallway
      e.joyIgnore = ALL_INPUT;
      e.simulateRLE([PAD_UP, 13, PAD_LEFT, 12, PAD_DOWN, 7, PAD_LEFT, 6]);
      e.startSimulatingJoypadStates();
      e.curScript = SL('PLAYER_IS_MOVING');
      return;
    }
    if (e.checkEvent('EVENT_LANCES_ROOM_LOCK_DOOR')) return;
    e.setEvent('EVENT_LANCES_ROOM_LOCK_DOOR');
    e.playSound('go_inside');
    lanceEntranceBlocks(e);
  },
  displayEnemyTrainerTextAndStartBattle,
  // LancesRoomLanceEndBattleScript
  function* (e) {
    yield* endTrainerBattle(e);
    if (e.ram.isInBattle === 0xff) {
      e.curScript = 0;
      return;
    }
    yield* e.displayTextID('TEXT_LANCESROOM_LANCE');
  },
  // LancesRoomPlayerIsMovingScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delay3();
    e.joyIgnore = 0;
    e.curScript = SL('DEFAULT');
  },
  function* () {},
];

export const LancesRoom: MapScript = {
  map: 'LANCES_ROOM',
  *run(e) {
    if (e.takeMapLoaded1()) lanceEntranceBlocks(e);
    e.enableAutoTextBoxDrawing();
    yield* lanceScripts[e.curScript](e);
  },
  texts: {
    *LancesRoomLanceAfterBattleText(e) {
      e.setEvent('EVENT_BEAT_LANCE');
    },
  },
};

// ------------------------------------------------------------------ the Champion
const SC = (n: string) => c('map_script', `SCRIPT_CHAMPIONSROOM_${n}`);

/** ChampionsRoom_DisplayTextID_AllowABSelectStart */
function* championText(e: ScriptEnv, id: string) {
  e.joyIgnore = PAD_CTRL_PAD;
  yield* e.displayTextID(id);
  e.joyIgnore = ALL_INPUT;
}

const championScripts: ScriptFn[] = [
  function* () {},
  // ChampionsRoomPlayerEntersScript
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    e.simulateRLE([PAD_UP, 1, PAD_RIGHT, 1, PAD_UP, 3]);
    e.startSimulatingJoypadStates();
    e.curScript = SC('RIVAL_READY_TO_BATTLE');
  },
  // ChampionsRoomRivalReadyToBattleScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delay3();
    e.joyIgnore = 0;
    e.e.store.dispatch({ type: 'setOptions', options: { battleAnimation: true } }, { undoable: false });
    yield* e.displayTextID('TEXT_CHAMPIONSROOM_RIVAL');
    yield* e.delay3();
    e.startTrainerBattle('OPP_RIVAL3', e.getVar('wRivalStarter'), 'RivalDefeatedText', 'RivalVictoryText');
    e.joyHeld = 0;
    e.curScript = SC('RIVAL_DEFEATED');
  },
  // ChampionsRoomRivalDefeatedScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) {
      e.joyIgnore = 0;
      e.curScript = 0;
      return;
    }
    e.updateSprites();
    e.setEvent('EVENT_BEAT_CHAMPION_RIVAL');
    e.joyIgnore = PAD_CTRL_PAD;
    yield* championText(e, 'TEXT_CHAMPIONSROOM_RIVAL');
    stay(e, 'CHAMPIONSROOM_RIVAL');
    e.curScript = SC('OAK_ARRIVES');
  },
  // ChampionsRoomOakArrivesScript
  function* (e) {
    e.playMusic('MUSIC_CITIES1'); // Music_Cities1AlternateTempo
    yield* championText(e, 'TEXT_CHAMPIONSROOM_OAK');
    stay(e, 'CHAMPIONSROOM_OAK');
    e.moveSprite('CHAMPIONSROOM_OAK', Array(5).fill(NPC_MOVEMENT_UP));
    e.showObject('TOGGLE_CHAMPIONS_ROOM_OAK');
    e.curScript = SC('OAK_CONGRATULATES_PLAYER');
  },
  // ChampionsRoomOakCongratulatesPlayerScript
  function* (e) {
    if (e.npcMoving) return;
    e.setPlayerMovingDirection('left');
    yield* e.setSpriteFacingDirectionAndDelay('CHAMPIONSROOM_RIVAL', 'left');
    yield* e.setSpriteFacingDirectionAndDelay('CHAMPIONSROOM_OAK', 'down');
    yield* championText(e, 'TEXT_CHAMPIONSROOM_OAK_CONGRATULATES_PLAYER');
    e.curScript = SC('OAK_DISAPPOINTED_WITH_RIVAL');
  },
  // ChampionsRoomOakDisappointedWithRivalScript
  function* (e) {
    yield* e.setSpriteFacingDirectionAndDelay('CHAMPIONSROOM_OAK', 'right');
    yield* championText(e, 'TEXT_CHAMPIONSROOM_OAK_DISAPPOINTED_WITH_RIVAL');
    e.curScript = SC('OAK_COME_WITH_ME');
  },
  // ChampionsRoomOakComeWithMeScript
  function* (e) {
    yield* e.setSpriteFacingDirectionAndDelay('CHAMPIONSROOM_OAK', 'down');
    yield* championText(e, 'TEXT_CHAMPIONSROOM_OAK_COME_WITH_ME');
    e.moveSprite('CHAMPIONSROOM_OAK', [NPC_MOVEMENT_UP, NPC_MOVEMENT_UP]);
    e.curScript = SC('OAK_EXITS');
  },
  // ChampionsRoomOakExitsScript
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_CHAMPIONS_ROOM_OAK');
    e.curScript = SC('PLAYER_FOLLOWS_OAK');
  },
  // ChampionsRoomPlayerFollowsOakScript
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    e.simulateRLE([PAD_UP, 4, PAD_LEFT, 1]);
    e.startSimulatingJoypadStates();
    e.curScript = SC('CLEANUP_SCRIPT');
  },
  // ChampionsRoomCleanupScript
  function* (e) {
    if (e.simulatedIndex) return;
    e.joyIgnore = 0;
    e.curScript = SC('DEFAULT');
  },
];

export const ChampionsRoom: MapScript = {
  map: 'CHAMPIONS_ROOM',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* championScripts[e.curScript](e);
  },
  texts: {
    *ChampionsRoomRivalText(e) {
      yield* e.printText(e.checkEvent('EVENT_BEAT_CHAMPION_RIVAL') ? 'ChampionsRoomRivalAfterBattleText' : 'ChampionsRoomRivalText.IntroText');
    },
    *ChampionsRoomOakCongratulatesPlayerText(e) {
      e.getMonName(e.getVar('wPlayerStarter'));
      yield* e.printText('ChampionsRoomOakCongratulatesPlayerText.Text');
    },
  },
};

// ------------------------------------------------------------------ Hall of Fame
const SH = (n: string) => c('map_script', `SCRIPT_HALLOFFAME_${n}`);

const hallOfFameScripts: ScriptFn[] = [
  // HallOfFameDefaultScript
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    e.simulateRLE([PAD_UP, 5]);
    e.startSimulatingJoypadStates();
    e.curScript = SH('OAK_CONGRATULATIONS');
  },
  // HallOfFameOakCongratulationsScript
  function* (e) {
    if (e.simulatedIndex) return;
    e.setPlayerMovingDirection('right');
    stay(e, 'HALLOFFAME_OAK');
    yield* e.setSpriteFacingDirectionAndDelay('HALLOFFAME_OAK', 'left');
    yield* e.delay3();
    e.joyIgnore = 0;
    e.setPlayerMovingDirection('right');
    yield* e.displayTextID('TEXT_HALLOFFAME_OAK');
    e.joyIgnore = ALL_INPUT;
    e.hideObject('TOGGLE_CERULEAN_CAVE_GUY');
    e.curScript = SH('RESET_EVENTS_AND_SAVE');
  },
  // HallOfFameResetEventsAndSaveScript
  function* (e) {
    yield* e.delay3();
    e.joyIgnore = 0;
    yield* hallOfFamePC(e.e);
    e.noMapMusic = false;
    e.setVar('wElite4Flags', e.getVar('wElite4Flags') | (1 << c('ram', 'BIT_UNUSED_BEAT_ELITE_4')));
    for (const m of ['LORELEIS_ROOM', 'BRUNOS_ROOM', 'AGATHAS_ROOM', 'LANCES_ROOM', 'HALL_OF_FAME']) e.e.setMapScriptOf(m, 0);
    resetEventRange(e, 'INDIGO_PLATEAU_EVENTS_START', 'INDIGO_PLATEAU_EVENTS_END');
    e.setVar('wLastBlackoutMap', c('map', 'PALLET_TOWN'));
    yield* e.e.saveGameData();
    yield* e.delayFrames(600);
    yield* e.e.waitForTextScrollButtonPress();
    yield* e.e.softReset();
  },
  function* () {},
];

export const HallOfFame: MapScript = {
  map: 'HALL_OF_FAME',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* hallOfFameScripts[e.curScript](e);
  },
};
