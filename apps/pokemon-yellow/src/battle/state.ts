/**
 * Battle-time data structures mirroring the WRAM battle variables
 * (wBattleMon / wEnemyMon, the wPlayer- and wEnemy- status bytes, stat mods, move
 * structs) and small helpers shared by the battle modules.
 */
import { c } from '../rom/constants';

/** wBattleMon / wEnemyMon (battle_struct). */
export interface BattleMon {
  species: number;
  hp: number;
  /** Party position / box level byte. */
  partyPos: number;
  status: number;
  types: [number, number];
  catchRate: number;
  moves: number[];
  /** DV word (ATKDEF << 8 | SPDSPC). */
  dvs: number;
  level: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  spc: number;
  pp: number[];
  nick: string;
}

/** wPlayerMoveNum.. / wEnemyMoveNum.. (move_struct). */
export interface MoveStruct {
  num: number;
  effect: number;
  power: number;
  type: number;
  accuracy: number;
  maxPP: number;
}

export interface UnmodifiedStats {
  level: number;
  maxHp: number;
  atk: number;
  def: number;
  spd: number;
  spc: number;
}

/** All per-side battle variables. */
export interface Side {
  mon: BattleMon;
  unmod: UnmodifiedStats;
  /** wPlayerMonStatMods: attack, defense, speed, special, accuracy, evasion (7 = neutral, 1..13). */
  mods: number[];
  /** wPlayerBattleStatus1/2/3 */
  s1: number;
  s2: number;
  s3: number;
  selectedMove: number;
  moveListIndex: number;
  move: MoveStruct;
  usedMove: number;
  numAttacksLeft: number;
  /** wPlayerNumHits (shares its byte with the high byte of the Bide accumulator in RAM). */
  numHits: number;
  bideDamage: number;
  confusedCounter: number;
  toxicCounter: number;
  /** High nybble = move slot (1-4), low nybble = turns left. */
  disabledMove: number;
  disabledMoveNumber: number;
  substituteHP: number;
  minimized: number;
}

export const STAT_NAMES = ['ATTACK', 'DEFENSE', 'SPEED', 'SPECIAL', 'ACCURACY', 'EVADE'];

/** `n percent` from the disassembly macros: n * $ff / 100. */
export const pct = (n: number) => Math.floor((n * 0xff) / 100);

/** Bit masks for the battle status bytes and mon status. */
const bit = (name: string) => 1 << c('battle', name);
export const S1 = {
  STORING_ENERGY: bit('STORING_ENERGY'),
  THRASHING_ABOUT: bit('THRASHING_ABOUT'),
  ATTACKING_MULTIPLE_TIMES: bit('ATTACKING_MULTIPLE_TIMES'),
  FLINCHED: bit('FLINCHED'),
  CHARGING_UP: bit('CHARGING_UP'),
  USING_TRAPPING_MOVE: bit('USING_TRAPPING_MOVE'),
  INVULNERABLE: bit('INVULNERABLE'),
  CONFUSED: bit('CONFUSED'),
};
export const S2 = {
  USING_X_ACCURACY: bit('USING_X_ACCURACY'),
  PROTECTED_BY_MIST: bit('PROTECTED_BY_MIST'),
  GETTING_PUMPED: bit('GETTING_PUMPED'),
  HAS_SUBSTITUTE_UP: bit('HAS_SUBSTITUTE_UP'),
  NEEDS_TO_RECHARGE: bit('NEEDS_TO_RECHARGE'),
  USING_RAGE: bit('USING_RAGE'),
  SEEDED: bit('SEEDED'),
};
export const S3 = {
  BADLY_POISONED: bit('BADLY_POISONED'),
  HAS_LIGHT_SCREEN_UP: bit('HAS_LIGHT_SCREEN_UP'),
  HAS_REFLECT_UP: bit('HAS_REFLECT_UP'),
  TRANSFORMED: bit('TRANSFORMED'),
};
export const ST = {
  SLP_MASK: c('battle', 'SLP_MASK'),
  PSN: bit('PSN'),
  BRN: bit('BRN'),
  FRZ: bit('FRZ'),
  PAR: bit('PAR'),
};

export const PP_MASK = 0x3f;
export const CANNOT_MOVE = 0xff;
export const MAX_STAT_VALUE = 999;
export const EFFECTIVE = 10;

/** Move effect constants by name. */
export const E = new Proxy({} as Record<string, number>, {
  get: (_t, name: string) => c('move_effect', name),
});
/** Move ids by name. */
export const M = new Proxy({} as Record<string, number>, {
  get: (_t, name: string) => c('move', name),
});
/** Type ids by name. */
export const T = new Proxy({} as Record<string, number>, {
  get: (_t, name: string) => c('type', name),
});

export function emptyMove(): MoveStruct {
  return { num: 0, effect: 0, power: 0, type: 0, accuracy: 0, maxPP: 0 };
}

export function emptyMon(): BattleMon {
  return {
    species: 0, hp: 0, partyPos: 0, status: 0, types: [0, 0], catchRate: 0, moves: [0, 0, 0, 0], dvs: 0,
    level: 0, maxHp: 0, atk: 0, def: 0, spd: 0, spc: 0, pp: [0, 0, 0, 0], nick: '',
  };
}

export function newSide(): Side {
  return {
    mon: emptyMon(),
    unmod: { level: 0, maxHp: 0, atk: 0, def: 0, spd: 0, spc: 0 },
    mods: [7, 7, 7, 7, 7, 7],
    s1: 0, s2: 0, s3: 0,
    selectedMove: 0, moveListIndex: 0, move: emptyMove(), usedMove: 0,
    numAttacksLeft: 0, numHits: 0, bideDamage: 0, confusedCounter: 0, toxicCounter: 0,
    disabledMove: 0, disabledMoveNumber: 0, substituteHP: 0, minimized: 0,
  };
}

/** The four modifiable stats in stat-mod order. */
export const MOD_STATS = ['atk', 'def', 'spd', 'spc'] as const;
export type ModStat = (typeof MOD_STATS)[number];
