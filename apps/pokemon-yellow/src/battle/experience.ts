/**
 * GainExperience (engine/battle/experience.asm): stat experience, the exp
 * formula with the traded and trainer boosts, Exp. All sharing, level-ups
 * with the stats box, and the one-move-per-level-up learnset check.
 */
import type { Co } from '../engine/Engine';
import type { Battle } from './Battle';
import { c } from '../rom/constants';
import { calcExperience, calcStats } from '../game/pokemon';
import { learnMoveFromLevelUp } from '../game/evolution';
import { S3 } from './state';
import { applyBadgeStatBoosts, applyBurnAndParalysisPenalties, calculateModifiedStats } from './moves';
import { encodePlain } from '../ui/TextPrinter';

/** CalcLevelFromExperience */
export function calcLevelFromExperience(b: Battle['bundle'], growthRate: number, exp: number): number {
  let d = 1;
  for (;;) {
    d++;
    if (calcExperience(b, growthRate, d) > exp) return d - 1;
    if (d >= 0xff) return d;
  }
}

/** BoostExp: ×1.5 (16-bit) */
const boost = (q: number) => (q + (q >> 1)) & 0xffff;

export function* gainExperience(b: Battle): Co {
  // DivideExpDataByNumMonsGainingExp
  let n = 0;
  for (let i = 0; i < 8; i++) if ((b.partyGainExpFlags >> i) & 1) n++;
  if (n >= 2) {
    const bs = b.enemyBaseStats;
    for (const k of ['hp', 'atk', 'def', 'spd', 'spc'] as const) bs[k] = Math.floor(bs[k] / n);
    b.enemyBaseCatchRate = Math.floor(b.enemyBaseCatchRate / n);
    b.enemyBaseExp = Math.floor(b.enemyBaseExp / n);
  }
  const ownId = b.e.state.player.id;
  for (let i = 0; i < b.party.length; i++) {
    const pm = b.party[i];
    if (!pm.hp) continue;
    if (!((b.partyGainExpFlags >> i) & 1)) continue;
    b.whichPokemon = i;
    // stat exp += enemy base stats (each capped at $FFFF)
    const bs = b.enemyBaseStats;
    for (const k of ['hp', 'atk', 'def', 'spd', 'spc'] as const) pm.statExp[k] = Math.min(0xffff, pm.statExp[k] + bs[k]);
    let q = Math.floor((b.enemyBaseExp * b.enemy.mon.level) / 7) & 0xffff;
    b.gainBoostedExp = 0;
    if (pm.otId !== ownId) {
      q = boost(q);
      b.gainBoostedExp = 1;
    }
    if (b.isTrainerBattle()) q = boost(q);
    b.setMem('wExpAmountGained', q);
    const sp = b.header(pm.species);
    pm.exp = Math.min(0xffffff, pm.exp + q);
    const max = calcExperience(b.bundle, sp.growthRate, c('battle', 'MAX_LEVEL'));
    if (pm.exp >= max) pm.exp = max;
    b.setMem('wNameBuffer', pm.nickname);
    const labels = ['_GainedText'];
    if (b.boostExpByExpAll) labels.push('_WithExpAllText');
    else if (b.gainBoostedExp) labels.push('_BoostedText');
    labels.push('_ExpPointsText');
    // _ExpPointsText reads wExpAmountGained, which shares its address with wStringBuffer
    yield* b.print(...labels);
    const newLevel = calcLevelFromExperience(b.bundle, sp.growthRate, pm.exp);
    if (newLevel === pm.level) continue;
    const savedEnemyLevel = b.curEnemyLevel;
    b.curEnemyLevel = newLevel;
    pm.level = newLevel;
    const oldMax = pm.maxHp;
    const st = calcStats(sp, pm.dvs, pm.statExp, newLevel, true);
    Object.assign(pm, st);
    pm.hp = (pm.hp + (pm.maxHp - oldMax)) & 0xffff;
    if (i === b.playerMonNumber) {
      const m = b.player.mon;
      m.hp = pm.hp;
      m.level = pm.level;
      m.maxHp = pm.maxHp;
      m.atk = pm.atk;
      m.def = pm.def;
      m.spd = pm.spd;
      m.spc = pm.spc;
      if (!(b.player.s3 & S3.TRANSFORMED)) {
        b.player.unmod = { level: pm.level, maxHp: pm.maxHp, atk: pm.atk, def: pm.def, spd: pm.spd, spc: pm.spc };
      }
      calculateModifiedStats(b, 0);
      applyBurnAndParalysisPenalties(b, 1);
      applyBadgeStatBoosts(b);
      b.drawPlayerHUDAndHPBar();
      yield* b.printEmptyString();
      b.saveScreen1();
    }
    b.happiness('PIKAHAPPY_LEVELUP', pm);
    b.setMem('wNameBuffer', pm.nickname);
    yield* b.print('_GrewLevelText');
    b.sound('SFX_LEVEL_UP');
    printStatsBox(b, pm);
    yield* b.e.waitForTextScrollButtonPress();
    b.loadScreen1();
    yield* learnMoveFromLevelUp(b.e, b.party, i, newLevel, { battle: b, mem: b.mem });
    b.canEvolveFlags |= 1 << i;
    b.curEnemyLevel = savedEnemyLevel;
  }
  b.partyGainExpFlags = 1 << b.playerMonNumber;
  b.partyFoughtCurrentEnemyFlags = 1 << b.playerMonNumber;
}

/** PrintStatsBox with LEVEL_UP_STATS_BOX */
export function printStatsBox(b: { e: Battle['e'] }, pm: { atk: number; def: number; spd: number; spc: number }): void {
  const s = b.e.screen;
  s.box(9, 2, 8, 9);
  const labels = ['ATTACK', 'DEFENSE', 'SPEED', 'SPECIAL'];
  const vals = [pm.atk, pm.def, pm.spd, pm.spc];
  labels.forEach((l, i) => {
    encodePlain(l).forEach((code, j) => s.put(11 + j, 3 + i * 2, code));
    encodePlain(String(vals[i]).padStart(3, ' ')).forEach((code, j) => s.put(15 + j, 4 + i * 2, code));
  });
}
