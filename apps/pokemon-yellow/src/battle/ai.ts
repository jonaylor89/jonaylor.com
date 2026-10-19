/**
 * Enemy move selection and the trainer AI: SelectEnemyMove (core.asm) and
 * engine/battle/trainer_ai.asm (AIEnemyTrainerChooseMoves with the four move
 * choice modification layers, TrainerAI and every class routine).
 */
import type { Co } from '../engine/Engine';
import type { Battle } from './Battle';
import { WILD_BATTLE } from './Battle';
import { c } from '../rom/constants';
import { aiGetTypeEffectiveness } from './moves';
import { statModifierUpEffect } from './effects';
import { CANNOT_MOVE, E, M, pct, S1, S2, S3 } from './state';
import { itemData } from '../game/pokemon';

/** SelectEnemyMove */
export function selectEnemyMove(b: Battle): void {
  const en = b.enemy;
  const p = b.player;
  if (en.s2 & (S2.NEEDS_TO_RECHARGE | S2.USING_RAGE)) return;
  if (en.s1 & (S1.CHARGING_UP | S1.THRASHING_ABOUT)) return;
  if (en.mon.status & (c('battle', 'SLP_MASK') | (1 << c('battle', 'FRZ')))) return;
  if (en.s1 & (S1.USING_TRAPPING_MOVE | S1.STORING_ENERGY)) return;
  if (p.s1 & S1.USING_TRAPPING_MOVE) {
    en.selectedMove = CANNOT_MOVE;
    return;
  }
  let moves = en.mon.moves;
  if (!moves[1] && en.disabledMove) {
    en.selectedMove = M.STRUGGLE;
    return;
  }
  if (b.isInBattle !== WILD_BATTLE) moves = aiEnemyTrainerChooseMoves(b);
  const disabledSlot = (en.disabledMove >> 4) & 0xf;
  for (;;) {
    const r = b.random();
    let slot: number;
    if (r < pct(25)) slot = 1;
    else if (r < pct(50)) slot = 2;
    else if (r < pct(75) - 1) slot = 3;
    else slot = 4;
    en.moveListIndex = slot - 1;
    const move = moves[slot - 1];
    if (disabledSlot === slot) continue;
    if (!move) continue;
    en.selectedMove = move;
    return;
  }
}

/** AIEnemyTrainerChooseMoves: returns the filtered move list (wBuffer). */
function aiEnemyTrainerChooseMoves(b: Battle): number[] {
  const en = b.enemy;
  const buf = [10, 10, 10, 10];
  const disabled = (en.disabledMove >> 4) & 0xf;
  if (disabled) buf[disabled - 1] = 0x50;
  const mods = b.bundle.trainers[b.trainerClass - 1].aiMoveChoiceModifications;
  if (!mods.length) return en.mon.moves;
  for (const m of mods) {
    if (m === 1) aiMod1(b, buf);
    else if (m === 2) aiMod2(b, buf);
    else if (m === 3) aiMod3(b, buf);
    // 4: unused, does nothing
  }
  // .loopFindMinimumEntries: decrement every existing move's entry until one reaches 0
  const moves = en.mon.moves;
  outer: for (;;) {
    for (let i = 0; i < 4; i++) {
      if (!moves[i]) continue outer;
      buf[i] = (buf[i] - 1) & 0xff;
      if (!buf[i]) {
        // .minimumEntriesFound: undo the partial iteration
        for (let j = i; j >= 0; j--) buf[j] = (buf[j] + 1) & 0xff;
        break outer;
      }
    }
  }
  return moves.map((mv, i) => {
    if (!mv) buf[i] = 0;
    return buf[i] - 1 === 0 ? mv : 0;
  });
}

/** ReadMove: load a move into the enemy's move struct (clobbers wEnemyMoveNum..). */
function readMove(b: Battle, move: number): void {
  const m = b.bundle.moves[move - 1];
  b.enemy.move = { num: m.id, effect: m.effect, power: m.power, type: m.type, accuracy: m.accuracy, maxPP: m.pp };
}

/** AIMoveChoiceModification1: heavily discourage status moves if the player already has a status. */
function aiMod1(b: Battle, buf: number[]): void {
  if (!b.player.mon.status) return;
  const statusEffects = [E.EFFECT_01, E.SLEEP_EFFECT, E.POISON_EFFECT, E.PARALYZE_EFFECT];
  const moves = b.enemy.mon.moves;
  for (let i = 0; i < 4; i++) {
    if (!moves[i]) return;
    readMove(b, moves[i]);
    if (b.enemy.move.power) continue;
    if (!statusEffects.includes(b.enemy.move.effect)) continue;
    buf[i] = (buf[i] + 5) & 0xff;
  }
}

/** AIMoveChoiceModification2: on the turn after a switch-in, slightly prefer stat-modifying moves. */
function aiMod2(b: Battle, buf: number[]): void {
  if (b.aiLayer2Encouragement !== 1) return;
  const moves = b.enemy.mon.moves;
  for (let i = 0; i < 4; i++) {
    if (!moves[i]) return;
    readMove(b, moves[i]);
    const eff = b.enemy.move.effect;
    if ((eff >= E.ATTACK_UP1_EFFECT && eff < E.BIDE_EFFECT) || (eff >= E.ATTACK_UP2_EFFECT && eff < E.POISON_EFFECT))
      buf[i] = (buf[i] - 1) & 0xff;
  }
}

/** AIMoveChoiceModification3: prefer super-effective moves, avoid ineffective ones if better exist. */
function aiMod3(b: Battle, buf: number[]): void {
  const moves = b.enemy.mon.moves;
  for (let i = 0; i < 4; i++) {
    if (!moves[i]) return;
    readMove(b, moves[i]);
    const eff = aiGetTypeEffectiveness(b);
    if (eff === 0x10) continue;
    if (eff > 0x10) {
      buf[i] = (buf[i] - 1) & 0xff;
      continue;
    }
    // .notEffectiveMove
    const type = b.enemy.move.type;
    let better = false;
    for (let j = 0; j < 4; j++) {
      if (!moves[j]) break;
      readMove(b, moves[j]);
      const e2 = b.enemy.move.effect;
      if (e2 === E.SUPER_FANG_EFFECT || e2 === E.SPECIAL_DAMAGE_EFFECT || e2 === E.FLY_EFFECT) {
        better = true;
        break;
      }
      if (b.enemy.move.type === type) continue;
      if (b.enemy.move.power) {
        better = true;
        break;
      }
    }
    if (better) buf[i] = (buf[i] + 1) & 0xff;
  }
}

// ------------------------------------------------------------------ TrainerAI
/** TrainerAI: returns true (carry) if the trainer used its turn on an action. */
export function* trainerAI(b: Battle): Co<boolean> {
  if (b.isInBattle === WILD_BATTLE) return false;
  const en = b.enemy;
  if (en.s1 & (S1.CHARGING_UP | S1.THRASHING_ABOUT | S1.STORING_ENERGY)) return false;
  if (en.s2 & S2.USING_RAGE) return false;
  const entry = b.bundle.battle.trainerAI[b.trainerClass - 1];
  if (!b.aiCount) return false;
  if (b.aiCount === 0xff) b.aiCount = entry.count;
  const r = b.random();
  const routine = ROUTINES[entry.routine];
  if (!routine) throw new Error(`trainer AI routine ${entry.routine} not ported`);
  return yield* routine(b, r);
}

type Routine = (b: Battle, r: number) => Co<boolean>;

const p25 = pct(25) + 1;
const p50 = pct(50) + 1;
const p13 = pct(13) - 1;

const ROUTINES: Record<string, Routine> = {
  *GenericAI() {
    return false;
  },
  *JugglerAI(b, r) {
    if (r >= p25) return false;
    return yield* aiSwitchIfEnoughMons(b);
  },
  *BlackbeltAI(b, r) {
    if (r >= p13) return false;
    return yield* aiIncreaseStat(b, 'X_ATTACK', E.ATTACK_UP1_EFFECT);
  },
  *GiovanniAI(b, r) {
    if (r >= p25) return false;
    return yield* aiUseGuardSpec(b);
  },
  *CooltrainerMAI(b, r) {
    if (r >= p25) return false;
    return yield* aiIncreaseStat(b, 'X_ATTACK', E.ATTACK_UP1_EFFECT);
  },
  *CooltrainerFAI(b) {
    // the 25% check's result is discarded
    if (aiHPBelowFraction(b, 10)) return yield* aiRecoverHP(b, 'HYPER_POTION', 200);
    if (!aiHPBelowFraction(b, 5)) return false;
    return yield* aiSwitchIfEnoughMons(b);
  },
  *BrockAI(b) {
    if (!b.enemy.mon.status) return false;
    return yield* aiUseFullHeal(b);
  },
  *MistyAI(b, r) {
    if (r >= p25) return false;
    return yield* aiIncreaseStat(b, 'X_DEFEND', E.DEFENSE_UP1_EFFECT);
  },
  *LtSurgeAI(b, r) {
    if (r >= p25) return false;
    return yield* aiIncreaseStat(b, 'X_SPEED', E.SPEED_UP1_EFFECT);
  },
  *ErikaAI(b, r) {
    if (r >= p50) return false;
    if (!aiHPBelowFraction(b, 10)) return false;
    return yield* aiRecoverHP(b, 'SUPER_POTION', 50);
  },
  *KogaAI(b, r) {
    if (r >= p13) return false;
    return yield* aiIncreaseStat(b, 'X_ATTACK', E.ATTACK_UP1_EFFECT);
  },
  *BlaineAI(b, r) {
    if (r >= p25) return false;
    if (!aiHPBelowFraction(b, 10)) return false;
    return yield* aiRecoverHP(b, 'SUPER_POTION', 50);
  },
  *SabrinaAI(b, r) {
    if (r >= p25) return false;
    return yield* aiIncreaseStat(b, 'X_DEFEND', E.DEFENSE_UP1_EFFECT);
  },
  *Rival2AI(b, r) {
    if (r >= p13) return false;
    if (!aiHPBelowFraction(b, 5)) return false;
    return yield* aiRecoverHP(b, 'POTION', 20);
  },
  *Rival3AI(b, r) {
    if (r >= p13) return false;
    if (!aiHPBelowFraction(b, 5)) return false;
    return yield* aiUseFullRestore(b);
  },
  *LoreleiAI(b, r) {
    if (r >= p50) return false;
    if (!aiHPBelowFraction(b, 5)) return false;
    return yield* aiRecoverHP(b, 'SUPER_POTION', 50);
  },
  *BrunoAI(b, r) {
    if (r >= p25) return false;
    return yield* aiIncreaseStat(b, 'X_DEFEND', E.DEFENSE_UP1_EFFECT);
  },
  *AgathaAI(b, r) {
    if (r < pct(8)) return yield* aiSwitchIfEnoughMons(b);
    if (r >= p50) return false;
    if (!aiHPBelowFraction(b, 4)) return false;
    return yield* aiRecoverHP(b, 'SUPER_POTION', 50);
  },
  *LanceAI(b, r) {
    if (r >= p50) return false;
    if (!aiHPBelowFraction(b, 5)) return false;
    return yield* aiRecoverHP(b, 'HYPER_POTION', 200);
  },
};

/** AICheckIfHPBelowFraction: HP < maxHP / n (16-bit compare). */
function aiHPBelowFraction(b: Battle, n: number): boolean {
  return b.enemy.mon.hp < Math.floor(b.enemy.mon.maxHp / n);
}

function decrementAICount(b: Battle): boolean {
  b.aiCount = (b.aiCount - 1) & 0xff;
  return true;
}

/** AIPrintItemUse_ */
function* aiPrintItemUse(b: Battle, item: string): Co {
  b.aiItem = c('item', item);
  b.setMem('wNameBuffer', itemData(b.bundle, b.aiItem).name);
  yield* b.print('_AIBattleUseItemText');
}

/** AIRecoverHP (Potion 20, Super Potion 50, Hyper Potion 200) */
function* aiRecoverHP(b: Battle, item: string, amount: number): Co<boolean> {
  const m = b.enemy.mon;
  const old = m.hp;
  m.hp = Math.min(m.maxHp, (m.hp + amount) & 0xffff);
  yield* aiPrintItemUse(b, item);
  yield* b.updateHPBar(1, old);
  return decrementAICount(b);
}

/** AIUseFullRestore */
function* aiUseFullRestore(b: Battle): Co<boolean> {
  aiCureStatus(b);
  const m = b.enemy.mon;
  const old = m.hp;
  m.hp = m.maxHp;
  yield* aiPrintItemUse(b, 'FULL_RESTORE');
  yield* b.updateHPBar(1, old);
  return decrementAICount(b);
}

function aiCureStatus(b: Battle): void {
  const pm = b.enemyParty[b.enemyMonPartyPos];
  if (pm) pm.status = 0;
  b.enemy.mon.status = 0;
  b.enemy.s3 &= ~S3.BADLY_POISONED;
}

/** AIUseFullHeal */
function* aiUseFullHeal(b: Battle): Co<boolean> {
  b.sound('SFX_HEAL_AILMENT');
  aiCureStatus(b);
  yield* aiPrintItemUse(b, 'FULL_HEAL');
  return decrementAICount(b);
}

/** AIUseGuardSpec */
function* aiUseGuardSpec(b: Battle): Co<boolean> {
  b.sound('SFX_HEAL_AILMENT');
  b.enemy.s2 |= S2.PROTECTED_BY_MIST;
  yield* aiPrintItemUse(b, 'GUARD_SPEC');
  return decrementAICount(b);
}

/** AIIncreaseStat: runs StatModifierUpEffect with a fake move. */
function* aiIncreaseStat(b: Battle, item: string, effect: number): Co<boolean> {
  yield* aiPrintItemUse(b, item);
  const mv = b.enemy.move;
  const savedEffect = mv.effect;
  const savedNum = mv.num;
  mv.num = c('move', 'XSTATITEM_DUPLICATE_ANIM');
  mv.effect = effect;
  yield* statModifierUpEffect(b);
  mv.effect = savedEffect;
  mv.num = savedNum;
  return decrementAICount(b);
}

/** AISwitchIfEnoughMons */
function* aiSwitchIfEnoughMons(b: Battle): Co<boolean> {
  const alive = b.enemyParty.filter((m) => m.hp).length;
  if (alive < 2) return false;
  return yield* switchEnemyMon(b);
}

/** SwitchEnemyMon */
function* switchEnemyMon(b: Battle): Co<boolean> {
  const pm = b.enemyParty[b.enemyMonPartyPos];
  if (pm) {
    pm.hp = b.enemy.mon.hp;
    pm.boxLevel = b.enemy.mon.partyPos;
    pm.status = b.enemy.mon.status;
  }
  yield* b.print('_AIBattleWithdrawText');
  b.firstMonsNotOutYet = 1;
  yield* b.enemySendOut();
  b.firstMonsNotOutYet = 0;
  return true;
}
