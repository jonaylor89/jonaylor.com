/**
 * Move effects: MoveEffectPointerTable (data/moves/effects_pointers.asm) and
 * the handlers in engine/battle/effects.asm and engine/battle/move_effects/.
 */
import type { Co } from '../engine/Engine';
import type { Battle } from './Battle';
import { WILD_BATTLE } from './Battle';
import { c } from '../rom/constants';
import { E, M, MAX_STAT_VALUE, MOD_STATS, pct, PP_MASK, S1, S2, S3, ST, STAT_NAMES, T } from './state';
import {
  calculateModifiedStat,
  halveAttackDueToBurn,
  moveHitTest,
  quarterSpeedDueToParalysis,
  applyBadgeStatBoosts,
} from './moves';
import { playMoveAnimation, playCurrentMoveAnimation, playCurrentMoveAnimation2, playBattleAnimation, playBattleAnimation2 } from './animation';
import { mimicMoveMenu } from './menus';

type Effect = (b: Battle) => Co;

/** JumpMoveEffect: run the handler for the current side's move effect. */
export function* jumpMoveEffect(b: Battle): Co {
  const effect = b.att.move.effect;
  const handler = TABLE[effect];
  if (!handler) throw new Error(`no handler for move effect ${effect}`);
  yield* handler(b);
}

// ------------------------------------------------------------------ text helpers
function* printButItFailed(b: Battle): Co {
  yield* b.print('_ButItFailedText');
}
function* conditionalPrintButItFailed(b: Battle): Co {
  if (b.moveDidntMiss) return;
  yield* printButItFailed(b);
}
function* printDidntAffect(b: Battle): Co {
  yield* b.print('_DidntAffectText');
}

function clearHyperBeam(b: Battle): void {
  b.def.s2 &= ~S2.NEEDS_TO_RECHARGE;
}

function targetHasSubstitute(b: Battle): boolean {
  return (b.def.s2 & S2.HAS_SUBSTITUTE_UP) !== 0;
}

// ------------------------------------------------------------------ status
/** SleepEffect */
function* sleepEffect(b: Battle): Co {
  const t = b.def;
  const recharging = (t.s2 & S2.NEEDS_TO_RECHARGE) !== 0;
  t.s2 &= ~S2.NEEDS_TO_RECHARGE;
  if (!recharging) {
    if (t.mon.status & ST.SLP_MASK) {
      yield* b.print('_AlreadyAsleepText');
      return;
    }
    if (t.mon.status) return yield* printDidntAffect(b);
    moveHitTest(b);
    if (b.moveMissed) return yield* printDidntAffect(b);
  }
  let turns: number;
  do turns = b.random() & ST.SLP_MASK;
  while (!turns);
  t.mon.status = turns;
  yield* playCurrentMoveAnimation2(b);
  yield* b.print('_FellAsleepText');
}

/** PoisonEffect */
function* poisonEffect(b: Battle): Co {
  const s = b.att;
  const t = b.def;
  const eff = s.move.effect;
  const noEffect = function* () {
    if (eff !== E.POISON_EFFECT) return;
    yield* b.delay(50);
    yield* printDidntAffect(b);
  };
  if (targetHasSubstitute(b)) return yield* noEffect();
  if (t.mon.status) return yield* noEffect();
  if (t.mon.types[0] === T.POISON || t.mon.types[1] === T.POISON) return yield* noEffect();
  if (eff === E.POISON_SIDE_EFFECT1 || eff === E.POISON_SIDE_EFFECT2) {
    const chance = eff === E.POISON_SIDE_EFFECT1 ? pct(20) + 1 : pct(40) + 1;
    if (b.random() >= chance) return;
  } else {
    moveHitTest(b);
    if (b.moveMissed) {
      yield* b.delay(50);
      return yield* printDidntAffect(b);
    }
  }
  t.mon.status |= ST.PSN;
  let text = '_PoisonedText';
  if (s.move.num === M.TOXIC) {
    t.s3 |= S3.BADLY_POISONED;
    t.toxicCounter = 0;
    text = '_BadlyPoisonedText';
  }
  if (eff === E.POISON_EFFECT) yield* playCurrentMoveAnimation2(b);
  else
    yield* playBattleAnimation2(b, c('move', b.whoseTurn ? 'SHAKE_SCREEN_ANIM' : 'ENEMY_HUD_SHAKE_ANIM'));
  yield* b.print(text);
}

/** DrainHPEffect_ */
function* drainHPEffect(b: Battle): Co {
  const s = b.att;
  b.damage = b.damage >> 1 || 1;
  const old = s.mon.hp;
  let hp = old + b.damage;
  if (hp > 0xffff || hp > s.mon.maxHp) hp = s.mon.maxHp;
  s.mon.hp = hp;
  yield* b.updateHPBar(b.whoseTurn, old);
  b.drawPlayerHUDAndHPBar();
  b.drawEnemyHUDAndHPBar();
  b.readPlayerMonCurHPAndStatus();
  yield* b.print(s.move.effect === E.DREAM_EATER_EFFECT ? '_DreamWasEatenText' : '_SuckedHealthText');
}

/** ExplodeEffect */
// eslint-disable-next-line require-yield
function* explodeEffect(b: Battle): Co {
  const s = b.att;
  s.mon.hp = 0;
  s.mon.status = 0;
  s.s2 &= ~S2.SEEDED;
}

/** FreezeBurnParalyzeEffect */
function* freezeBurnParalyzeEffect(b: Battle): Co {
  const s = b.att;
  const t = b.def;
  if (targetHasSubstitute(b)) return;
  if (t.mon.status) return yield* checkDefrost(b);
  const mt = s.move.type;
  if (t.mon.types[0] === mt || t.mon.types[1] === mt) return;
  let eff = s.move.effect;
  let chance: number;
  if (eff === E.FREEZE_SIDE_EFFECT2) {
    // Stadium leftover: wUnknownSerialFlag_d499 is 0, so 30%
    eff = E.FREEZE_SIDE_EFFECT1;
    chance = pct(30) + 1;
  } else if (eff <= E.PARALYZE_SIDE_EFFECT1) chance = pct(10) + 1;
  else {
    chance = pct(30) + 1;
    eff -= E.PARALYZE_SIDE_EFFECT2 - E.PARALYZE_SIDE_EFFECT1;
  }
  if (b.random() >= chance) return;
  const isPlayer = b.whoseTurn === 0;
  const anim = () =>
    isPlayer
      ? playBattleAnimation(b, c('move', 'ENEMY_HUD_SHAKE_ANIM'))
      : playBattleAnimation2(b, c('move', 'SHAKE_SCREEN_ANIM'));
  if (eff === E.BURN_SIDE_EFFECT1) {
    t.mon.status = ST.BRN;
    halveAttackDueToBurn(b);
    yield* anim();
    yield* b.print('_BurnedText');
  } else if (eff === E.FREEZE_SIDE_EFFECT1) {
    if (isPlayer) clearHyperBeam(b); // (the enemy's version doesn't clear the player's recharge)
    t.mon.status = ST.FRZ;
    yield* anim();
    yield* b.print('_FrozenText');
  } else {
    t.mon.status = ST.PAR;
    quarterSpeedDueToParalysis(b);
    yield* anim();
    yield* b.print('_ParalyzedMayNotAttackText');
  }
}

/** CheckDefrost: a Fire-type move thaws a frozen target. */
function* checkDefrost(b: Battle): Co {
  const t = b.def;
  if (!(t.mon.status & ST.FRZ)) return;
  if (b.att.move.type !== T.FIRE) return;
  t.mon.status = 0;
  const pm = b.whoseTurn === 0 ? b.enemyParty[b.enemyMonPartyPos] : b.party[b.playerMonNumber];
  if (pm) pm.status = 0;
  yield* b.print('_FireDefrostedText');
}

// ------------------------------------------------------------------ stat mods
/** StatModifierUpEffect */
export function* statModifierUpEffect(b: Battle): Co {
  const s = b.att;
  const eff = s.move.effect;
  let i = eff - E.ATTACK_UP1_EFFECT;
  if (i >= E.EVASION_UP1_EFFECT + 3 - E.ATTACK_UP1_EFFECT) i -= E.ATTACK_UP2_EFFECT - E.ATTACK_UP1_EFFECT;
  let mod = s.mods[i] + 1;
  if (mod > 13) return yield* b.print('_NothingHappenedText');
  if (eff >= E.ATTACK_UP1_EFFECT + 8) {
    mod++;
    if (mod > 13) mod = 13;
  }
  s.mods[i] = mod;
  if (i < 4) {
    const key = MOD_STATS[i];
    if (s.mon[key] === MAX_STAT_VALUE) {
      // RestoreOriginalStatModifier
      s.mods[i]--;
      return yield* b.print('_NothingHappenedText');
    }
    const [num, den] = b.bundle.battle.statModifierRatios[mod - 1];
    s.mon[key] = Math.min(MAX_STAT_VALUE, Math.floor((s.unmod[key] * num) / den));
  }
  // UpdateStatDone
  b.setMem('wStringBuffer', STAT_NAMES[i]);
  const minimize = s.move.num === M.MINIMIZE;
  const sub = (s.s2 & S2.HAS_SUBSTITUTE_UP) !== 0;
  if (minimize && sub) yield* b.ui.hideSubstitute(b.whoseTurn);
  yield* playCurrentMoveAnimation(b);
  if (minimize) {
    s.minimized = 1;
    if (sub) yield* b.ui.reshowSubstitute(b.whoseTurn);
  }
  if (b.whoseTurn === 0) applyBadgeStatBoosts(b); // badge boosts stack up every time the player raises a stat
  const greatly = s.move.effect >= E.ATTACK_DOWN1_EFFECT;
  yield* b.print('_MonsStatsRoseText', ...(greatly ? ['<pause>', '_GreatlyRoseText'] : []), '_RoseText');
  quarterSpeedDueToParalysis(b);
  halveAttackDueToBurn(b);
}

/** StatModifierDownEffect */
function* statModifierDownEffect(b: Battle): Co {
  const s = b.att;
  const t = b.def;
  const eff = s.move.effect;
  const isSide = eff >= E.ATTACK_DOWN_SIDE_EFFECT;
  const missed = function* () {
    if (isSide) return;
    yield* conditionalPrintButItFailed(b);
  };
  const cantLower = function* () {
    if (isSide) return;
    yield* b.print('_NothingHappenedText');
  };
  // the enemy's stat-lowering moves miss an extra 25% of the time (non-link)
  if (b.whoseTurn && b.random() < pct(25) + 1) return yield* missed();
  if (targetHasSubstitute(b)) return yield* missed();
  let i: number;
  if (isSide) {
    if (b.random() >= pct(33) + 1) return yield* cantLower();
    i = eff - E.ATTACK_DOWN_SIDE_EFFECT;
  } else {
    moveHitTest(b);
    if (b.moveMissed) return yield* missed();
    if (t.s1 & S1.INVULNERABLE) return yield* missed();
    i = eff - E.ATTACK_DOWN1_EFFECT;
    if (i >= E.EVASION_DOWN1_EFFECT + 3 - E.ATTACK_DOWN1_EFFECT) i -= E.ATTACK_DOWN2_EFFECT - E.ATTACK_DOWN1_EFFECT;
  }
  let mod = t.mods[i] - 1;
  if (!mod) return yield* cantLower();
  if (eff >= E.ATTACK_DOWN2_EFFECT - 0x16 && !isSide) {
    mod--;
    if (!mod) mod = 1;
  }
  t.mods[i] = mod;
  if (i < 4) {
    const key = MOD_STATS[i];
    if (t.mon[key] === 1) {
      // CantLowerAnymore_Pop
      t.mods[i]++;
      return yield* cantLower();
    }
    const [num, den] = b.bundle.battle.statModifierRatios[mod - 1];
    t.mon[key] = Math.floor((t.unmod[key] * num) / den) || 1;
  }
  // UpdateLoweredStatDone
  b.setMem('wStringBuffer', STAT_NAMES[i]);
  if (!isSide) yield* playCurrentMoveAnimation2(b);
  if (b.whoseTurn) applyBadgeStatBoosts(b); // ...and every time the enemy lowers one
  const greatly = eff >= E.BIDE_EFFECT && eff < E.ATTACK_DOWN_SIDE_EFFECT;
  yield* b.print('_MonsStatsFellText', ...(greatly ? ['<pause>', '_GreatlyFellText'] : []), '_FellText');
  quarterSpeedDueToParalysis(b);
  halveAttackDueToBurn(b);
}

// ------------------------------------------------------------------ multi-turn
/** BideEffect */
function* bideEffect(b: Battle): Co {
  const s = b.att;
  s.s1 |= S1.STORING_ENERGY;
  s.bideDamage = 0;
  b.player.move.effect = 0;
  b.enemy.move.effect = 0;
  s.numAttacksLeft = (b.random() & 1) + 2;
  yield* playBattleAnimation2(b, c('move', 'XSTATITEM_ANIM') + b.whoseTurn);
}

/** ThrashPetalDanceEffect */
function* thrashPetalDanceEffect(b: Battle): Co {
  const s = b.att;
  s.s1 |= S1.THRASHING_ABOUT;
  s.numAttacksLeft = (b.random() & 1) + 2;
  yield* playBattleAnimation2(b, c('move', 'SHRINKING_SQUARE_ANIM') + b.whoseTurn);
}

/** SwitchAndTeleportEffect (Teleport, Roar, Whirlwind) */
function* switchAndTeleportEffect(b: Battle): Co {
  const s = b.att;
  const isPlayer = b.whoseTurn === 0;
  if (b.isInBattle === WILD_BATTLE) {
    const userLevel = isPlayer ? b.player.mon.level : b.curEnemyLevel;
    const otherLevel = isPlayer ? b.curEnemyLevel : b.player.mon.level;
    let ok = userLevel >= otherLevel;
    if (!ok) {
      const cMax = (userLevel + otherLevel + 1) & 0xff;
      let r: number;
      do r = b.random();
      while (r >= cMax);
      ok = r >= otherLevel >> 2;
    }
    if (!ok) {
      yield* b.delay(50);
      if (s.move.num !== M.TELEPORT) return yield* printDidntAffect(b);
      return yield* printButItFailed(b);
    }
    b.readPlayerMonCurHPAndStatus();
    b.escapedFromBattle = 1;
    const move = s.move.num;
    yield* playBattleAnimation(b, move);
    yield* b.delay(20);
    const text = move === M.TELEPORT ? '_RanFromBattleText' : move === M.ROAR ? '_RanAwayScaredText' : '_WasBlownAwayText';
    yield* b.print(text);
    return;
  }
  yield* b.delay(50);
  if (s.move.num !== M.TELEPORT) return yield* b.print('_IsUnaffectedText');
  if (isPlayer) return yield* printButItFailed(b);
  return yield* conditionalPrintButItFailed(b);
}

/** TwoToFiveAttacksEffect (also Double Kick/Bonemerang and Twineedle) */
// eslint-disable-next-line require-yield
function* twoToFiveAttacksEffect(b: Battle): Co {
  const s = b.att;
  if (s.s1 & S1.ATTACKING_MULTIPLE_TIMES) return;
  s.s1 |= S1.ATTACKING_MULTIPLE_TIMES;
  let n: number;
  if (s.move.effect === E.TWINEEDLE_EFFECT) {
    // Twineedle's effect becomes the poison side effect, and its hit count is that effect's value.
    s.move.effect = E.POISON_SIDE_EFFECT1;
    n = E.POISON_SIDE_EFFECT1;
  } else if (s.move.effect === E.ATTACK_TWICE_EFFECT) n = 2;
  else {
    let a = b.random() & 3;
    if (a >= 2) a = b.random() & 3;
    n = a + 2;
  }
  s.numAttacksLeft = n;
  s.numHits = n;
}

/** FlinchSideEffect */
// eslint-disable-next-line require-yield
function* flinchSideEffect(b: Battle): Co {
  if (targetHasSubstitute(b)) return;
  const chance = b.att.move.effect === E.FLINCH_SIDE_EFFECT1 ? pct(10) + 1 : pct(30) + 1;
  if (b.random() >= chance) return;
  b.def.s1 |= S1.FLINCHED;
  clearHyperBeam(b);
}

/** OneHitKOEffect_ */
// eslint-disable-next-line require-yield
function* oneHitKOEffect(b: Battle): Co {
  b.damage = 0;
  b.criticalHitOrOHKO = 0xff;
  if (b.att.mon.spd < b.def.mon.spd) {
    b.moveMissed = 1;
    return;
  }
  b.damage = 0xffff;
  b.criticalHitOrOHKO = 2;
}

/** ChargeEffect (two-turn moves, Fly and Dig) */
function* chargeEffect(b: Battle): Co {
  const s = b.att;
  s.s1 |= S1.CHARGING_UP;
  let anim = c('move', b.whoseTurn ? 'XSTATITEM_DUPLICATE_ANIM' : 'XSTATITEM_ANIM');
  if (s.move.effect === E.FLY_EFFECT) {
    s.s1 |= S1.INVULNERABLE;
    anim = M.TELEPORT;
  }
  if (s.move.num === M.DIG) {
    s.s1 |= S1.INVULNERABLE;
    anim = c('move', 'SLIDE_DOWN_ANIM');
  }
  const sub = (s.s2 & S2.HAS_SUBSTITUTE_UP) !== 0;
  if (sub) yield* b.ui.hideSubstitute(b.whoseTurn);
  yield* playBattleAnimation(b, anim, 0);
  if (sub) yield* b.ui.reshowSubstitute(b.whoseTurn);
  const move = s.move.num;
  const follow: Record<number, string> = {
    [M.RAZOR_WIND]: '_MadeWhirlwindText',
    [M.SOLARBEAM]: '_TookInSunlightText',
    [M.SKULL_BASH]: '_LoweredItsHeadText',
    [M.SKY_ATTACK]: '_SkyAttackGlowingText',
    [M.FLY]: '_FlewUpHighText',
    [M.DIG]: '_DugAHoleText',
  };
  // ChargeMoveEffectText falls through to DugAHoleText for anything else
  yield* b.print('_ChargeMoveEffectText', follow[move] ?? '_DugAHoleText');
}

/** TrappingEffect (Wrap, Bind, Fire Spin, Clamp) */
// eslint-disable-next-line require-yield
function* trappingEffect(b: Battle): Co {
  const s = b.att;
  if (s.s1 & S1.USING_TRAPPING_MOVE) return;
  clearHyperBeam(b);
  s.s1 |= S1.USING_TRAPPING_MOVE;
  let a = b.random() & 3;
  if (a >= 2) a = b.random() & 3;
  s.numAttacksLeft = a + 1;
}

/** MistEffect_ */
function* mistEffect(b: Battle): Co {
  const s = b.att;
  if (s.s2 & S2.PROTECTED_BY_MIST) return yield* printButItFailed(b);
  s.s2 |= S2.PROTECTED_BY_MIST;
  yield* playCurrentMoveAnimation(b);
  yield* b.print('_ShroudedInMistText');
}

/** FocusEnergyEffect_ */
function* focusEnergyEffect(b: Battle): Co {
  const s = b.att;
  if (s.s2 & S2.GETTING_PUMPED) {
    yield* b.delay(50);
    return yield* printButItFailed(b);
  }
  s.s2 |= S2.GETTING_PUMPED;
  yield* playCurrentMoveAnimation(b);
  yield* b.print('_GettingPumpedText');
}

/** RecoilEffect_ (1/4 of the damage dealt, 1/2 for Struggle; at least 1) */
function* recoilEffect(b: Battle): Co {
  const s = b.att;
  let r = b.damage >> 1;
  if (s.move.num !== M.STRUGGLE) r >>= 1;
  if (!r) r = 1;
  const old = s.mon.hp;
  s.mon.hp = Math.max(0, old - r);
  yield* b.updateHPBar(b.whoseTurn, old);
  yield* b.print('_HitWithRecoilText');
}

/** ConfusionSideEffect (10%) */
function* confusionSideEffect(b: Battle): Co {
  if (b.random() >= pct(10)) return;
  yield* confuseTarget(b);
}

/** ConfusionEffect */
function* confusionEffect(b: Battle): Co {
  if (targetHasSubstitute(b)) return yield* confusionFailed(b);
  moveHitTest(b);
  if (b.moveMissed) return yield* confusionFailed(b);
  yield* confuseTarget(b);
}

function* confuseTarget(b: Battle): Co {
  const t = b.def;
  if (t.s1 & S1.CONFUSED) return yield* confusionFailed(b);
  t.s1 |= S1.CONFUSED;
  t.confusedCounter = (b.random() & 3) + 2;
  if (b.att.move.effect !== E.CONFUSION_SIDE_EFFECT) yield* playCurrentMoveAnimation2(b);
  yield* b.print('_BecameConfusedText');
}

function* confusionFailed(b: Battle): Co {
  if (b.att.move.effect === E.CONFUSION_SIDE_EFFECT) return;
  yield* b.delay(50);
  yield* conditionalPrintButItFailed(b);
}

/** ParalyzeEffect_ (Thunder Wave, Stun Spore, Glare) */
function* paralyzeEffect(b: Battle): Co {
  const s = b.att;
  const t = b.def;
  if (t.mon.status) {
    yield* b.delay(50);
    return yield* printDidntAffect(b);
  }
  if (s.move.type === T.ELECTRIC && (t.mon.types[0] === T.GROUND || t.mon.types[1] === T.GROUND)) {
    yield* b.delay(50);
    return yield* b.print('_DoesntAffectMonText');
  }
  moveHitTest(b);
  if (b.moveMissed) {
    yield* b.delay(50);
    return yield* printDidntAffect(b);
  }
  t.mon.status |= ST.PAR;
  quarterSpeedDueToParalysis(b);
  yield* b.delay(30);
  yield* playCurrentMoveAnimation(b);
  yield* b.print('_ParalyzedMayNotAttackText');
}

/** SubstituteEffect_ (can leave the user at 0 HP) */
function* substituteEffect(b: Battle): Co {
  yield* b.delay(50);
  const s = b.att;
  if (s.s2 & S2.HAS_SUBSTITUTE_UP) return yield* b.print('_HasSubstituteText');
  const cost = (s.mon.maxHp >> 2) & 0xff;
  s.substituteHP = cost;
  const hp = s.mon.hp - cost;
  if (hp < 0) return yield* b.print('_TooWeakSubstituteText');
  s.mon.hp = hp;
  s.s2 |= S2.HAS_SUBSTITUTE_UP;
  if (b.e.state.options.battleAnimation) yield* playCurrentMoveAnimation(b);
  else yield* b.ui.showSubstitute(b.whoseTurn);
  yield* b.print('_SubstituteText');
  b.drawHUDsAndHPBars();
}

/** HyperBeamEffect */
// eslint-disable-next-line require-yield
function* hyperBeamEffect(b: Battle): Co {
  b.att.s2 |= S2.NEEDS_TO_RECHARGE;
}

/** RageEffect */
// eslint-disable-next-line require-yield
function* rageEffect(b: Battle): Co {
  b.att.s2 |= S2.USING_RAGE;
}

/** MimicEffect */
function* mimicEffect(b: Battle): Co {
  yield* b.delay(50);
  moveHitTest(b);
  if (b.moveMissed) return yield* printButItFailed(b);
  const s = b.att;
  let move: number;
  if (b.whoseTurn === 0) {
    // .letPlayerChooseMove
    if (b.enemy.s1 & S1.INVULNERABLE) return yield* printButItFailed(b);
    const savedItem = b.currentMenuItem;
    const slot = yield* mimicMoveMenu(b); // leaves wCurrentMenuItem at the chosen slot
    b.loadScreen1();
    move = b.enemy.mon.moves[slot];
    s.mon.moves[savedItem] = move;
  } else {
    if (b.player.s1 & S1.INVULNERABLE) return yield* printButItFailed(b);
    do move = b.player.mon.moves[b.random() & 3];
    while (!move);
    s.mon.moves[b.enemy.moveListIndex] = move;
  }
  b.setMem('wNameBuffer', b.bundle.moves[move - 1].name);
  yield* playCurrentMoveAnimation(b);
  yield* b.print('_MimicLearnedMoveText');
}

/** LeechSeedEffect_ */
function* leechSeedEffect(b: Battle): Co {
  moveHitTest(b);
  const t = b.def;
  if (!b.moveMissed && t.mon.types[0] !== T.GRASS && t.mon.types[1] !== T.GRASS && !(t.s2 & S2.SEEDED)) {
    t.s2 |= S2.SEEDED;
    yield* playCurrentMoveAnimation(b);
    return yield* b.print('_WasSeededText');
  }
  yield* b.delay(50);
  yield* b.print('_EvadedAttackText');
}

/** SplashEffect */
function* splashEffect(b: Battle): Co {
  yield* playCurrentMoveAnimation(b);
  yield* b.print('_NoEffectText');
}

/** DisableEffect */
function* disableEffect(b: Battle): Co {
  moveHitTest(b);
  if (b.moveMissed) return yield* printButItFailed(b);
  const t = b.def;
  if (t.disabledMove) return yield* printButItFailed(b);
  const checkPP = b.whoseTurn !== 0; // the player's Disable (non-link) skips the PP checks
  let slot: number;
  for (;;) {
    slot = b.random() & 3;
    if (!t.mon.moves[slot]) continue;
    if (checkPP) {
      if (!(t.mon.pp.reduce((a, v) => a | v, 0) & PP_MASK)) return yield* printButItFailed(b);
      if (!t.mon.pp[slot]) continue;
    }
    break;
  }
  const move = t.mon.moves[slot];
  const turns = (b.random() & 7) + 1;
  t.disabledMove = ((slot + 1) << 4) + turns;
  yield* playCurrentMoveAnimation2(b);
  t.disabledMoveNumber = move;
  b.setMem('wNameBuffer', b.bundle.moves[move - 1].name);
  yield* b.print('_MoveWasDisabledText');
}

/** PayDayEffect_: 2 × level coins, accumulated in BCD-free form. */
function* payDayEffect(b: Battle): Co {
  const lvl = b.att.mon.level;
  b.totalPayDayMoney = Math.min(999999, b.totalPayDayMoney + ((lvl * 2) & 0xff));
  yield* b.print('_CoinsScatteredText');
}

/** ConversionEffect_: the user takes the target's types. */
function* conversionEffect(b: Battle): Co {
  const s = b.att;
  const t = b.def;
  if (t.s1 & S1.INVULNERABLE) return yield* printButItFailed(b);
  s.mon.types = [...t.mon.types] as [number, number];
  yield* playCurrentMoveAnimation(b);
  yield* b.print('_ConvertedTypeText');
}

/** HazeEffect_ (cures only the target's non-volatile status) */
function* hazeEffect(b: Battle): Co {
  for (const side of [b.player, b.enemy]) {
    side.mods = [7, 7, 7, 7, 7, 7];
    for (const k of MOD_STATS) side.mon[k] = side.unmod[k];
  }
  const t = b.def;
  const old = t.mon.status;
  t.mon.status = 0;
  if (old & (ST.FRZ | ST.SLP_MASK)) t.selectedMove = 0xff;
  for (const side of [b.player, b.enemy]) {
    side.disabledMove = 0;
    side.disabledMoveNumber = 0;
    side.s1 &= ~S1.CONFUSED;
    side.s2 &= ~(S2.USING_X_ACCURACY | S2.PROTECTED_BY_MIST | S2.GETTING_PUMPED | S2.SEEDED);
    side.s3 &= 0xf0 | S3.TRANSFORMED;
  }
  yield* playCurrentMoveAnimation(b);
  yield* b.print('_StatusChangesEliminatedText');
}

/** HealEffect_ (Recover, Softboiled, Rest) */
function* healEffect(b: Battle): Co {
  const s = b.att;
  const m = s.mon;
  // only the low bytes are compared (with the high bytes' borrow): fails at max-HP gaps of 255/511
  const borrow = m.hp >> 8 < m.maxHp >> 8 ? 1 : 0;
  if ((((m.hp & 0xff) - (m.maxHp & 0xff) - borrow) & 0xff) === 0) {
    yield* b.delay(50);
    return yield* printButItFailed(b);
  }
  const rest = s.move.num === M.REST;
  if (rest) {
    yield* b.delay(50);
    const had = m.status;
    m.status = 2;
    yield* b.print(had ? '_FellAsleepBecameHealthyText' : '_StartedSleepingEffect');
  }
  const amount = rest ? m.maxHp : m.maxHp >> 1;
  const old = m.hp;
  m.hp = Math.min(m.maxHp, (old + amount) & 0xffff);
  yield* playCurrentMoveAnimation(b);
  yield* b.updateHPBar(b.whoseTurn, old);
  b.drawHUDsAndHPBars();
  yield* b.print('_RegainedHealthText');
}

/** TransformEffect_ (with the original's invulnerability-check bug) */
function* transformEffect(b: Battle): Co {
  const s = b.att;
  const t = b.def;
  let check: number;
  if (b.whoseTurn === 0) {
    b.player.moveListIndex = 0;
    check = b.player.s1;
  } else check = b.whoseTurn; // hWhoseTurn (1) is tested instead of the target's status
  if (check & S1.INVULNERABLE) return yield* printButItFailed(b);
  const sub = (s.s2 & S2.HAS_SUBSTITUTE_UP) !== 0;
  if (sub) yield* b.ui.hideSubstitute(b.whoseTurn);
  yield* playCurrentMoveAnimation(b);
  if (sub) yield* b.ui.reshowSubstitute(b.whoseTurn);
  s.s3 |= S3.TRANSFORMED;
  s.mon.species = t.mon.species;
  s.mon.types = [...t.mon.types] as [number, number];
  s.mon.catchRate = t.mon.catchRate;
  s.mon.moves = [...t.mon.moves];
  if (b.whoseTurn) b.transformedEnemyMonOriginalDVs = s.mon.dvs;
  s.mon.dvs = t.mon.dvs;
  for (const k of MOD_STATS) s.mon[k] = t.mon[k];
  s.mon.pp = t.mon.moves.map((mv) => (mv ? 5 : 0));
  for (const k of MOD_STATS) s.unmod[k] = t.unmod[k];
  s.mods = [...t.mods];
  b.setMem('wNameBuffer', b.header(t.mon.species).name);
  yield* b.print('_TransformedText');
}

/** ReflectLightScreenEffect_ */
function* reflectLightScreenEffect(b: Battle): Co {
  const s = b.att;
  const light = s.move.effect === E.LIGHT_SCREEN_EFFECT;
  const bitMask = light ? S3.HAS_LIGHT_SCREEN_UP : S3.HAS_REFLECT_UP;
  if (s.s3 & bitMask) {
    yield* b.delay(50);
    return yield* printButItFailed(b);
  }
  s.s3 |= bitMask;
  yield* playCurrentMoveAnimation(b);
  yield* b.print(light ? '_LightScreenProtectedText' : '_ReflectGainedArmorText');
}

// ------------------------------------------------------------------ table
const TABLE: Record<number, Effect> = {};
const set = (names: string[], fn: Effect) => names.forEach((n) => (TABLE[c('move_effect', n)] = fn));
set(['EFFECT_01', 'SLEEP_EFFECT'], sleepEffect);
set(['POISON_SIDE_EFFECT1', 'POISON_SIDE_EFFECT2', 'POISON_EFFECT'], poisonEffect);
set(['DRAIN_HP_EFFECT', 'DREAM_EATER_EFFECT'], drainHPEffect);
set(
  ['BURN_SIDE_EFFECT1', 'FREEZE_SIDE_EFFECT1', 'PARALYZE_SIDE_EFFECT1', 'BURN_SIDE_EFFECT2', 'FREEZE_SIDE_EFFECT2', 'PARALYZE_SIDE_EFFECT2'],
  freezeBurnParalyzeEffect,
);
set(['EXPLODE_EFFECT'], explodeEffect);
set(
  ['ATTACK_UP1_EFFECT', 'DEFENSE_UP1_EFFECT', 'SPEED_UP1_EFFECT', 'SPECIAL_UP1_EFFECT', 'ACCURACY_UP1_EFFECT', 'EVASION_UP1_EFFECT',
   'ATTACK_UP2_EFFECT', 'DEFENSE_UP2_EFFECT', 'SPEED_UP2_EFFECT', 'SPECIAL_UP2_EFFECT', 'ACCURACY_UP2_EFFECT', 'EVASION_UP2_EFFECT'],
  statModifierUpEffect,
);
set(
  ['ATTACK_DOWN1_EFFECT', 'DEFENSE_DOWN1_EFFECT', 'SPEED_DOWN1_EFFECT', 'SPECIAL_DOWN1_EFFECT', 'ACCURACY_DOWN1_EFFECT', 'EVASION_DOWN1_EFFECT',
   'ATTACK_DOWN2_EFFECT', 'DEFENSE_DOWN2_EFFECT', 'SPEED_DOWN2_EFFECT', 'SPECIAL_DOWN2_EFFECT', 'ACCURACY_DOWN2_EFFECT', 'EVASION_DOWN2_EFFECT',
   'ATTACK_DOWN_SIDE_EFFECT', 'DEFENSE_DOWN_SIDE_EFFECT', 'SPEED_DOWN_SIDE_EFFECT', 'SPECIAL_DOWN_SIDE_EFFECT'],
  statModifierDownEffect,
);
// the four unused effects after SPECIAL_DOWN_SIDE_EFFECT also point at StatModifierDownEffect
for (let e = c('move_effect', 'SPECIAL_DOWN_SIDE_EFFECT') + 1; e < c('move_effect', 'CONFUSION_SIDE_EFFECT'); e++) TABLE[e] = statModifierDownEffect;
set(['PAY_DAY_EFFECT'], payDayEffect);
set(['CONVERSION_EFFECT'], conversionEffect);
set(['HAZE_EFFECT'], hazeEffect);
set(['BIDE_EFFECT'], bideEffect);
set(['THRASH_PETAL_DANCE_EFFECT'], thrashPetalDanceEffect);
set(['SWITCH_AND_TELEPORT_EFFECT'], switchAndTeleportEffect);
set(['TWO_TO_FIVE_ATTACKS_EFFECT', 'EFFECT_1E', 'ATTACK_TWICE_EFFECT', 'TWINEEDLE_EFFECT'], twoToFiveAttacksEffect);
set(['FLINCH_SIDE_EFFECT1', 'FLINCH_SIDE_EFFECT2'], flinchSideEffect);
set(['OHKO_EFFECT'], oneHitKOEffect);
set(['CHARGE_EFFECT', 'FLY_EFFECT'], chargeEffect);
set(['TRAPPING_EFFECT'], trappingEffect);
set(['MIST_EFFECT'], mistEffect);
set(['FOCUS_ENERGY_EFFECT'], focusEnergyEffect);
set(['RECOIL_EFFECT'], recoilEffect);
set(['CONFUSION_EFFECT'], confusionEffect);
set(['CONFUSION_SIDE_EFFECT'], confusionSideEffect);
set(['HEAL_EFFECT'], healEffect);
set(['TRANSFORM_EFFECT'], transformEffect);
set(['LIGHT_SCREEN_EFFECT', 'REFLECT_EFFECT'], reflectLightScreenEffect);
set(['PARALYZE_EFFECT'], paralyzeEffect);
set(['SUBSTITUTE_EFFECT'], substituteEffect);
set(['HYPER_BEAM_EFFECT'], hyperBeamEffect);
set(['RAGE_EFFECT'], rageEffect);
set(['MIMIC_EFFECT'], mimicEffect);
set(['LEECH_SEED_EFFECT'], leechSeedEffect);
set(['SPLASH_EFFECT'], splashEffect);
set(['DISABLE_EFFECT'], disableEffect);
// NULL entries: MIRROR_MOVE, SWIFT, SUPER_FANG, SPECIAL_DAMAGE, JUMP_KICK, METRONOME and the unused $4E
for (const n of ['MIRROR_MOVE_EFFECT', 'SWIFT_EFFECT', 'SUPER_FANG_EFFECT', 'SPECIAL_DAMAGE_EFFECT', 'JUMP_KICK_EFFECT', 'METRONOME_EFFECT'])
  // eslint-disable-next-line require-yield
  TABLE[c('move_effect', n)] = function* () {
    // dw NULL: jumping here would crash the original; these effects are never dispatched
  };

export { calculateModifiedStat };
