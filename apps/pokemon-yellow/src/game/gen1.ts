/**
 * Gen 1 party/box structures in their WRAM/SRAM byte layouts (wPartyMon1,
 * box_struct / party_struct in macros/ram.asm), for trade-compatible export and
 * import: a single mon (33-byte box struct or 44-byte party struct), and whole
 * party (wPartyCount … wPartyMonNicksEnd, 404 bytes) and box (1122 bytes)
 * lists with their species lists, OT names and nicknames.
 */
import type { GameBundle } from '../data/schema';
import type { PartyMon } from './state';
import { calcStats, species as speciesData } from './pokemon';
import { encodePlain } from '../ui/TextPrinter';
import { charFor, TERMINATOR } from '../rom/text';

export const BOX_STRUCT_LENGTH = 33;
export const PARTY_STRUCT_LENGTH = 44;
export const NAME_LENGTH = 11;
export const PARTY_LENGTH = 6;
export const MONS_PER_BOX = 20;
export const PARTY_DATA_LENGTH = 1 + PARTY_LENGTH + 1 + PARTY_LENGTH * (PARTY_STRUCT_LENGTH + 2 * NAME_LENGTH);
export const BOX_DATA_LENGTH = 1 + MONS_PER_BOX + 1 + MONS_PER_BOX * (BOX_STRUCT_LENGTH + 2 * NAME_LENGTH);

const put16 = (b: Uint8Array, at: number, v: number) => {
  b[at] = (v >> 8) & 0xff;
  b[at + 1] = v & 0xff;
};
const get16 = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];

/** A mon as a box struct (33 bytes) or party struct (44 bytes) */
export function encodeMon(pm: PartyMon, party: boolean): Uint8Array {
  const b = new Uint8Array(party ? PARTY_STRUCT_LENGTH : BOX_STRUCT_LENGTH);
  b[0] = pm.species;
  put16(b, 1, pm.hp);
  // a boxed mon's level byte is its level (MoveMon copies wPartyMonLevel there)
  b[3] = party ? pm.boxLevel : pm.level;
  b[4] = pm.status;
  b[5] = pm.types[0];
  b[6] = pm.types[1];
  b[7] = pm.catchRate;
  pm.moves.forEach((m, i) => (b[8 + i] = m));
  put16(b, 12, pm.otId);
  b[14] = (pm.exp >> 16) & 0xff;
  b[15] = (pm.exp >> 8) & 0xff;
  b[16] = pm.exp & 0xff;
  const se = pm.statExp;
  [se.hp, se.atk, se.def, se.spd, se.spc].forEach((v, i) => put16(b, 17 + i * 2, v));
  put16(b, 27, pm.dvs);
  pm.pp.forEach((v, i) => (b[29 + i] = v));
  if (party) {
    b[33] = pm.level;
    [pm.maxHp, pm.atk, pm.def, pm.spd, pm.spc].forEach((v, i) => put16(b, 34 + i * 2, v));
  }
  return b;
}

/**
 * Read a box or party struct. A box struct's level is its box level byte and its
 * stats are recalculated with stat experience (as when withdrawn from a box).
 */
export function decodeMon(bundle: GameBundle, b: Uint8Array, nickname: string, otName: string): PartyMon {
  const party = b.length >= PARTY_STRUCT_LENGTH;
  const statExp = { hp: get16(b, 17), atk: get16(b, 19), def: get16(b, 21), spd: get16(b, 23), spc: get16(b, 25) };
  const pm: PartyMon = {
    species: b[0],
    hp: get16(b, 1),
    boxLevel: b[3],
    status: b[4],
    types: [b[5], b[6]],
    catchRate: b[7],
    moves: [b[8], b[9], b[10], b[11]],
    otId: get16(b, 12),
    exp: (b[14] << 16) | (b[15] << 8) | b[16],
    statExp,
    dvs: get16(b, 27),
    pp: [b[29], b[30], b[31], b[32]],
    level: party ? b[33] : b[3],
    maxHp: 0,
    atk: 0,
    def: 0,
    spd: 0,
    spc: 0,
    nickname,
    otName,
  };
  if (party) {
    [pm.maxHp, pm.atk, pm.def, pm.spd, pm.spc] = [34, 36, 38, 40, 42].map((at) => get16(b, at));
  } else {
    Object.assign(pm, calcStats(speciesData(bundle, pm.species), pm.dvs, statExp, pm.level, true));
  }
  return pm;
}

/** A name field: the string, then "@" padding to NAME_LENGTH */
export function encodeName(s: string): Uint8Array {
  const out = new Uint8Array(NAME_LENGTH).fill(TERMINATOR);
  encodePlain(s)
    .slice(0, NAME_LENGTH - 1)
    .forEach((c, i) => (out[i] = c));
  return out;
}

export function decodeName(b: Uint8Array): string {
  let s = '';
  for (const c of b) {
    if (c === TERMINATOR) break;
    s += charFor(c);
  }
  return s;
}

function encodeList(mons: PartyMon[], capacity: number, party: boolean): Uint8Array {
  if (mons.length > capacity) throw new Error(`too many mons (${mons.length} > ${capacity})`);
  const size = party ? PARTY_STRUCT_LENGTH : BOX_STRUCT_LENGTH;
  const out = new Uint8Array(1 + capacity + 1 + capacity * (size + 2 * NAME_LENGTH));
  out[0] = mons.length;
  mons.forEach((m, i) => (out[1 + i] = m.species));
  out[1 + mons.length] = 0xff;
  const structs = 2 + capacity;
  const ots = structs + capacity * size;
  const nicks = ots + capacity * NAME_LENGTH;
  mons.forEach((m, i) => {
    out.set(encodeMon(m, party), structs + i * size);
    out.set(encodeName(m.otName), ots + i * NAME_LENGTH);
    out.set(encodeName(m.nickname), nicks + i * NAME_LENGTH);
  });
  return out;
}

function decodeList(bundle: GameBundle, b: Uint8Array, capacity: number, party: boolean): PartyMon[] {
  const size = party ? PARTY_STRUCT_LENGTH : BOX_STRUCT_LENGTH;
  if (b.length < 2 + capacity * (size + 2 * NAME_LENGTH)) throw new Error('data too short');
  const n = b[0];
  if (n > capacity) throw new Error(`bad mon count ${n}`);
  const structs = 2 + capacity;
  const ots = structs + capacity * size;
  const nicks = ots + capacity * NAME_LENGTH;
  const out: PartyMon[] = [];
  for (let i = 0; i < n; i++) {
    const s = b.slice(structs + i * size, structs + (i + 1) * size);
    if (s[0] !== b[1 + i]) throw new Error(`species list mismatch at ${i}`);
    out.push(
      decodeMon(bundle, s, decodeName(b.slice(nicks + i * NAME_LENGTH, nicks + (i + 1) * NAME_LENGTH)), decodeName(b.slice(ots + i * NAME_LENGTH, ots + (i + 1) * NAME_LENGTH))),
    );
  }
  return out;
}

/** wPartyCount … wPartyMonNicksEnd */
export const encodeParty = (mons: PartyMon[]) => encodeList(mons, PARTY_LENGTH, true);
export const decodeParty = (bundle: GameBundle, b: Uint8Array) => decodeList(bundle, b, PARTY_LENGTH, true);
/** sBox / wBoxCount … wBoxMonNicksEnd */
export const encodeBox = (mons: PartyMon[]) => encodeList(mons, MONS_PER_BOX, false);
export const decodeBox = (bundle: GameBundle, b: Uint8Array) => decodeList(bundle, b, MONS_PER_BOX, false);
