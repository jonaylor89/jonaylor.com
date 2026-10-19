/**
 * Trainer engine: ports of home/trainers.asm and engine/overworld/trainer_sight.asm
 * (CheckFightingMapTrainers, TrainerEngage, TrainerWalkUpToPlayer,
 * TalkToTrainer, DisplayEnemyTrainerTextAndStartBattle, StartTrainerBattle,
 * EndTrainerBattle, EngageMapTrainer, PlayTrainerMusic).
 */
import type { Co } from './Engine';
import type { ScriptEnv } from './ScriptEnv';
import type { MapScript, ScriptFn } from '../scripts/types';
import { PAD_CTRL_PAD } from './pad';
import { c } from '../rom/constants';
import { getBit } from '../game/state';
import { FACING_DOWN, FACING_LEFT, FACING_RIGHT, FACING_UP, NPC_MOVEMENT_DOWN, NPC_MOVEMENT_LEFT, NPC_MOVEMENT_RIGHT, NPC_MOVEMENT_UP } from './sprites';

const PLAYER_SCREEN_Y = 0x3c;
const PLAYER_SCREEN_X = 0x40;

function screenPos(env: ScriptEnv, slot: number): { y: number; x: number } {
  const s = env.e.sprites[slot];
  const p = env.e.state.player;
  // x#SPRITESTATEDATA1_Y/XPIXELS: player at ($40, $3c); sprites are drawn 4 px higher.
  return { y: (s.mapY - p.y) * 16 + s.offY + PLAYER_SCREEN_Y, x: (s.mapX - p.x) * 16 + s.offX + PLAYER_SCREEN_X };
}

/** TrainerEngage: is this trainer lined up, in range, facing and in front of the player? */
function trainerEngage(env: ScriptEnv, slot: number, engageDistance: number): boolean {
  const s = env.e.sprites[slot];
  if (!s || s.hidden || s.offscreen || !s.pictureId) return false;
  const { y, x } = screenPos(env, slot);
  const facing = s.facing;
  const range = engageDistance << 4;
  let dist: number;
  if (y === PLAYER_SCREEN_Y) {
    dist = Math.abs(x - PLAYER_SCREEN_X);
    if (!dist) return false;
    if (range < dist) return false;
    if (facing !== FACING_LEFT && facing !== FACING_RIGHT) return false;
  } else if (x === PLAYER_SCREEN_X) {
    dist = Math.abs(y - PLAYER_SCREEN_Y);
    if (!dist) return false;
    if (range < dist) return false;
    if (facing !== FACING_DOWN && facing !== FACING_UP) return false;
  } else return false;
  // CheckPlayerIsInFrontOfSprite
  if (env.e.world.data.id !== c('map', 'POWER_PLANT')) {
    const sy = (y & 0xff) === 0xfc ? 0x0c : y;
    if (facing === FACING_DOWN && !(sy < PLAYER_SCREEN_Y)) return false;
    if (facing === FACING_UP && !(sy >= PLAYER_SCREEN_Y)) return false;
    if (facing === FACING_LEFT && !(x >= PLAYER_SCREEN_X)) return false;
    if (facing === FACING_RIGHT && !(x < PLAYER_SCREEN_X)) return false;
  }
  return true;
}

/** EngageMapTrainer: load the trainer class/set from the object data and play the encounter music. */
export function engageMapTrainer(env: ScriptEnv, slot: number): void {
  const obj = env.e.sprites[slot]?.obj;
  if (!obj) throw new Error(`engageMapTrainer: sprite ${slot} has no object data`);
  const r = env.ram;
  if (obj.kind === 'trainer') {
    r.engagedTrainerClass = (obj.trainerClass ?? 0) + 200;
    r.engagedTrainerSet = obj.trainerIndex ?? 0;
  } else {
    r.engagedTrainerClass = obj.species ?? 0;
    r.engagedTrainerSet = obj.level ?? 0;
  }
  playTrainerMusic(env);
}

const EVIL = ['OPP_UNUSED_JUGGLER', 'OPP_GAMBLER', 'OPP_ROCKER', 'OPP_JUGGLER', 'OPP_CHIEF', 'OPP_SCIENTIST', 'OPP_GIOVANNI', 'OPP_ROCKET'];
const FEMALE = ['OPP_LASS', 'OPP_JR_TRAINER_F', 'OPP_BEAUTY', 'OPP_COOLTRAINER_F'];

function playTrainerMusic(env: ScriptEnv): void {
  const cls = env.ram.engagedTrainerClass;
  if (['OPP_RIVAL1', 'OPP_RIVAL2', 'OPP_RIVAL3'].some((n) => c('opp', n) === cls)) return;
  if (env.ram.gymLeaderNo) return;
  env.stopAllMusic();
  if (EVIL.some((n) => c('opp', n) === cls)) env.playMusic('MUSIC_MEET_EVIL_TRAINER');
  else if (FEMALE.some((n) => c('opp', n) === cls)) env.playMusic('MUSIC_MEET_FEMALE_TRAINER');
  else env.playMusic('MUSIC_MEET_MALE_TRAINER');
}

function beaten(env: ScriptEnv, flag: number): boolean {
  return getBit(env.e.state.eventFlags, flag);
}

/** CheckFightingMapTrainers (script index 0 of trainer maps). */
export const checkFightingMapTrainers: ScriptFn = function* (env) {
  const headers = env.e.world.data.trainerHeaders;
  let engaged = -1;
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    if (beaten(env, h.eventFlag)) continue;
    if (trainerEngage(env, h.spriteIndex, h.engageDistance)) {
      engaged = i;
      break;
    }
  }
  const r = env.ram;
  if (engaged < 0) {
    r.spriteIndex = 0;
    return;
  }
  const h = headers[engaged];
  r.seenByTrainer = true;
  r.spriteIndex = h.spriteIndex;
  r.engagedHeader = engaged;
  engageMapTrainer(env, h.spriteIndex);
  r.trainerBattle = true;
  yield* env.emotionBubble(h.spriteIndex, 'EXCLAMATION_BUBBLE');
  env.joyIgnore = PAD_CTRL_PAD;
  env.joyHeld = 0;
  trainerWalkUpToPlayer(env, h.spriteIndex);
  env.curScript = env.curScript + 1;
};

/** TrainerWalkUpToPlayer: walk in the facing direction until adjacent to the player. */
function trainerWalkUpToPlayer(env: ScriptEnv, slot: number): void {
  const s = env.e.sprites[slot];
  const { y, x } = screenPos(env, slot);
  let d: number;
  let dir: number;
  switch (s.facing) {
    case FACING_DOWN:
      d = Math.abs(PLAYER_SCREEN_Y - y);
      dir = NPC_MOVEMENT_DOWN;
      break;
    case FACING_UP:
      d = Math.abs(PLAYER_SCREEN_Y - y);
      dir = NPC_MOVEMENT_UP;
      break;
    case FACING_LEFT:
      d = Math.abs(PLAYER_SCREEN_X - x);
      dir = NPC_MOVEMENT_LEFT;
      break;
    default:
      d = Math.abs(PLAYER_SCREEN_X - x);
      dir = NPC_MOVEMENT_RIGHT;
  }
  if (d === 0x10) return; // already adjacent
  const steps = (d >> 4) - 1;
  env.e.moveSprite(slot, new Array(steps).fill(dir), true);
}

/** DisplayEnemyTrainerTextAndStartBattle (script index 1). */
export const displayEnemyTrainerTextAndStartBattle: ScriptFn = function* (env) {
  if (env.npcMoving) return;
  env.joyIgnore = 0;
  yield* env.displayTextID(env.ram.spriteIndex);
  startTrainerBattle(env);
};

/** InitBattleEnemyParameters: the engaged trainer (or Pokémon) becomes the opponent. */
export function initBattleEnemyParameters(env: ScriptEnv): void {
  const r = env.ram;
  r.curOpponent = r.engagedTrainerClass;
  if (r.engagedTrainerClass >= 200) r.trainerNo = r.engagedTrainerSet;
  else r.curEnemyLevel = r.engagedTrainerSet;
}

/** StartTrainerBattle + InitBattleEnemyParameters. */
export function startTrainerBattle(env: ScriptEnv): void {
  const r = env.ram;
  env.joyIgnore = 0;
  initBattleEnemyParameters(env);
  r.talkedToTrainer = true;
  r.printEndBattleText = true;
  env.curScript = env.curScript + 1;
}

/** EndTrainerBattle (script index 2). */
export const endTrainerBattle: ScriptFn = function* (env) {
  const r = env.ram;
  r.curMapLoaded1 = true;
  r.curMapLoaded2 = true;
  r.printEndBattleText = false;
  r.seenByTrainer = false;
  if (r.isInBattle !== 0xff) {
    const h = env.e.world.data.trainerHeaders[r.engagedHeader];
    if (h) env.e.store.dispatch({ type: 'setEvent', flag: h.eventFlag, value: true }, { undoable: false });
    if (r.engagedTrainerClass < 200 && h) {
      // a Pokémon "trainer" (legendaries, Voltorb items...): hide the sprite fought (wSpriteIndex)
      const toggles = env.e.bundle.toggleableObjects;
      const t = toggles.findIndex((x) => x.map === env.e.world.data.id && x.object === r.spriteIndex);
      if (t >= 0) env.e.store.dispatch({ type: 'setObjectVisible', toggle: t, visible: false }, { undoable: false });
      const s = env.e.sprites[r.spriteIndex];
      if (s) s.hidden = true;
    }
  }
  resetButtonPressedAndMapScript(env);
};

export function resetButtonPressedAndMapScript(env: ScriptEnv): void {
  env.joyIgnore = 0;
  env.joyHeld = 0;
  env.ram.joyPressed = 0;
  env.curScript = 0;
}

/** TalkToTrainer: after-battle text, or the challenge (and battle) if not yet beaten. */
export function* talkToTrainer(env: ScriptEnv, headerIndex: number): Co {
  const h = env.e.world.data.trainerHeaders[headerIndex];
  if (!h) throw new Error(`${env.e.world.data.constName} has no trainer header ${headerIndex}`);
  if (beaten(env, h.eventFlag)) {
    yield* env.printText(h.afterText);
    return;
  }
  yield* env.printText(h.beforeText);
  env.ram.endBattleWinText = h.endBattleText;
  env.ram.endBattleLoseText = h.endBattleText;
  env.ram.engagedHeader = headerIndex;
  if (env.ram.seenByTrainer) return;
  // the player talked to the trainer of their own volition (EngageMapTrainer reads wSpriteIndex)
  engageMapTrainer(env, env.ram.spriteIndex);
  env.curScript = env.curScript + 1;
  startTrainerBattle(env);
}

/**
 * A map whose script table is the standard trainer trio
 * (CheckFightingMapTrainers, DisplayEnemyTrainerTextAndStartBattle,
 * EndTrainerBattle), optionally followed by map-specific scripts.
 */
export function trainerMapScript(map: string, extra: ScriptFn[] = [], texts: MapScript['texts'] = {}, prelude?: ScriptFn): MapScript {
  const table = [checkFightingMapTrainers, displayEnemyTrainerTextAndStartBattle, endTrainerBattle, ...extra];
  return {
    map,
    *run(env) {
      env.enableAutoTextBoxDrawing();
      if (prelude) yield* prelude(env);
      const fn = table[env.curScript];
      if (!fn) throw new Error(`${map}: script index ${env.curScript} out of range`);
      yield* fn(env);
    },
    texts,
  };
}

/** `text_asm; ld hl, <Map>TrainerHeaderN; call TalkToTrainer; jp TextScriptEnd` */
export const trainerText = (headerIndex: number): ScriptFn =>
  function* (env) {
    yield* talkToTrainer(env, headerIndex);
  };
