/**
 * Pokémon Tower: scripts/PokemonTower2F.asm (the rival), PokemonTower5F.asm (the
 * purified zone), PokemonTower6F.asm (the ghost Marowak) and PokemonTower7F.asm
 * (Jessie & James, then Mr. Fuji).
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_RIGHT, PAD_SELECT, PAD_START } from '../../engine/pad';
import { FACING_DOWN, FACING_LEFT, FACING_RIGHT, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_RIGHT } from '../../engine/sprites';
import { checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle } from '../../engine/trainers';
import { c } from '../../rom/constants';

const ALL_INPUT = PAD_BUTTONS | PAD_CTRL_PAD;
const NO_PAD = PAD_SELECT | PAD_START | PAD_CTRL_PAD;

function standFacing(e: ScriptEnv, slot: number, facing: number): void {
  const s = e.e.sprites[slot];
  if (!s) return;
  s.movementStatus = 2;
  s.facing = facing;
}

// ------------------------------------------------------------------ 2F
const S2 = (n: string) => c('map_script', `SCRIPT_POKEMONTOWER2F_${n}`);
const D = NPC_MOVEMENT_DOWN;
const R = NPC_MOVEMENT_RIGHT;

const tower2FScripts: ScriptFn[] = [
  // PokemonTower2FDefaultScript
  function* (e) {
    if (e.checkEvent('EVENT_BEAT_POKEMON_TOWER_RIVAL')) return;
    // the list ends in $0F rather than $ff; the bytes after it never match a square on this floor
    const i = e.arePlayerCoordsInArray([
      [5, 15],
      [6, 14],
    ]);
    if (!i) return;
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL');
    e.resetEvent('EVENT_POKEMON_TOWER_RIVAL_ON_LEFT');
    let dir: 'up' | 'left' = 'up';
    let facing: 'down' | 'right' = 'down';
    if (i === 1) {
      // the rival is on the left, the player on the right
      e.setEvent('EVENT_POKEMON_TOWER_RIVAL_ON_LEFT');
      dir = 'left';
      facing = 'right';
    }
    e.setPlayerMovingDirection(dir);
    yield* e.setSpriteFacingDirectionAndDelay('POKEMONTOWER2F_RIVAL', facing);
    yield* e.displayTextID('TEXT_POKEMONTOWER2F_RIVAL');
    e.joyHeld = 0;
  },
  // PokemonTower2FDefeatedRivalScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) {
      e.joyIgnore = 0;
      e.curScript = 0;
      return;
    }
    e.joyIgnore = PAD_CTRL_PAD;
    e.setEvent('EVENT_BEAT_POKEMON_TOWER_RIVAL');
    yield* e.displayTextID('TEXT_POKEMONTOWER2F_RIVAL');
    let path = [D, D, R, R, R, R, D, D];
    if (!e.checkEvent('EVENT_POKEMON_TOWER_RIVAL_ON_LEFT')) {
      // PokemonTower2FPikachuMovementScript
      yield* e.e.pikachu.tryApplyMovementData(FACING_RIGHT, [0x00, 0x1d, 0x1f, 0x38, 0x3f], false);
      path = [R, D, D, R, D, D, R, R];
    }
    e.moveSprite('POKEMONTOWER2F_RIVAL', path);
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL'); // Music_RivalAlternateStart
    e.curScript = S2('RIVAL_EXITS');
  },
  // PokemonTower2FRivalExitsScript
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_POKEMON_TOWER_2F_RIVAL');
    e.joyIgnore = 0;
    e.playDefaultMusic();
    e.curScript = S2('DEFAULT');
  },
];

export const PokemonTower2F: MapScript = {
  map: 'POKEMON_TOWER_2F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* tower2FScripts[e.curScript](e);
  },
  texts: {
    *PokemonTower2FRivalText(e) {
      const T = (n: string) => `PokemonTower2FRivalText.${n}`;
      if (e.checkEvent('EVENT_BEAT_POKEMON_TOWER_RIVAL')) return yield* e.printText(T('HowsYourDexText'));
      yield* e.printText(T('WhatBringsYouHereText'));
      e.startTrainerBattle('OPP_RIVAL2', e.getVar('wRivalStarter') + 1, T('DefeatedText'), T('VictoryText'));
      e.curScript = S2('DEFEATED_RIVAL');
    },
  },
};

// ------------------------------------------------------------------ 5F
const PURIFIED_ZONE: [number, number][] = [
  [8, 10],
  [8, 11],
  [9, 10],
  [9, 11],
];

const tower5FScripts: ScriptFn[] = [
  // PokemonTower5FDefaultScript
  function* (e) {
    if (!e.arePlayerCoordsInArray(PURIFIED_ZONE)) {
      e.noBattles = false;
      e.resetEvent('EVENT_IN_PURIFIED_ZONE');
      return yield* checkFightingMapTrainers(e);
    }
    if (e.checkEvent('EVENT_IN_PURIFIED_ZONE')) return;
    e.setEvent('EVENT_IN_PURIFIED_ZONE');
    e.joyHeld = 0;
    e.joyIgnore = PAD_CTRL_PAD;
    e.noBattles = true;
    e.healParty();
    yield* e.fadeToWhite();
    yield* e.delay3();
    yield* e.delay3();
    yield* e.fadeFromWhite();
    yield* e.displayTextID('TEXT_POKEMONTOWER5F_PURIFIEDZONE');
    e.joyIgnore = 0;
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
];

export const PokemonTower5F: MapScript = {
  map: 'POKEMON_TOWER_5F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* tower5FScripts[e.curScript](e);
  },
};

// ------------------------------------------------------------------ 6F
const S6 = (n: string) => c('map_script', `SCRIPT_POKEMONTOWER6F_${n}`);

const tower6FScripts: ScriptFn[] = [
  // PokemonTower6FDefaultScript
  function* (e) {
    if (e.checkEvent('EVENT_BEAT_GHOST_MAROWAK') || !e.arePlayerCoordsInArray([[16, 10]])) return yield* checkFightingMapTrainers(e);
    e.joyHeld = 0;
    yield* e.displayTextID('TEXT_POKEMONTOWER6F_BEGONE');
    e.startWildBattle('RESTLESS_SOUL', 30);
    e.curScript = S6('MAROWAK_BATTLE');
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  // PokemonTower6FPlayerMovingScript
  function* (e) {
    if (e.simulatedIndex) return;
    yield* e.delay3();
    e.curScript = 0;
  },
  // PokemonTower6FMarowakBattleScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) {
      e.joyIgnore = 0;
      e.curScript = 0;
      return;
    }
    e.joyIgnore = ALL_INPUT;
    if (e.ram.talkedToTrainer) return;
    e.updateSprites();
    e.joyIgnore = PAD_CTRL_PAD;
    if (e.battleResult === 0) {
      e.setEvent('EVENT_BEAT_GHOST_MAROWAK');
      yield* e.displayTextID('TEXT_POKEMONTOWER6F_MAROWAK_DEPARTED');
      e.joyIgnore = 0;
      e.curScript = S6('DEFAULT');
      return;
    }
    // ran away: the player is pushed back off the square
    e.setSimulatedJoypad([PAD_RIGHT], 1);
    e.startSimulatingJoypadStates();
    e.curScript = S6('PLAYER_MOVING');
  },
];

export const PokemonTower6F: MapScript = {
  map: 'POKEMON_TOWER_6F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* tower6FScripts[e.curScript](e);
  },
  texts: {
    *PokemonTower6FMarowakDepartedText(e) {
      yield* e.printText('PokemonTower6FGhostWasCubonesMotherText');
      yield* e.playCry('RESTLESS_SOUL');
      yield* e.delayFrames(30);
      yield* e.printText('PokemonTower6FSoulWasCalmedText');
    },
  },
};

// ------------------------------------------------------------------ 7F
const S7 = (n: string) => c('map_script', `SCRIPT_POKEMONTOWER7F_${n}`);
const onLeft7 = (e: ScriptEnv) => e.checkEvent('EVENT_POKEMONTOWER_7_JESSIE_JAMES_ON_LEFT');
/** PokemonTower7FMovementData_60d7a (4 steps down) and _60d7b (3 steps) */
const MOVES_4 = [0x04, 0x04, 0x04, 0x04];
const MOVES_3 = [0x04, 0x04, 0x04];

function* showObject(e: ScriptEnv, toggle: string) {
  e.showObject(toggle);
  e.updateSprites();
  yield* e.delay3();
}

function* jessieJames7F(e: ScriptEnv) {
  if (e.y !== 12) return;
  e.resetEvent('EVENT_POKEMONTOWER_7_JESSIE_JAMES_ON_LEFT');
  if (e.x !== 10) {
    if (e.x !== 11) return;
    e.setEvent('EVENT_POKEMONTOWER_7_JESSIE_JAMES_ON_LEFT');
  }
  e.stopAllMusic();
  e.playMusic('MUSIC_MEET_JESSIE_JAMES');
  e.joyHeld = 0;
  e.joyIgnore = NO_PAD;
  yield* showObject(e, 'TOGGLE_POKEMON_TOWER_7F_JESSIE');
  yield* showObject(e, 'TOGGLE_POKEMON_TOWER_7F_JAMES');
  e.doNotWaitForButtonPress = true;
  yield* e.displayTextID('TEXT_POKEMONTOWER7F_TEXT4');
  e.joyIgnore = ALL_INPUT;
  e.curScript = S7('SCRIPT1');
}

function* script3(e: ScriptEnv) {
  standFacing(e, 1, onLeft7(e) ? FACING_RIGHT : FACING_DOWN);
  yield* script4(e);
}
function* script4(e: ScriptEnv) {
  e.moveSprite('POKEMONTOWER7F_JAMES', onLeft7(e) ? MOVES_3 : MOVES_4);
  e.joyIgnore = ALL_INPUT;
  e.curScript = S7('SCRIPT5');
}
function* script6(e: ScriptEnv) {
  standFacing(e, 2, onLeft7(e) ? FACING_DOWN : FACING_LEFT);
  yield* e.delay3();
  e.joyIgnore = NO_PAD;
  yield* e.displayTextID('TEXT_POKEMONTOWER7F_TEXT5');
  script7(e);
}
function script7(e: ScriptEnv): void {
  e.startTrainerBattle('OPP_ROCKET', 0x2c, 'PokemonTower7FJessieJamesEndBattleText', 'PokemonTower7FJessieJamesEndBattleText');
  e.joyHeld = 0;
  e.joyIgnore = 0;
  e.curScript = S7('SCRIPT8');
}

const tower7FScripts: ScriptFn[] = [
  function* (e) {
    if (!e.checkEvent('EVENT_BEAT_POKEMONTOWER_7_JESSIE_JAMES')) yield* jessieJames7F(e);
  },
  // PokemonTower7FScript1: Jessie walks down
  function* (e) {
    e.moveSprite('POKEMONTOWER7F_JESSIE', onLeft7(e) ? MOVES_4 : MOVES_3);
    e.joyIgnore = ALL_INPUT;
    e.curScript = S7('SCRIPT2');
  },
  // PokemonTower7FScript2 (falls through to 3 and 4)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    yield* script3(e);
  },
  script3,
  script4,
  // PokemonTower7FScript5 (falls through to 6 and 7)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    yield* script6(e);
  },
  script6,
  function* (e) {
    script7(e);
  },
  // PokemonTower7FScript8
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.ram.isInBattle === 0xff) {
      e.joyIgnore = 0;
      e.curScript = 0;
      return;
    }
    standFacing(e, 1, FACING_DOWN);
    standFacing(e, 2, FACING_DOWN);
    e.joyIgnore = NO_PAD;
    e.doNotWaitForButtonPress = true;
    yield* e.displayTextID('TEXT_POKEMONTOWER7F_TEXT6');
    e.doNotWaitForButtonPress = false;
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_JESSIE_JAMES');
    e.joyIgnore = ALL_INPUT;
    e.curScript = S7('SCRIPT9');
  },
  // PokemonTower7FScript9
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    yield* e.fadeToBlack();
    e.hideObject('TOGGLE_POKEMON_TOWER_7F_JESSIE');
    e.hideObject('TOGGLE_POKEMON_TOWER_7F_JAMES');
    e.updateSprites();
    yield* e.delay3();
    yield* e.fadeFromBlack();
    e.curScript = S7('SCRIPT10');
  },
  // PokemonTower7FScript10
  function* (e) {
    e.playDefaultMusic();
    e.joyHeld = 0;
    e.joyIgnore = 0;
    e.setEvent('EVENT_BEAT_POKEMONTOWER_7_JESSIE_JAMES');
    e.curScript = S7('SCRIPT0');
  },
  // PokemonTower7FWarpToMrFujiHouseScript
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    e.hideObject('TOGGLE_POKEMON_TOWER_7F_MR_FUJI');
    e.setPlayerFacing('up');
    e.warpFromCurScript('MR_FUJIS_HOUSE', 1, 'LAVENDER_TOWN');
    e.curScript = S7('SCRIPT0');
  },
];

export const PokemonTower7F: MapScript = {
  map: 'POKEMON_TOWER_7F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    yield* tower7FScripts[e.curScript](e);
  },
  texts: {
    *PokemonTower7FText4(e) {
      yield* e.delayFrames(10);
      e.setPlayerMovingDirection('up');
      yield* e.emotionBubble(0, 'EXCLAMATION_BUBBLE');
      yield* e.delayFrames(20);
    },
    *PokemonTower7FText6(e) {
      yield* e.delayFrames(64);
    },
    *PokemonTower7FMrFujiText(e) {
      yield* e.printText('PokemonTower7FMrFujiText.RescueText');
      e.setEvent('EVENT_RESCUED_MR_FUJI');
      e.setEvent('EVENT_RESCUED_MR_FUJI_2');
      e.showObject('TOGGLE_MR_FUJIS_HOUSE_MR_FUJI');
      e.hideObject('TOGGLE_SAFFRON_CITY_E');
      e.showObject('TOGGLE_SAFFRON_CITY_F');
      e.curScript = S7('WARP_TO_MR_FUJI_HOUSE');
    },
  },
};
