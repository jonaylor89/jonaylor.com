/**
 * Move execution: ExecutePlayerMove / ExecuteEnemyMove and everything they
 * call in engine/battle/core.asm — status checks, disobedience, damage
 * (GetDamageVars*, CalculateDamage, crits, type matchups, random factor),
 * MoveHitTest, applying damage, substitutes, Rage, Mirror Move, Metronome.
 *
 * The two sides share code where the original's two copies behave alike;
 * every asymmetry of the original is kept and marked "(player only)" or
 * "(enemy only)".
 */
import type { Co } from '../engine/Engine';
import type { Battle } from './Battle';
import { c } from '../rom/constants';
import { calcStat, dvs as splitDVs } from '../game/pokemon';
import { CANNOT_MOVE, E, EFFECTIVE, M, MAX_STAT_VALUE, MOD_STATS, pct, PP_MASK, S1, S2, S3, ST, T, type Side } from './state';
import { jumpMoveEffect, statModifierUpEffect } from './effects';
import { playMoveAnimation, ANIM_TYPE } from './animation';
import { moveSelectionMenu } from './menus';
import { WILD_BATTLE } from './Battle';

const inList = (list: number[], v: number) => list.includes(v);

// ------------------------------------------------------------------ GetCurrentMove
/** GetCurrentMove: load the selected move's data and name (wStringBuffer). */
export function getCurrentMove(b: Battle): void {
  const s = b.att;
  loadMoveData(b, s, s.selectedMove);
}

function loadMoveData(b: Battle, s: Side, move: number): void {
  const m = b.bundle.moves[move - 1];
  if (!m) throw new Error(`unknown move ${move}`);
  s.move = { num: m.id, effect: m.effect, power: m.power, type: m.type, accuracy: m.accuracy, maxPP: m.pp };
  b.setMem('wStringBuffer', m.name);
}

// ------------------------------------------------------------------ execute
type Entry = 'start' | 'canExecuteMove' | 'calcDamage' | 'handleMissed' | 'animation' | 'done';

/** ExecutePlayerMove: returns b (0 if the enemy fainted). */
export function* executePlayerMove(b: Battle): Co<number> {
  b.whoseTurn = 0;
  const p = b.player;
  if (p.selectedMove === CANNOT_MOVE) return done(b);
  b.moveMissed = 0;
  b.monIsDisobedient = 0;
  b.moveDidntMiss = 0;
  b.damageMultipliers = EFFECTIVE;
  if (b.actionResult) return done(b);
  if (yield* printGhostText(b)) return done(b);
  let entry: Entry = yield* checkStatusConditions(b);
  if (entry === 'start') {
    getCurrentMove(b);
    if (p.s1 & S1.CHARGING_UP) {
      // PlayerCanExecuteChargingMove
      p.s1 &= ~(S1.CHARGING_UP | S1.INVULNERABLE);
      entry = 'canExecuteMove';
    } else {
      if (!(yield* checkForDisobedience(b))) return done(b);
      entry = 'checkCharge' as Entry;
    }
  }
  return yield* runMove(b, entry);
}

/** ExecuteEnemyMove: returns b (0 if the player's mon fainted). */
export function* executeEnemyMove(b: Battle): Co<number> {
  const en = b.enemy;
  if (en.selectedMove === CANNOT_MOVE) return 1;
  if (yield* printGhostText(b)) return 1;
  b.aiLayer2Encouragement = (b.aiLayer2Encouragement + 1) & 0xff;
  b.moveMissed = 0;
  b.moveDidntMiss = 0;
  b.damageMultipliers = EFFECTIVE;
  let entry: Entry = yield* checkStatusConditions(b);
  if (entry === 'start') {
    if (en.s1 & S1.CHARGING_UP) {
      // EnemyCanExecuteChargingMove
      en.s1 &= ~(S1.CHARGING_UP | S1.INVULNERABLE);
      b.setMem('wStringBuffer', b.bundle.moves[en.move.num - 1]?.name ?? '');
      entry = 'canExecuteMove';
    } else {
      getCurrentMove(b);
      entry = 'checkCharge' as Entry;
    }
  }
  return yield* runMove(b, entry);
}

function done(b: Battle): number {
  // ExecutePlayerMoveDone / ExecuteEnemyMoveDone
  if (b.whoseTurn === 0) b.actionResult = 0;
  return 1;
}

/**
 * The shared body of Execute*Move from CheckIf*NeedsToChargeUp on. `entry`
 * selects where CheckStatusConditions sent us (its "return to hl" jumps).
 */
function* runMove(b: Battle, entry: Entry | 'checkCharge'): Co<number> {
  const s = b.att;
  const t = b.def;
  const isPlayer = b.whoseTurn === 0;
  const battleList = b.bundle.battle;
  let state: string = entry;
  for (;;) {
    switch (state) {
      case 'done':
        return done(b);
      case 'checkCharge': {
        // CheckIf*NeedsToChargeUp
        if (s.move.effect === E.CHARGE_EFFECT || s.move.effect === E.FLY_EFFECT) {
          yield* jumpMoveEffect(b);
          return 1;
        }
        state = 'canExecuteMove';
        break;
      }
      case 'canExecuteMove': {
        // *CanExecuteMove
        if (!isPlayer) b.monIsDisobedient = 0;
        yield* displayUsedMoveText(b);
        if (isPlayer) decrementPP(b);
        if (inList(battleList.residualEffects1, s.move.effect)) {
          yield* jumpMoveEffect(b);
          return 1;
        }
        if (inList(battleList.specialEffectsCont, s.move.effect)) yield* jumpMoveEffect(b);
        state = 'calcDamage';
        break;
      }
      case 'calcDamage': {
        // *CalcMoveDamage
        if (inList(battleList.setDamageEffects, s.move.effect)) {
          moveHitTest(b);
          state = 'handleMissed';
          break;
        }
        criticalHitTest(b);
        if (handleCounterMove(b)) {
          state = 'handleMissed';
          break;
        }
        const nonzero = isPlayer ? getDamageVarsForPlayerAttack(b) : getDamageVarsForEnemyAttack(b);
        const r = yield* calculateDamage(b, nonzero);
        if (!r) {
          state = 'flyOrCharge';
          break;
        }
        adjustDamageForMoveType(b);
        randomizeDamage(b);
        moveHitTest(b);
        state = 'handleMissed';
        break;
      }
      case 'handleMissed': {
        // HandleIf*MoveMissed
        if (b.moveMissed) {
          if (s.move.effect === E.EXPLODE_EFFECT) {
            yield* playMoveAnim(b, 0);
            state = 'mirror';
          } else state = 'flyOrCharge';
          break;
        }
        state = 'animation';
        break;
      }
      case 'animation': {
        // Get*AnimationType / Play*MoveAnimation
        const type = isPlayer
          ? s.move.effect
            ? ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_LIGHT
            : ANIM_TYPE.BLINK_ENEMY_MON_SPRITE
          : s.move.effect
            ? ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_HEAVY
            : ANIM_TYPE.SHAKE_SCREEN_VERTICALLY;
        yield* playMoveAnim(b, type);
        state = 'mirror';
        break;
      }
      case 'flyOrCharge': {
        // *CheckIfFlyOrChargeEffect
        yield* b.delay(30);
        if (s.move.effect === E.FLY_EFFECT || s.move.effect === E.CHARGE_EFFECT)
          yield* playMoveAnimation(b, c('move', 'STATUS_AFFECTED_ANIM'), 0);
        state = 'mirror';
        break;
      }
      case 'mirror': {
        // MirrorMoveCheck / EnemyCheckIfMirrorMoveEffect
        if (s.move.effect === E.MIRROR_MOVE_EFFECT) {
          if (!(yield* mirrorMoveCopyMove(b))) return done(b);
          if (isPlayer) b.monIsDisobedient = 0;
          state = 'checkCharge';
          break;
        }
        if (s.move.effect === E.METRONOME_EFFECT) {
          yield* metronomePickMove(b);
          state = 'checkCharge';
          break;
        }
        if (inList(battleList.residualEffects2, s.move.effect)) {
          yield* jumpMoveEffect(b);
          return 1;
        }
        if (b.moveMissed) {
          yield* printMoveFailureText(b);
          if (s.move.effect !== E.EXPLODE_EFFECT) return done(b);
        } else {
          if (isPlayer) yield* applyAttackToEnemyPokemon(b);
          else yield* applyAttackToPlayerPokemon(b);
          yield* printCriticalOHKOText(b);
          yield* displayEffectiveness(b);
          b.moveDidntMiss = 1;
        }
        // .notDone / .handleExplosionMiss
        if (inList(battleList.alwaysHappenSideEffects, s.move.effect)) yield* jumpMoveEffect(b);
        if (!t.mon.hp) return 0;
        yield* handleBuildingRage(b);
        if (s.s1 & S1.ATTACKING_MULTIPLE_TIMES) {
          s.numAttacksLeft = (s.numAttacksLeft - 1) & 0xff;
          if (s.numAttacksLeft) {
            state = 'animation';
            break;
          }
          s.s1 &= ~S1.ATTACKING_MULTIPLE_TIMES;
          yield* b.print(isPlayer ? '_MultiHitText' : '_HitXTimesText');
          s.numHits = 0;
        }
        if (s.move.effect && !inList(battleList.specialEffects, s.move.effect)) yield* jumpMoveEffect(b);
        return done(b);
      }
      default:
        throw new Error(`runMove: bad state ${state}`);
    }
  }
}

/** Play*MoveAnimation with the substitute hidden around it, then redraw the user's HUD. */
function* playMoveAnim(b: Battle, type: number): Co {
  const s = b.att;
  if (s.s2 & S2.HAS_SUBSTITUTE_UP) yield* b.ui.hideSubstitute(b.whoseTurn);
  yield* playMoveAnimation(b, s.move.num, type);
  yield* handleExplodingAnimation(b);
  if (b.whoseTurn === 0) b.drawPlayerHUDAndHPBar();
  else b.drawEnemyHUDAndHPBar();
  if (s.s2 & S2.HAS_SUBSTITUTE_UP) yield* b.ui.reshowSubstitute(b.whoseTurn);
}

/** HandleExplodingAnimation (note: checks the enemy's INVULNERABLE bit on both turns). */
function* handleExplodingAnimation(b: Battle): Co {
  const s = b.att;
  if (s.move.num !== M.SELFDESTRUCT && s.move.num !== M.EXPLOSION) return;
  if (b.enemy.s1 & S1.INVULNERABLE) return;
  const target = b.def.mon;
  if (target.types[0] === T.GHOST || target.types[1] === T.GHOST) return;
  if (b.moveMissed) return;
  yield* playMoveAnimation(b, M.MEGA_PUNCH, ANIM_TYPE.SHAKE_SCREEN_HORIZONTALLY_LIGHT);
}

// ------------------------------------------------------------------ text helpers
/** DisplayUsedMoveText (engine/battle/used_move_text.asm) */
export function* displayUsedMoveText(b: Battle): Co {
  const s = b.att;
  s.usedMove = s.move.num;
  const groups = b.bundle.battle.moveGrammar;
  let grammar = groups.findIndex((g) => g.includes(s.move.num));
  if (grammar < 0) grammar = groups.length - 1;
  const labels = ['_ActorNameText'];
  labels.push(b.monIsDisobedient || grammar < 3 ? '_UsedMove2Text' : '_UsedMove1Text');
  if (b.monIsDisobedient) labels.push('_UsedInsteadText');
  labels.push('_MoveNameText', `_EndUsedMove${grammar + 1}Text`);
  yield* b.print(...labels);
}

/** PrintGhostText: returns true (Z) if the turn is lost to the ghost. */
function* printGhostText(b: Battle): Co<boolean> {
  if (!b.isGhostBattle()) return false;
  if (b.whoseTurn) {
    yield* b.print('_GetOutText');
    return true;
  }
  if (b.player.mon.status & (ST.FRZ | ST.SLP_MASK)) return false;
  yield* b.print('_ScaredText');
  return true;
}

/** PrintMoveFailureText (with the Jump Kick crash damage). */
export function* printMoveFailureText(b: Battle): Co {
  const s = b.att;
  let text = '_DoesntAffectMonText';
  if (b.damageMultipliers & 0x7f) text = b.criticalHitOrOHKO === 0xff ? '_UnaffectedText' : '_AttackMissedText';
  yield* b.print(text);
  b.criticalHitOrOHKO = 0;
  if (s.move.effect !== E.JUMP_KICK_EFFECT) return;
  // wDamage is always 0 here, so the crash damage is 1.
  b.damage = b.damage >> 3 || 1;
  yield* b.print('_KeptGoingAndCrashedText');
  yield* b.ui.shakeScreenHorizontally(4);
  if (b.whoseTurn === 0) yield* applyDamageToPlayerPokemon(b);
  else yield* applyDamageToEnemyPokemon(b);
}

/** PrintCriticalOHKOText */
function* printCriticalOHKOText(b: Battle): Co {
  if (b.criticalHitOrOHKO) {
    const which = ((b.criticalHitOrOHKO - 1) * 2) & 0xff;
    yield* b.print(which === 0 ? '_CriticalHitText' : '_OHKOText');
    b.criticalHitOrOHKO = 0;
  }
  yield* b.delay(20);
}

/** DisplayEffectiveness */
function* displayEffectiveness(b: Battle): Co {
  const m = b.damageMultipliers & 0x7f;
  if (m === EFFECTIVE) return;
  yield* b.print(m > EFFECTIVE ? '_SuperEffectiveText' : '_NotVeryEffectiveText');
}

// ------------------------------------------------------------------ status checks
/**
 * CheckPlayerStatusConditions / CheckEnemyStatusConditions. Returns 'start'
 * when the mon can move normally, otherwise the label to continue at.
 */
function* checkStatusConditions(b: Battle): Co<Entry> {
  const isPlayer = b.whoseTurn === 0;
  const s = b.att;
  const t = b.def;
  if (s.mon.status & ST.SLP_MASK) {
    s.mon.status = (s.mon.status & ~ST.SLP_MASK) | ((s.mon.status & ST.SLP_MASK) - 1);
    if (s.mon.status & ST.SLP_MASK) {
      if (isPlayer) {
        yield* playMoveAnimation(b, c('move', 'SLP_PLAYER_ANIM'), 0);
        yield* b.print('_FastAsleepText');
      } else {
        yield* b.print('_FastAsleepText');
        yield* playMoveAnimation(b, c('move', 'SLP_ANIM'), 0);
      }
    } else yield* b.print('_WokeUpText');
    s.usedMove = 0;
    return 'done';
  }
  if (s.mon.status & ST.FRZ) {
    yield* b.print('_IsFrozenText');
    s.usedMove = 0;
    return 'done';
  }
  if (t.s1 & S1.USING_TRAPPING_MOVE) {
    yield* b.print('_CantMoveText');
    return 'done';
  }
  if (s.s1 & S1.FLINCHED) {
    s.s1 &= ~S1.FLINCHED;
    yield* b.print('_FlinchedText');
    return 'done';
  }
  if (s.s2 & S2.NEEDS_TO_RECHARGE) {
    s.s2 &= ~S2.NEEDS_TO_RECHARGE;
    yield* b.print('_MustRechargeText');
    return 'done';
  }
  if (s.disabledMove) {
    s.disabledMove = (s.disabledMove - 1) & 0xff;
    if (!(s.disabledMove & 0xf)) {
      s.disabledMove = 0;
      s.disabledMoveNumber = 0;
      yield* b.print('_DisabledNoMoreText');
    }
  }
  let hurtOrParalysed = false;
  if (s.s1 & S1.CONFUSED) {
    s.confusedCounter = (s.confusedCounter - 1) & 0xff;
    if (!s.confusedCounter) {
      s.s1 &= ~S1.CONFUSED;
      yield* b.print('_ConfusedNoMoreText');
    } else {
      yield* b.print('_IsConfusedText');
      yield* playMoveAnimation(b, c('move', isPlayer ? 'CONF_PLAYER_ANIM' : 'CONF_ANIM'), 0);
      if (b.random() >= (isPlayer ? pct(50) + 1 : 0x80)) {
        s.s1 &= S1.CONFUSED;
        yield* handleSelfConfusionDamage(b);
        hurtOrParalysed = true;
      }
    }
  }
  if (!hurtOrParalysed) {
    if (s.disabledMoveNumber && s.disabledMoveNumber === s.selectedMove) {
      yield* printMoveIsDisabledText(b);
      return 'done';
    }
    if (s.mon.status & ST.PAR && b.random() < pct(25)) {
      yield* b.print('_FullyParalyzedText');
      hurtOrParalysed = true;
    }
  }
  if (hurtOrParalysed) {
    // .MonHurtItselfOrFullyParalysed
    s.s1 &= ~(S1.STORING_ENERGY | S1.THRASHING_ABOUT | S1.CHARGING_UP | S1.USING_TRAPPING_MOVE);
    if (s.move.effect === E.FLY_EFFECT || s.move.effect === E.CHARGE_EFFECT)
      yield* playMoveAnimation(b, c('move', 'STATUS_AFFECTED_ANIM'), 0);
    return 'done';
  }
  if (s.s1 & S1.STORING_ENERGY) {
    s.move.num = 0;
    s.bideDamage = (s.bideDamage + b.damage) & 0xffff;
    s.numAttacksLeft = (s.numAttacksLeft - 1) & 0xff;
    if (s.numAttacksLeft) return 'done';
    s.s1 &= ~S1.STORING_ENERGY;
    yield* b.print('_UnleashedEnergyText');
    s.move.power = 1;
    b.damage = (s.bideDamage * 2) & 0xffff;
    if (!b.damage) b.moveMissed = 1;
    s.bideDamage = 0;
    s.move.num = M.BIDE;
    return 'handleMissed';
  }
  if (s.s1 & S1.THRASHING_ABOUT) {
    s.move.num = M.THRASH;
    yield* b.print('_ThrashingAboutText');
    s.numAttacksLeft = (s.numAttacksLeft - 1) & 0xff;
    if (s.numAttacksLeft) return 'calcDamage';
    s.s1 &= ~S1.THRASHING_ABOUT;
    s.s1 |= S1.CONFUSED;
    s.confusedCounter = (b.random() & 3) + 2;
    return 'calcDamage';
  }
  if (s.s1 & S1.USING_TRAPPING_MOVE) {
    yield* b.print('_AttackContinuesText');
    s.numAttacksLeft = (s.numAttacksLeft - 1) & 0xff;
    return 'animation';
  }
  if (s.s2 & S2.USING_RAGE) {
    b.setMem('wStringBuffer', b.bundle.moves[M.RAGE - 1].name);
    s.move.effect = 0;
    return 'canExecuteMove';
  }
  return 'start';
}

/** PrintMoveIsDisabledText */
function* printMoveIsDisabledText(b: Battle): Co {
  const s = b.att;
  s.s1 &= ~S1.CHARGING_UP;
  b.setMem('wNameBuffer', b.bundle.moves[s.selectedMove - 1]?.name ?? '');
  yield* b.print('_MoveIsDisabledText');
}

/** HandleSelfConfusionDamage (player) and its inlined copy in CheckEnemyStatusConditions. */
export function* handleSelfConfusionDamage(b: Battle): Co {
  const isPlayer = b.whoseTurn === 0;
  const s = b.att;
  const t = b.def;
  yield* b.print('_HurtItselfText');
  // the target's defense is temporarily replaced by the user's own
  const savedDef = t.mon.def;
  t.mon.def = s.mon.def;
  const savedEffect = s.move.effect;
  const savedPower = s.move.power;
  const savedType = s.move.type;
  s.move.effect = 0;
  b.criticalHitOrOHKO = 0;
  s.move.power = 40;
  s.move.type = 0;
  const nonzero = isPlayer ? getDamageVarsForPlayerAttack(b) : getDamageVarsForEnemyAttack(b);
  yield* calculateDamage(b, nonzero);
  s.move.effect = savedEffect;
  // (the original restores only the effect byte; power and type keep 40/NORMAL)
  void savedPower;
  void savedType;
  t.mon.def = savedDef;
  if (isPlayer) {
    b.whoseTurn = 1;
    yield* playMoveAnimation(b, M.POUND, 0);
    b.drawPlayerHUDAndHPBar();
    b.whoseTurn = 0;
    yield* applyDamageToPlayerPokemon(b);
  } else {
    b.whoseTurn = 0;
    yield* playMoveAnimation(b, M.POUND, 0);
    b.whoseTurn = 1;
    yield* applyDamageToEnemyPokemon(b);
  }
}

// ------------------------------------------------------------------ disobedience
/** CheckForDisobedience (player only): returns true if the mon obeys. */
function* checkForDisobedience(b: Battle): Co<boolean> {
  b.monIsDisobedient = 0;
  const pm = b.party[b.playerMonNumber];
  const st = b.e.state;
  if (pm.otId === st.player.id) return true;
  const badges = st.badges;
  const bit = (name: string) => (badges >> badgeBit(name)) & 1;
  let cap = 10;
  if (bit('EARTHBADGE')) cap = 101;
  else if (bit('MARSHBADGE')) cap = 70;
  else if (bit('RAINBOWBADGE')) cap = 50;
  else if (bit('CASCADEBADGE')) cap = 30;
  const lvl = b.player.mon.level;
  const c0 = cap;
  const bb = Math.min(0xff, cap + lvl);
  if (c0 >= lvl) return true;
  let a: number;
  do a = swapNybbles(b.random());
  while (a >= bb);
  if (a < c0) return true;
  do a = b.random();
  while (a >= bb);
  if (a < c0) {
    // .useRandomMove
    if (yield* useRandomMove(b)) return true;
    return yield* monDoesNothing(b);
  }
  const diff = (lvl - c0) & 0xff;
  a = swapNybbles(b.random()) - diff;
  if (a < 0) {
    // .monNaps
    let slp: number;
    do slp = swapNybbles((b.random() * 2) & 0xff) & ST.SLP_MASK;
    while (!slp);
    b.player.mon.status = slp;
    yield* b.print('_BeganToNapText');
    return false;
  }
  if (a >= diff) return yield* monDoesNothing(b);
  yield* b.print('_WontObeyText');
  yield* handleSelfConfusionDamage(b);
  return false;
}

function badgeBit(name: string): number {
  return ['BOULDERBADGE', 'CASCADEBADGE', 'THUNDERBADGE', 'RAINBOWBADGE', 'SOULBADGE', 'MARSHBADGE', 'VOLCANOBADGE', 'EARTHBADGE'].indexOf(name);
}

const swapNybbles = (a: number) => ((a << 4) | (a >> 4)) & 0xff;

function* monDoesNothing(b: Battle): Co<boolean> {
  const r = b.random() & 3;
  const text = ['_LoafingAroundText', '_WontObeyText', '_TurnedAwayText', '_IgnoredOrdersText'][r];
  yield* b.print(text);
  return false;
}

/** .useRandomMove: returns false if the mon should do nothing instead. */
// eslint-disable-next-line require-yield
function* useRandomMove(b: Battle): Co<boolean> {
  const p = b.player;
  if (!p.mon.moves[1]) return false;
  if (p.disabledMoveNumber) return false;
  if (p.selectedMove === M.STRUGGLE) return false;
  const total = (p.mon.pp.reduce((acc, v) => acc + (v & PP_MASK), 0)) & 0xff;
  const cur = p.mon.pp[b.currentMenuItem] & PP_MASK;
  if (total === cur) return false;
  b.monIsDisobedient = 1;
  const max = b.maxMenuItem;
  const sel = b.currentMenuItem;
  for (;;) {
    const r = b.random() & 3;
    if (r >= max) continue;
    if (r === sel) continue;
    if (!p.mon.pp[r]) continue;
    b.currentMenuItem = r;
    break;
  }
  p.selectedMove = p.mon.moves[b.currentMenuItem];
  getCurrentMove(b);
  return true;
}

// ------------------------------------------------------------------ PP
/** DecrementPP (player only) */
function decrementPP(b: Battle): void {
  const p = b.player;
  if (p.selectedMove === M.STRUGGLE) return;
  if (p.s1 & (S1.STORING_ENERGY | S1.THRASHING_ABOUT | S1.ATTACKING_MULTIPLE_TIMES)) return;
  if (p.s2 & S2.USING_RAGE) return;
  const i = p.moveListIndex;
  p.mon.pp[i] = (p.mon.pp[i] - 1) & 0xff;
  if (p.s3 & S3.TRANSFORMED) return;
  const pm = b.party[b.playerMonNumber];
  pm.pp[i] = (pm.pp[i] - 1) & 0xff;
}

/** IncrementMovePP (Mirror Move / Metronome give back the PP that DecrementPP will take again). */
function incrementMovePP(b: Battle): void {
  const isPlayer = b.whoseTurn === 0;
  const s = b.att;
  const i = s.moveListIndex;
  s.mon.pp[i] = (s.mon.pp[i] + 1) & 0xff;
  const pm = isPlayer ? b.party[b.playerMonNumber] : b.enemyParty[b.enemyMonPartyPos];
  if (pm) pm.pp[i] = (pm.pp[i] + 1) & 0xff;
}

// ------------------------------------------------------------------ Mirror Move / Metronome
/** MirrorMoveCopyMove: returns false (Z) if it failed. */
function* mirrorMoveCopyMove(b: Battle): Co<boolean> {
  const s = b.att;
  const move = b.def.usedMove;
  s.selectedMove = move;
  if (move === M.MIRROR_MOVE || !move) {
    yield* b.print('_MirrorMoveFailedText');
    return false;
  }
  reloadMoveData(b, move);
  return true;
}

function reloadMoveData(b: Battle, move: number): void {
  const s = b.att;
  loadMoveData(b, s, move);
  incrementMovePP(b);
  b.setMem('wNameBuffer', b.bundle.moves[move - 1].name);
}

/** MetronomePickMove */
function* metronomePickMove(b: Battle): Co {
  yield* playMoveAnimation(b, M.METRONOME, 0);
  const s = b.att;
  let a: number;
  do a = b.random();
  while (!a || a >= M.STRUGGLE || a === M.METRONOME);
  s.selectedMove = a;
  reloadMoveData(b, a);
}

// ------------------------------------------------------------------ damage
/** GetEnemyMonStat: the enemy's stat recomputed from species, level and DVs (no stat exp). */
function getEnemyMonStat(b: Battle, stat: 'atk' | 'def' | 'spc'): number {
  const en = b.enemy.mon;
  const sp = b.header(en.species);
  const d = splitDVs(en.dvs);
  return calcStat(sp.baseStats[stat], d[stat], 0, en.level, stat, false);
}

/** Values handed from GetDamageVars* to CalculateDamage (registers b, c, d, e). */
interface DamageVars {
  atk: number;
  def: number;
  power: number;
  level: number;
}
let dv: DamageVars = { atk: 0, def: 0, power: 0, level: 0 };

/** GetDamageVarsForPlayerAttack: returns false (Z) if the move has no power. */
export function getDamageVarsForPlayerAttack(b: Battle): boolean {
  b.damage = 0;
  const p = b.player;
  const en = b.enemy;
  const power = p.move.power;
  if (!power) {
    dv.power = 0;
    return false;
  }
  let def: number;
  let atk: number;
  if (p.move.type < T.SPECIAL) {
    def = en.mon.def;
    if (en.s3 & S3.HAS_REFLECT_UP) def = (def * 2) & 0xffff;
    atk = p.mon.atk;
    if (b.criticalHitOrOHKO) {
      def = getEnemyMonStat(b, 'def');
      atk = b.party[b.playerMonNumber].atk;
    }
  } else {
    def = en.mon.spc;
    if (en.s3 & S3.HAS_LIGHT_SCREEN_UP) def = (def * 2) & 0xffff;
    atk = p.mon.spc;
    if (b.criticalHitOrOHKO) {
      def = getEnemyMonStat(b, 'spc');
      atk = b.party[b.playerMonNumber].spc;
    }
  }
  dv = scaleStats(atk, def, power, p.mon.level, b.criticalHitOrOHKO !== 0);
  return true;
}

/** GetDamageVarsForEnemyAttack */
export function getDamageVarsForEnemyAttack(b: Battle): boolean {
  b.damage = 0;
  const p = b.player;
  const en = b.enemy;
  const power = en.move.power;
  if (!power) {
    dv.power = 0;
    return false;
  }
  let def: number;
  let atk: number;
  if (en.move.type < T.SPECIAL) {
    def = p.mon.def;
    if (p.s3 & S3.HAS_REFLECT_UP) def = (def * 2) & 0xffff;
    atk = en.mon.atk;
    if (b.criticalHitOrOHKO) {
      def = b.party[b.playerMonNumber].def;
      atk = getEnemyMonStat(b, 'atk');
    }
  } else {
    def = p.mon.spc;
    if (p.s3 & S3.HAS_LIGHT_SCREEN_UP) def = (def * 2) & 0xffff;
    atk = en.mon.spc;
    if (b.criticalHitOrOHKO) {
      def = b.party[b.playerMonNumber].spc;
      atk = getEnemyMonStat(b, 'spc');
    }
  }
  dv = scaleStats(atk, def, power, en.mon.level, b.criticalHitOrOHKO !== 0);
  return true;
}

/** .scaleStats: if either stat exceeds 255, both are divided by 4 (keeping only the low byte). */
function scaleStats(atk: number, def: number, power: number, level: number, crit: boolean): DamageVars {
  let a = atk;
  let d = def;
  if ((a >> 8) | (d >> 8)) {
    d >>= 2;
    a >>= 2;
    if (!a) a = 1;
  }
  return { atk: a & 0xff, def: d & 0xff, power, level: crit ? (level * 2) & 0xff : level };
}

/** CalculateDamage: returns false (Z) for 0-power moves (and missed OHKO moves). */
export function* calculateDamage(b: Battle, _nonzero: boolean): Co<boolean> {
  const s = b.att;
  let def = dv.def;
  if (s.move.effect === E.EXPLODE_EFFECT) {
    def >>= 1;
    if (!def) def = 1;
  }
  const eff = s.move.effect;
  if (eff !== E.TWO_TO_FIVE_ATTACKS_EFFECT && eff !== E.EFFECT_1E) {
    if (eff === E.OHKO_EFFECT) {
      // JumpToOHKOMoveEffect
      yield* jumpMoveEffect(b);
      return b.moveMissed !== 1;
    }
    if (!dv.power) return false;
  }
  if (!def) throw new Error('CalculateDamage: division by zero (the original hangs here)');
  let q = Math.floor((dv.level * 2) / 5) + 2;
  q = q * dv.power * dv.atk;
  q = Math.floor(q / def);
  q = Math.floor(q / 50);
  // add wDamage's high byte (always 0 here), add to wDamage, cap at 997, then add 2
  q += b.damage >> 8;
  const cap = c('battle', 'MAX_NEUTRAL_DAMAGE') - c('battle', 'MIN_NEUTRAL_DAMAGE');
  let dmg: number;
  if (q > cap) dmg = cap;
  else {
    dmg = (b.damage & 0xffff) + q;
    if (dmg > cap) dmg = cap;
  }
  b.damage = dmg + c('battle', 'MIN_NEUTRAL_DAMAGE');
  return true;
}

/** CriticalHitTest */
export function criticalHitTest(b: Battle): void {
  b.criticalHitOrOHKO = 0;
  const s = b.att;
  const sp = b.header(s.mon.species);
  let rate = sp.baseStats.spd >> 1;
  if (!s.move.power) return;
  if (s.s2 & S2.GETTING_PUMPED) rate >>= 1; // the Focus Energy bug: quarters instead of quadrupling
  else rate = Math.min(0xff, rate * 2);
  if (b.bundle.battle.highCriticalMoves.includes(s.move.num)) {
    rate = Math.min(0xff, rate * 2);
    rate = Math.min(0xff, rate * 2);
  } else rate >>= 1;
  const r = b.random();
  const rot = ((r << 3) | (r >> 5)) & 0xff;
  if (rot < rate) b.criticalHitOrOHKO = 1;
}

/** HandleCounterMove: returns true (Z) when the move is Counter (hit or miss decided here). */
export function handleCounterMove(b: Battle): boolean {
  const s = b.att;
  const t = b.def;
  if (s.selectedMove !== M.COUNTER) return false;
  b.moveMissed = 1;
  if (t.selectedMove === M.COUNTER) return true;
  if (!t.move.power) return true;
  if (t.move.type !== T.NORMAL && t.move.type !== T.FIGHTING) return true;
  if (!b.damage) return true;
  b.damage = Math.min(0xffff, b.damage * 2);
  b.moveMissed = 0;
  moveHitTest(b);
  return true;
}

/** AdjustDamageForMoveType: STAB, then every matching TypeEffects pair in table order. */
export function adjustDamageForMoveType(b: Battle): void {
  const s = b.att;
  const t = b.def;
  const mt = s.move.type;
  if (mt === s.mon.types[0] || mt === s.mon.types[1]) {
    b.damage = (b.damage + (b.damage >> 1)) & 0xffff;
    b.damageMultipliers |= 0x80;
  }
  for (const [atkType, defType, mult] of b.bundle.types.chart) {
    if (atkType !== mt) continue;
    if (defType !== t.mon.types[0] && defType !== t.mon.types[1]) continue;
    b.damageMultipliers = (b.damageMultipliers & 0x80) + mult;
    b.damage = Math.floor((b.damage * mult) / 10) & 0xffff;
    if (!b.damage) b.moveMissed = 1;
  }
}

/** AIGetTypeEffectiveness: the first matching pair only; $10 when none matches (the original's bug). */
export function aiGetTypeEffectiveness(b: Battle): number {
  const d = b.enemy.move.type;
  const [t1, t2] = b.player.mon.types;
  for (const [atkType, defType, mult] of b.bundle.types.chart) {
    if (atkType !== d) continue;
    if (defType !== t1 && defType !== t2) continue;
    if (b.trainerClass === c('trainer', 'LORELEI') && b.enemy.mon.species === c('pokemon', 'DEWGONG')) {
      if (b.random() < 0x66) return 0x10;
    }
    return mult;
  }
  return 0x10;
}

/** MoveHitTest */
export function moveHitTest(b: Battle): void {
  const s = b.att;
  const t = b.def;
  const eff = s.move.effect;
  if (eff === E.DREAM_EATER_EFFECT && !(t.mon.status & ST.SLP_MASK)) return moveMissed(b);
  if (eff === E.SWIFT_EFFECT) return;
  if (t.s2 & S2.HAS_SUBSTITUTE_UP) {
    // CheckTargetSubstitute leaves hWhoseTurn in a, so these comparisons never match.
    const a = b.whoseTurn;
    if (a === E.DRAIN_HP_EFFECT || a === E.DREAM_EATER_EFFECT) return moveMissed(b);
  }
  if (t.s1 & S1.INVULNERABLE) return moveMissed(b);
  const mistAffected =
    (eff >= E.ATTACK_DOWN1_EFFECT && eff <= E.HAZE_EFFECT) || (eff >= E.ATTACK_DOWN2_EFFECT && eff <= E.REFLECT_EFFECT);
  if (mistAffected && t.s2 & S2.PROTECTED_BY_MIST) return moveMissed(b);
  if (s.s2 & S2.USING_X_ACCURACY) return;
  calcHitChance(b);
  if (b.random() >= s.move.accuracy) moveMissed(b);
}

function moveMissed(b: Battle): void {
  b.damage = 0;
  b.moveMissed = 1;
  b.att.s1 &= ~S1.USING_TRAPPING_MOVE;
}

/** CalcHitChance: scale accuracy by the user's accuracy and the target's evasion stages. */
export function calcHitChance(b: Battle): void {
  const s = b.att;
  const t = b.def;
  const ratios = b.bundle.battle.statModifierRatios;
  let v = s.move.accuracy;
  for (const stage of [s.mods[4], 14 - t.mods[5]]) {
    const [num, den] = ratios[stage - 1];
    v = Math.floor((v * num) / den);
    if (!v) v = 1;
  }
  s.move.accuracy = v > 0xff ? 0xff : v;
}

/** RandomizeDamage: damage * r / 255 with r in [217, 255] (rrca of a random byte). */
export function randomizeDamage(b: Battle): void {
  if (b.damage < 2) return;
  let r: number;
  do {
    const a = b.random();
    r = ((a >> 1) | ((a & 1) << 7)) & 0xff;
  } while (r < pct(85) + 1);
  b.damage = Math.floor((b.damage * r) / 255) & 0xffff;
}

// ------------------------------------------------------------------ applying damage
/** ApplyAttackToEnemyPokemon / ApplyAttackToPlayerPokemon */
function* applyAttack(b: Battle, toEnemy: boolean): Co {
  const s = b.att;
  const eff = s.move.effect;
  if (eff === E.OHKO_EFFECT) return yield* applyDamage(b, toEnemy);
  if (eff === E.SUPER_FANG_EFFECT) {
    const t = toEnemy ? b.enemy : b.player;
    b.damage = t.mon.hp >> 1 || 1;
    return yield* applyDamage(b, toEnemy);
  }
  if (eff === E.SPECIAL_DAMAGE_EFFECT) {
    const lvl = s.mon.level;
    let dmg: number;
    if (s.move.num === M.SEISMIC_TOSS || s.move.num === M.NIGHT_SHADE) dmg = lvl;
    else if (s.move.num === M.SONICBOOM) dmg = c('battle', 'SONICBOOM_DAMAGE');
    else if (s.move.num === M.DRAGON_RAGE) dmg = c('battle', 'DRAGON_RAGE_DAMAGE');
    else {
      // Psywave: the player's loop also rejects 0
      const max = (lvl + (lvl >> 1)) & 0xff;
      let r: number;
      do r = b.random();
      while ((toEnemy && !r) || r >= max);
      dmg = r;
    }
    b.damage = dmg;
    return yield* applyDamage(b, toEnemy);
  }
  if (!s.move.power) {
    b.drawHUDsAndHPBars();
    return;
  }
  yield* applyDamage(b, toEnemy);
}

export const applyAttackToEnemyPokemon = (b: Battle) => applyAttack(b, true);
export const applyAttackToPlayerPokemon = (b: Battle) => applyAttack(b, false);
export const applyDamageToEnemyPokemon = (b: Battle) => applyDamage(b, true);
export const applyDamageToPlayerPokemon = (b: Battle) => applyDamage(b, false);

/** ApplyDamageTo*Pokemon */
function* applyDamage(b: Battle, toEnemy: boolean): Co {
  if (!b.damage) {
    b.drawHUDsAndHPBars();
    return;
  }
  const t = toEnemy ? b.enemy : b.player;
  if (t.s2 & S2.HAS_SUBSTITUTE_UP) return yield* attackSubstitute(b);
  const old = t.mon.hp;
  if (b.damage > old) {
    b.damage = old;
    t.mon.hp = 0;
  } else t.mon.hp = old - b.damage;
  yield* b.updateHPBar(toEnemy ? 1 : 0, old);
  b.drawHUDsAndHPBars();
}

/** AttackSubstitute: damage over 255 always breaks it; reaching exactly 0 does not. */
function* attackSubstitute(b: Battle): Co {
  yield* b.print('_SubstituteTookDamageText');
  const t = b.def;
  if (!(b.damage >> 8)) {
    const v = t.substituteHP - (b.damage & 0xff);
    t.substituteHP = v & 0xff;
    if (v >= 0) return;
  }
  t.s2 &= ~S2.HAS_SUBSTITUTE_UP;
  yield* b.print('_SubstituteBrokeText');
  b.whoseTurn ^= 1;
  yield* b.ui.substituteBroke(b.whoseTurn);
  b.whoseTurn ^= 1;
  b.att.move.effect = 0;
  b.drawHUDsAndHPBars();
}

/** HandleBuildingRage: the target's Attack rises if it is using Rage. */
function* handleBuildingRage(b: Battle): Co {
  const t = b.def;
  if (!(t.s2 & S2.USING_RAGE)) return;
  if (t.mods[0] === 13) return;
  b.whoseTurn ^= 1;
  t.move.num = 0;
  t.move.effect = E.ATTACK_UP1_EFFECT;
  yield* b.print('_BuildingRageText');
  yield* statModifierUpEffect(b);
  t.move.effect = 0;
  t.move.num = M.RAGE;
  b.whoseTurn ^= 1;
}

// ------------------------------------------------------------------ stats
/** CalculateModifiedStat for one of attack/defense/speed/special. */
export function calculateModifiedStat(b: Battle, side: Side, i: number): void {
  const key = MOD_STATS[i];
  const [num, den] = b.bundle.battle.statModifierRatios[side.mods[i] - 1];
  let v = Math.floor((side.unmod[key] * num) / den);
  if (v > MAX_STAT_VALUE) v = MAX_STAT_VALUE;
  if (!v) v = 1;
  side.mon[key] = v;
}

/** CalculateModifiedStats (wCalculateWhoseStats: 0 = player). */
export function calculateModifiedStats(b: Battle, whose: number): void {
  const side = b.side(whose);
  for (let i = 0; i < 4; i++) calculateModifiedStat(b, side, i);
}

/**
 * ApplyBurnAndParalysisPenalties with hWhoseTurn = `turn`: the penalties hit
 * the mon whose turn it is NOT (sets hWhoseTurn like the original).
 */
export function applyBurnAndParalysisPenalties(b: Battle, turn: number): void {
  b.whoseTurn = turn;
  quarterSpeedDueToParalysis(b);
  halveAttackDueToBurn(b);
}

export function quarterSpeedDueToParalysis(b: Battle): void {
  const t = b.def;
  if (!(t.mon.status & ST.PAR)) return;
  t.mon.spd = t.mon.spd >> 2 || 1;
}

export function halveAttackDueToBurn(b: Battle): void {
  const t = b.def;
  if (!(t.mon.status & ST.BRN)) return;
  t.mon.atk = t.mon.atk >> 1 || 1;
}

/** ApplyBadgeStatBoosts: +1/8 to the player's battle stats for Boulder/Thunder/Soul/Volcano. */
export function applyBadgeStatBoosts(b: Battle): void {
  const badges = b.e.state.badges;
  const keys = ['atk', 'def', 'spd', 'spc'] as const;
  for (let i = 0; i < 4; i++) {
    if (!((badges >> (i * 2)) & 1)) continue;
    const m = b.player.mon;
    m[keys[i]] = Math.min(MAX_STAT_VALUE, m[keys[i]] + (m[keys[i]] >> 3));
  }
}

// re-exported for the menus/effects modules
export { moveSelectionMenu, WILD_BATTLE };
