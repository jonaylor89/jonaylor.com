/**
 * Silph Co. (scripts/SilphCo1F.asm … SilphCo11F.asm): card-key doors that stay
 * open once unlocked, the rival on 7F, the Lapras gift, the 9F nurse, and on 11F
 * Jessie & James, Giovanni and Team Rocket leaving Saffron.
 */
import type { MapScript, ScriptFn } from '../types';
import type { ScriptEnv } from '../../engine/ScriptEnv';
import { PAD_BUTTONS, PAD_CTRL_PAD, PAD_SELECT, PAD_START } from '../../engine/pad';
import { FACING_DOWN, FACING_LEFT, FACING_RIGHT, FACING_UP, NONE, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP, STAY } from '../../engine/sprites';
import { checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle, engageMapTrainer, initBattleEnemyParameters } from '../../engine/trainers';
import { c } from '../../rom/constants';

const ALL_INPUT = PAD_BUTTONS | PAD_CTRL_PAD;
const NO_PAD = PAD_SELECT | PAD_START | PAD_CTRL_PAD;

/** A card-key door: block (x, y), the locked block, its EVENT_SILPH_CO_*_UNLOCKED_DOOR* flag. */
type Door = [number, number, number, string];

/**
 * <Floor>GateCallbackScript: on BIT_CUR_MAP_LOADED_1, record the door the Card Key just
 * opened (SetCardKeyDoorYScript + UnlockedDoorEventScript), then lock every door whose
 * event isn't set.
 */
function silphDoors(e: ScriptEnv, doors: Door[]): void {
  if (!e.takeMapLoaded1()) return;
  const r = e.e.ram;
  const opened = r.cardKeyDoor;
  const i = opened ? doors.findIndex(([x, y]) => x === opened.x && y === opened.y) : -1;
  if (i >= 0) {
    r.cardKeyDoor = undefined;
    e.setEvent(doors[i][3]);
  }
  for (const [x, y, block, event] of doors) if (!e.checkEvent(event)) e.e.world.replaceBlock(x, y, block);
}

function standFacing(e: ScriptEnv, slot: number, facing: number): void {
  const s = e.e.sprites[slot];
  if (!s) return;
  s.movementStatus = 2;
  s.facing = facing;
}

/** SetSpriteMovementBytesToFF */
function stay(e: ScriptEnv, obj: string): void {
  const s = e.sprite(obj);
  s.movementByte1 = STAY;
  s.movementByte2 = NONE;
}

function silphFloor(map: string, doors: Door[], scripts: ScriptFn[] = [checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle], texts: MapScript['texts'] = {}): MapScript {
  return {
    map,
    *run(e) {
      silphDoors(e, doors);
      e.enableAutoTextBoxDrawing();
      const fn = scripts[e.curScript];
      if (!fn) throw new Error(`${map}: script index ${e.curScript} out of range`);
      yield* fn(e);
    },
    texts,
  };
}

/** SilphCo6FBeatGiovanniPrintDEOrPrintHLScript: a worker's line before and after Giovanni. */
const worker = (label: string, before: string, after: string): ScriptFn =>
  function* (e) {
    yield* e.printText(`${label}.${e.checkEvent('EVENT_BEAT_SILPH_CO_GIOVANNI') ? after : before}`);
  };

const H = 0x54; // horizontal door block
const V = 0x5f; // vertical door block

export const SilphCo1F: MapScript = {
  map: 'SILPH_CO_1F',
  *run(e) {
    e.enableAutoTextBoxDrawing();
    if (!e.checkEvent('EVENT_BEAT_SILPH_CO_GIOVANNI')) return;
    if (e.checkEvent('EVENT_SILPH_CO_RECEPTIONIST_AT_DESK')) return;
    e.setEvent('EVENT_SILPH_CO_RECEPTIONIST_AT_DESK');
    e.showObject('TOGGLE_SILPH_CO_1F_RECEPTIONIST');
  },
};

export const SilphCo2F = silphFloor('SILPH_CO_2F', [
  [2, 2, H, 'EVENT_SILPH_CO_2_UNLOCKED_DOOR1'],
  [2, 5, H, 'EVENT_SILPH_CO_2_UNLOCKED_DOOR2'],
]);

export const SilphCo3F = silphFloor('SILPH_CO_3F', [
  [4, 4, V, 'EVENT_SILPH_CO_3_UNLOCKED_DOOR1'],
  [8, 4, V, 'EVENT_SILPH_CO_3_UNLOCKED_DOOR2'],
]);

export const SilphCo4F = silphFloor(
  'SILPH_CO_4F',
  [
    [2, 6, H, 'EVENT_SILPH_CO_4_UNLOCKED_DOOR1'],
    [6, 4, H, 'EVENT_SILPH_CO_4_UNLOCKED_DOOR2'],
  ],
  undefined,
  { SilphCo4FSilphWorkerMText: worker('SilphCo4FSilphWorkerMText', 'ImHidingText', 'TeamRocketIsGoneText') },
);

export const SilphCo5F = silphFloor(
  'SILPH_CO_5F',
  [
    [3, 2, V, 'EVENT_SILPH_CO_5_UNLOCKED_DOOR1'],
    [3, 6, V, 'EVENT_SILPH_CO_5_UNLOCKED_DOOR2'],
    [7, 5, V, 'EVENT_SILPH_CO_5_UNLOCKED_DOOR3'],
  ],
  undefined,
  { SilphCo5FSilphWorkerMText: worker('SilphCo5FSilphWorkerMText', 'ThatsYouRightText', 'YoureOurHeroText') },
);

export const SilphCo6F = silphFloor('SILPH_CO_6F', [[2, 6, V, 'EVENT_SILPH_CO_6_UNLOCKED_DOOR']], undefined, {
  SilphCo6FSilphWorkerM1Text: worker('SilphCo6FSilphWorkerM1Text', 'TookOverTheBuildingText', 'BackToWorkText'),
  SilphCo6FSilphWorkerM2Text: worker('SilphCo6FSilphWorkerM2Text', 'HelpMePleaseText', 'WeGotEngagedText'),
  SilphCo6FSilphWorkerF1Text: worker('SilphCo6FSilphWorkerF1Text', 'SuchACowardText', 'HaveToMarryHimText'),
  SilphCo6FSilphWorkerF2Text: worker('SilphCo6FSilphWorkerF2Text', 'TeamRocketConquerWorldText', 'TeamRocketRanText'),
  SilphCo6FSilphWorkerM3Text: worker('SilphCo6FSilphWorkerM3Text', 'TargetedSilphText', 'WorkForSilphText'),
});

// ------------------------------------------------------------------ 7F: the rival and Lapras
const S7 = (n: string) => c('map_script', `SCRIPT_SILPHCO7F_${n}`);

const silph7FScripts: ScriptFn[] = [
  // SilphCo7FDefaultScript
  function* (e) {
    if (e.checkEvent('EVENT_BEAT_SILPH_CO_RIVAL')) return yield* checkFightingMapTrainers(e);
    const i = e.arePlayerCoordsInArray([
      [2, 3],
      [3, 3],
    ]);
    if (!i) return yield* checkFightingMapTrainers(e);
    e.joyHeld = 0;
    e.joyIgnore = PAD_CTRL_PAD;
    e.setPlayerMovingDirection('down');
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL');
    yield* e.displayTextID('TEXT_SILPHCO7F_RIVAL');
    stay(e, 'SILPHCO7F_RIVAL');
    e.setVar('wSavedCoordIndex', i);
    // the upper square needs one step less
    e.moveSprite('SILPHCO7F_RIVAL', Array(i === 1 ? 4 : 3).fill(NPC_MOVEMENT_UP));
    e.curScript = S7('RIVAL_START_BATTLE');
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  // SilphCo7FRivalStartBattleScript
  function* (e) {
    if (e.npcMoving) return;
    e.joyIgnore = 0;
    yield* e.displayTextID('TEXT_SILPHCO7F_RIVAL_WAITED_HERE');
    yield* e.delay3();
    e.startTrainerBattle('OPP_RIVAL2', e.getVar('wRivalStarter') + 4, 'SilphCo7FRivalDefeatedText', 'SilphCo7FRivalVictoryText');
    e.curScript = S7('RIVAL_AFTER_BATTLE');
  },
  // SilphCo7FRivalAfterBattleScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) {
      e.joyIgnore = 0;
      e.curScript = 0;
      return;
    }
    e.joyIgnore = PAD_CTRL_PAD;
    e.setEvent('EVENT_BEAT_SILPH_CO_RIVAL');
    e.setPlayerMovingDirection('down');
    yield* e.setSpriteFacingDirectionAndDelay('SILPHCO7F_RIVAL', 'up');
    yield* e.displayTextID('TEXT_SILPHCO7F_RIVAL_GOOD_LUCK_TO_YOU');
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_RIVAL'); // Music_RivalAlternateStart
    const path =
      e.getVar('wSavedCoordIndex') === 1
        ? [NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT]
        : [NPC_MOVEMENT_LEFT, NPC_MOVEMENT_UP, NPC_MOVEMENT_UP, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_DOWN];
    e.moveSprite('SILPHCO7F_RIVAL', path);
    e.curScript = S7('RIVAL_EXIT');
  },
  // SilphCo7FRivalExitScript
  function* (e) {
    if (e.npcMoving) return;
    e.hideObject('TOGGLE_SILPH_CO_7F_RIVAL');
    e.playDefaultMusic();
    e.joyIgnore = 0;
    e.curScript = S7('DEFAULT');
  },
];

const GOT_LAPRAS = () => 1 << c('ram', 'BIT_GOT_LAPRAS');

export const SilphCo7F = silphFloor(
  'SILPH_CO_7F',
  [
    [5, 3, H, 'EVENT_SILPH_CO_7_UNLOCKED_DOOR1'],
    [10, 2, H, 'EVENT_SILPH_CO_7_UNLOCKED_DOOR2'],
    [10, 6, H, 'EVENT_SILPH_CO_7_UNLOCKED_DOOR3'],
  ],
  silph7FScripts,
  {
    // the Lapras guy
    *SilphCo7FSilphWorkerM1Text(e) {
      const T = (n: string) => `SilphCo7FSilphWorkerM1Text.${n}`;
      const flags = e.getVar('wStatusFlags4');
      if (flags & GOT_LAPRAS()) return yield* e.printText(T(e.checkEvent('EVENT_BEAT_SILPH_CO_GIOVANNI') ? 'SavedText' : 'IsOurPresidentOkText'));
      yield* e.printText(T('HaveThisPokemonText'));
      const before = e.e.state.party.length;
      if (!(yield* e.givePokemon('LAPRAS', 15))) return;
      if (e.e.state.party.length === before) yield* e.e.waitForTextScrollButtonPress(); // wAddedToParty == 0
      e.enableAutoTextBoxDrawing();
      yield* e.printText(T('LaprasDescriptionText'));
      e.setVar('wStatusFlags4', e.getVar('wStatusFlags4') | GOT_LAPRAS());
    },
  },
);

export const SilphCo8F = silphFloor('SILPH_CO_8F', [[3, 4, V, 'EVENT_SILPH_CO_8_UNLOCKED_DOOR']]);

export const SilphCo9F = silphFloor(
  'SILPH_CO_9F',
  [
    [1, 4, V, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR1'],
    [9, 2, H, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR2'],
    [9, 5, H, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR3'],
    [5, 6, V, 'EVENT_SILPH_CO_9_UNLOCKED_DOOR4'],
  ],
  undefined,
  {
    *SilphCo9FNurseText(e) {
      const T = (n: string) => `SilphCo9FNurseText.${n}`;
      if (e.checkEvent('EVENT_BEAT_SILPH_CO_GIOVANNI')) return yield* e.printText(T('ThankYouText'));
      yield* e.printText(T('YouLookTiredText'));
      e.healParty();
      yield* e.fadeToWhite();
      yield* e.delay3();
      yield* e.fadeFromWhite();
      yield* e.printText(T('DontGiveUpText'));
    },
  },
);

export const SilphCo10F = silphFloor('SILPH_CO_10F', [[5, 4, H, 'EVENT_SILPH_CO_10_UNLOCKED_DOOR']]);

// ------------------------------------------------------------------ 11F
const S11 = (n: string) => c('map_script', `SCRIPT_SILPHCO11F_${n}`);
const GIOVANNI_SLOT = 3;
const JAMES_SLOT = 4;
const JESSIE_SLOT = 6;
const D5 = 0x05; // movement bytes as stored (MoveSprite takes the top two bits)
const L6 = 0x06;

/** CheckEitherEventSet EVENT_780, EVENT_781: 0, 1 (780) or 2 (781) */
function jessieJamesSide(e: ScriptEnv): number {
  return e.checkEvent('EVENT_780') ? 1 : e.checkEvent('EVENT_781') ? 2 : 0;
}

/** SilphCo11FScript_621ff: the player and Giovanni face each other */
function faceGiovanni(e: ScriptEnv): void {
  const up = e.getVar('wSavedCoordIndex') === 1;
  e.setPlayerMovingDirection(up ? 'up' : 'left');
  standFacing(e, GIOVANNI_SLOT, up ? FACING_DOWN : FACING_RIGHT);
}

function* jessieJames11F(e: ScriptEnv) {
  if (e.y !== 3 || e.x >= 4) return;
  e.resetEvent('EVENT_780');
  e.resetEvent('EVENT_781');
  if (e.x !== 3) {
    e.setEvent('EVENT_780');
    if (e.x !== 2) {
      e.resetEvent('EVENT_780');
      e.setEvent('EVENT_781');
    }
  }
  e.stopAllMusic();
  e.playMusic('MUSIC_MEET_JESSIE_JAMES');
  e.joyHeld = 0;
  e.joyIgnore = NO_PAD;
  e.doNotWaitForButtonPress = true;
  yield* e.displayTextID('TEXT_SILPHCO11F_TEXT8');
  e.doNotWaitForButtonPress = false;
  e.joyIgnore = ALL_INPUT;
  e.setEvent('EVENT_782');
  e.curScript = S11('SCRIPT5');
}

function* script7(e: ScriptEnv) {
  standFacing(e, JAMES_SLOT, jessieJamesSide(e) ? FACING_UP : FACING_RIGHT);
  yield* e.delay3();
  e.joyIgnore = NO_PAD;
  yield* script8(e);
}
function* script8(e: ScriptEnv) {
  const side = jessieJamesSide(e);
  const path = side === 0 ? [D5, D5, D5, D5] : side === 1 ? [D5, D5, D5, D5, D5] : [D5, D5, D5, L6, D5, D5];
  e.moveSprite('SILPHCO11F_JESSIE', path);
  e.joyIgnore = ALL_INPUT;
  e.curScript = S11('SCRIPT9');
}
function* script10(e: ScriptEnv) {
  standFacing(e, JESSIE_SLOT, jessieJamesSide(e) ? FACING_LEFT : FACING_UP);
  yield* e.delay3();
  yield* e.displayTextID('TEXT_SILPHCO11F_TEXT9');
  script11(e);
}
function script11(e: ScriptEnv): void {
  e.startTrainerBattle('OPP_ROCKET', 0x2d, 'SilphCo11FText_624c2', 'SilphCo11FText_624c2');
  e.joyHeld = 0;
  e.joyIgnore = 0;
  e.curScript = S11('SCRIPT12');
}

const silph11FScripts: ScriptFn[] = [
  // SilphCo11FDefaultScript
  function* (e) {
    if (!e.checkEvent('EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES')) yield* jessieJames11F(e);
    if (e.checkEvent('EVENT_782') || e.checkEvent('EVENT_BEAT_SILPH_CO_GIOVANNI')) return;
    // SilphCo11FScript_621c5: Giovanni comes down to the player
    const i = e.arePlayerCoordsInArray([
      [13, 6],
      [12, 7],
    ]);
    if (!i) return yield* checkFightingMapTrainers(e);
    e.setVar('wSavedCoordIndex', i);
    e.joyHeld = 0;
    e.joyIgnore = PAD_CTRL_PAD;
    yield* e.displayTextID('TEXT_SILPHCO11F_GIOVANNI');
    stay(e, 'SILPHCO11F_GIOVANNI');
    e.moveSprite('SILPHCO11F_GIOVANNI', [NPC_MOVEMENT_DOWN, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_DOWN]);
    e.curScript = S11('GIOVANNI_START_BATTLE');
  },
  displayEnemyTrainerTextAndStartBattle,
  endTrainerBattle,
  // SilphCo11FGiovanniAfterBattleScript
  function* (e) {
    if (e.ram.isInBattle === 0xff) {
      e.joyIgnore = 0;
      e.curScript = 0;
      return;
    }
    faceGiovanni(e);
    e.joyIgnore = PAD_CTRL_PAD;
    yield* e.displayTextID('TEXT_SILPHCO11F_GIOVANNI_YOU_RUINED_OUR_PLANS');
    yield* e.fadeToBlack();
    // SilphCo11FTeamRocketLeavesScript
    const { hide, show } = e.e.bundle.misc.silphRocketsLeave;
    for (const t of hide) e.e.setObjectVisible(t, false);
    for (const t of show) e.e.setObjectVisible(t, true);
    e.updateSprites();
    yield* e.delay3();
    yield* e.fadeFromBlack();
    e.setEvent('EVENT_BEAT_SILPH_CO_GIOVANNI');
    e.joyIgnore = 0;
    e.curScript = 0;
  },
  // SilphCo11FGiovanniStartBattleScript
  function* (e) {
    if (e.npcMoving) return;
    stay(e, 'SILPHCO11F_GIOVANNI');
    e.e.ram.spriteIndex = GIOVANNI_SLOT;
    faceGiovanni(e);
    yield* e.delay3();
    e.joyIgnore = 0;
    e.ram.talkedToTrainer = true;
    e.ram.printEndBattleText = true;
    e.ram.endBattleWinText = 'SilphCo11FGiovanniILostAgainText';
    e.ram.endBattleLoseText = 'SilphCo11FGiovanniILostAgainText';
    engageMapTrainer(e, GIOVANNI_SLOT);
    initBattleEnemyParameters(e);
    e.curScript = S11('GIOVANNI_AFTER_BATTLE');
  },
  // SilphCo11FScript5: James walks down
  function* (e) {
    const side = jessieJamesSide(e);
    const path = side === 0 ? [D5, D5, D5, D5, D5] : side === 1 ? [D5, D5, D5, D5] : [D5, D5, L6, D5, D5];
    e.moveSprite('SILPHCO11F_JAMES', path);
    e.joyIgnore = ALL_INPUT;
    e.curScript = S11('SCRIPT6');
  },
  // SilphCo11FScript6 (falls through to 7 and 8)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    yield* script7(e);
  },
  script7,
  script8,
  // SilphCo11FScript9 (falls through to 10 and 11)
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.npcMoving) return;
    e.joyIgnore = NO_PAD;
    yield* script10(e);
  },
  script10,
  function* (e) {
    script11(e);
  },
  // SilphCo11FScript12
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    if (e.ram.isInBattle === 0xff) {
      e.joyIgnore = 0;
      e.curScript = 0;
      return;
    }
    standFacing(e, JAMES_SLOT, FACING_DOWN);
    standFacing(e, JESSIE_SLOT, FACING_DOWN);
    e.joyIgnore = NO_PAD;
    e.doNotWaitForButtonPress = true;
    yield* e.displayTextID('TEXT_SILPHCO11F_TEXT10');
    e.doNotWaitForButtonPress = false;
    e.stopAllMusic();
    e.playMusic('MUSIC_MEET_JESSIE_JAMES');
    e.joyIgnore = ALL_INPUT;
    e.curScript = S11('SCRIPT13');
  },
  // SilphCo11FScript13
  function* (e) {
    e.joyIgnore = ALL_INPUT;
    yield* e.fadeToBlack();
    e.hideObject('TOGGLE_SILPH_CO_11F_JAMES');
    e.hideObject('TOGGLE_SILPH_CO_11F_JESSIE');
    e.updateSprites();
    yield* e.delay3();
    yield* e.fadeFromBlack();
    e.curScript = S11('SCRIPT14');
  },
  // SilphCo11FScript14
  function* (e) {
    e.playDefaultMusic();
    e.joyHeld = 0;
    e.joyIgnore = 0;
    e.resetEvent('EVENT_782');
    e.setEvent('EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES');
    e.curScript = S11('DEFAULT');
  },
];

export const SilphCo11F = silphFloor('SILPH_CO_11F', [[3, 6, 0x20, 'EVENT_SILPH_CO_11_UNLOCKED_DOOR']], silph11FScripts, {
  *SilphCo11FJessieJamesText(e) {
    yield* e.delayFrames(10);
    e.setPlayerMovingDirection('down');
    yield* e.emotionBubble(0, 'EXCLAMATION_BUBBLE');
    yield* e.delayFrames(20);
  },
  *SilphCo11FText10(e) {
    yield* e.delayFrames(64);
  },
  *SilphCo11FSilphPresidentText(e) {
    const T = (n: string) => `SilphCo11FSilphPresidentText.${n}`;
    if (e.checkEvent('EVENT_GOT_MASTER_BALL')) return yield* e.printText(T('MasterBallDescriptionText'));
    yield* e.printText(T('Text'));
    if (!e.giveItem('MASTER_BALL')) return yield* e.printText(T('NoRoomText'));
    yield* e.printText(T('ReceivedMasterBallText'));
    e.setEvent('EVENT_GOT_MASTER_BALL');
  },
});
