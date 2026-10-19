/**
 * Pokémon creation and stat math: ports of CalcStat (home/move_mon.asm),
 * CalcExperience (engine/pokemon/experience.asm), WriteMonMoves
 * (engine/pokemon/evos_moves.asm) and _AddPartyMon (engine/pokemon/add_mon.asm).
 */
import type { GameBundle, SpeciesData } from '../data/schema';
import type { PartyMon } from './state';
import { c } from '../rom/constants';

export interface StatExp {
  hp: number;
  atk: number;
  def: number;
  spd: number;
  spc: number;
}

export const ZERO_STAT_EXP: StatExp = { hp: 0, atk: 0, def: 0, spd: 0, spc: 0 };

export function species(bundle: GameBundle, index: number): SpeciesData {
  const s = bundle.species[index];
  if (!s) throw new Error(`unknown species index ${index}`);
  return s;
}

/** DV nybbles from the 16-bit DV word (atk<<12 | def<<8 | spd<<4 | spc). */
export function dvs(word: number) {
  const atk = (word >> 12) & 0xf;
  const def = (word >> 8) & 0xf;
  const spd = (word >> 4) & 0xf;
  const spc = word & 0xf;
  const hp = ((atk & 1) << 3) | ((def & 1) << 2) | ((spd & 1) << 1) | (spc & 1);
  return { hp, atk, def, spd, spc };
}

/** ceil(sqrt(statExp)), computed iteratively and capped at 255 like CalcStat. */
export function statExpBonus(statExp: number): number {
  let b = 0;
  for (;;) {
    b++;
    if (b === 0xff) break;
    if (b * b >= statExp) break;
  }
  return b;
}

export type StatName = 'hp' | 'atk' | 'def' | 'spd' | 'spc';

export function calcStat(base: number, dv: number, statExp: number, level: number, stat: StatName, considerStatExp: boolean): number {
  const bonus = considerStatExp ? statExpBonus(statExp) : 0;
  let v = Math.floor((((base + dv) * 2 + (bonus >> 2)) * level) / 100);
  v += stat === 'hp' ? level + 10 : 5;
  return Math.min(v, c('battle', 'MAX_STAT_VALUE'));
}

export function calcStats(sp: SpeciesData, dvWord: number, statExp: StatExp, level: number, considerStatExp: boolean) {
  const d = dvs(dvWord);
  const b = sp.baseStats;
  return {
    maxHp: calcStat(b.hp, d.hp, statExp.hp, level, 'hp', considerStatExp),
    atk: calcStat(b.atk, d.atk, statExp.atk, level, 'atk', considerStatExp),
    def: calcStat(b.def, d.def, statExp.def, level, 'def', considerStatExp),
    spd: calcStat(b.spd, d.spd, statExp.spd, level, 'spd', considerStatExp),
    spc: calcStat(b.spc, d.spc, statExp.spc, level, 'spc', considerStatExp),
  };
}

/** CalcExperience: 24-bit result (so Medium Slow level 1 underflows, as in the original). */
export function calcExperience(bundle: GameBundle, growthRate: number, level: number): number {
  const g = bundle.growthRates[growthRate];
  if (!g) throw new Error(`unknown growth rate ${growthRate}`);
  const n = level;
  const cubic = Math.floor((n * n * n * g.a) / g.b);
  const v = cubic + g.c * n * n + g.d * n - g.e;
  return ((v % 0x1000000) + 0x1000000) % 0x1000000;
}

/** Level-1 moves then WriteMonMoves: learnset moves up to `level`, oldest dropped when full. */
export function initialMoves(sp: SpeciesData, level: number): [number, number, number, number] {
  const moves = [0, 0, 0, 0];
  sp.level1Moves.forEach((m, i) => (moves[i] = m));
  for (const { level: lv, move } of sp.learnset) {
    if (level < lv) break;
    if (moves.includes(move)) continue;
    const empty = moves.indexOf(0);
    if (empty >= 0) moves[empty] = move;
    else {
      moves.shift();
      moves.push(move);
    }
  }
  return moves as [number, number, number, number];
}

export function movePP(bundle: GameBundle, move: number): number {
  return move ? (bundle.moves[move - 1]?.pp ?? 0) : 0;
}

export interface NewMonOptions {
  species: number;
  level: number;
  /** DV word; player-party mons roll two Random calls (see AddPartyMon). */
  dvs: number;
  otId: number;
  otName: string;
  nickname?: string;
}

/** Build a party mon struct exactly as _AddPartyMon would for a non-wild mon. */
export function makePartyMon(bundle: GameBundle, o: NewMonOptions): PartyMon {
  const sp = species(bundle, o.species);
  const moves = initialMoves(sp, o.level);
  const stats = calcStats(sp, o.dvs, ZERO_STAT_EXP, o.level, false);
  let catchRate = sp.catchRate;
  if (o.species === c('pokemon', 'KADABRA')) catchRate = c('item', 'TWISTEDSPOON_GSC');
  return {
    species: o.species,
    hp: stats.maxHp,
    boxLevel: 0,
    status: 0,
    types: [...sp.types] as [number, number],
    catchRate,
    moves,
    otId: o.otId,
    exp: calcExperience(bundle, sp.growthRate, o.level),
    statExp: { ...ZERO_STAT_EXP },
    dvs: o.dvs,
    pp: moves.map((m) => movePP(bundle, m)) as [number, number, number, number],
    level: o.level,
    ...stats,
    nickname: o.nickname ?? sp.name,
    otName: o.otName,
  };
}

/** HealParty (engine/events/heal_party.asm): full HP, no status, PP restored keeping PP Ups. */
export function healMon(bundle: GameBundle, m: PartyMon): void {
  m.hp = m.maxHp;
  m.status = 0;
  m.pp = m.moves.map((mv, i) => {
    if (!mv) return 0;
    const ups = m.pp[i] >> 6;
    const base = movePP(bundle, mv);
    // RestoreBonusPP / AddBonusPP: each PP Up adds min(base / 5, 7).
    return (ups << 6) | (base + Math.min(Math.floor(base / 5), 7) * ups);
  }) as [number, number, number, number];
}

/** Item data by id (regular items, HMs and TMs). */
export function itemData(bundle: GameBundle, id: number) {
  const it = bundle.items.find((i) => i.id === id);
  if (!it) throw new Error(`unknown item ${id}`);
  return it;
}
