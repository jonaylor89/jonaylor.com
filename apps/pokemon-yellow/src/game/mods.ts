/**
 * Optional game mods, chosen when a new game starts and kept in its save.
 * The unmodded game stays the default; DEVIATIONS.md lists what each changes.
 *
 * - Comfort: modern conveniences (party Exp. Share, HM field moves without
 *   teaching them, hold B to run, type-effectiveness hints). It only changes
 *   behavior from then on, so it can be switched mid-run in WEB SETTINGS.
 * - Randomizer: a seeded species swap for wild Pokémon and trainer parties.
 *   Species only trade places with others of similar base stat total, so
 *   early routes stay early-game. Gifts, static encounters, trades and the
 *   starter Pikachu are unchanged. Locked at New Game: changing it mid-run
 *   would swap the species of trainers and routes not yet reached.
 */
import type { GameBundle, TrainerClassData, WildData, WildTable } from '../data/schema';

export interface GameMods {
  comfort?: boolean;
  randomizer?: { seed: number };
}

export const MOD_INFO = [
  {
    id: 'comfort',
    name: 'Comfort',
    summary: 'Modern conveniences, same adventure. Switch it any time in WEB SETTINGS.',
    details: [
      'Exp. Share: the whole party learns from every win (half for those who sat out)',
      'Field moves without HMs: a Pokémon that can learn the HM you carry can use it',
      'Hold B to run',
      'Move menu shows how effective each move is',
    ],
  },
  {
    id: 'randomizer',
    name: 'Randomizer',
    summary: 'Every wild Pokémon and trainer team reshuffled. Locked for this save.',
    details: [
      'Seeded: share the seed to play the same Kanto',
      'Swaps stay within a similar strength tier',
      'Gifts, trades, legendaries in place and Pikachu are unchanged',
    ],
  },
] as const;

/** Structural check for saves (also used by the cloud/guest save validators). */
export function validMods(v: unknown): v is GameMods {
  if (v === undefined) return true;
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const m = v as Record<string, unknown>;
  if (Object.keys(m).some((k) => k !== 'comfort' && k !== 'randomizer')) return false;
  if (m.comfort !== undefined && typeof m.comfort !== 'boolean') return false;
  if (m.randomizer !== undefined) {
    const r = m.randomizer as Record<string, unknown> | null;
    if (!r || typeof r !== 'object' || !Number.isSafeInteger(r.seed) || (r.seed as number) < 0 || (r.seed as number) > 0xffffffff) return false;
  }
  return true;
}

/** The save's mods with Comfort switched; no mods at all is stored as none (the original game). */
export function withComfort(mods: GameMods | undefined, on: boolean): GameMods | undefined {
  const next: GameMods = { ...mods };
  if (on) next.comfort = true;
  else delete next.comfort;
  return next.comfort || next.randomizer ? next : undefined;
}

export function activeModNames(mods: GameMods | undefined): string[] {
  const names: string[] = [];
  if (mods?.comfort) names.push('Comfort');
  if (mods?.randomizer) names.push(`Randomizer #${formatSeed(mods.randomizer.seed)}`);
  return names;
}

export const formatSeed = (seed: number) => (seed >>> 0).toString(36).toUpperCase().padStart(4, '0');
export function parseSeed(text: string): number | undefined {
  const t = text.trim();
  if (!/^[0-9a-z]{1,7}$/i.test(t)) return undefined;
  const n = parseInt(t, 36);
  return n <= 0xffffffff ? n : undefined;
}

/** mulberry32: small, fast, and independent of the game's own RNG state. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TIER_SIZE = 16;

/** Internal species id -> replacement, a permutation within base-stat-total tiers. */
export function randomSpeciesMap(bundle: GameBundle, seed: number): Map<number, number> {
  const bst = (id: number) => {
    const s = bundle.species[id].baseStats;
    return s.hp + s.atk + s.def + s.spd + s.spc;
  };
  // One internal id per Pokédex number (1-151); glitch ids have no dex entry.
  const byDex = new Map<number, number>();
  for (const [key, sp] of Object.entries(bundle.species)) {
    const id = Number(key);
    if (sp.dex >= 1 && sp.dex <= 151 && !byDex.has(sp.dex)) byDex.set(sp.dex, id);
  }
  const ids = [...byDex.entries()].sort((a, b) => bst(a[1]) - bst(b[1]) || a[0] - b[0]).map(([, id]) => id);
  const rand = prng(seed);
  const map = new Map<number, number>();
  for (let start = 0; start < ids.length; start += TIER_SIZE) {
    // A short last tier joins the previous one so it still shuffles.
    const end = ids.length - (start + TIER_SIZE) < TIER_SIZE / 2 ? ids.length : start + TIER_SIZE;
    const tier = ids.slice(start, end);
    const shuffled = [...tier];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    tier.forEach((id, i) => map.set(id, shuffled[i]));
    if (end === ids.length) break;
  }
  return map;
}

function randomizeWild(wild: WildData, swap: (id: number) => number): WildData {
  const table = (t: WildTable): WildTable => ({ ...t, slots: t.slots.map((m) => ({ ...m, species: swap(m.species) })) });
  const tables = (r: Record<number, WildTable>) => Object.fromEntries(Object.entries(r).map(([k, t]) => [k, table(t)]));
  return {
    ...wild,
    grass: tables(wild.grass),
    water: tables(wild.water),
    oldRod: { ...wild.oldRod, species: swap(wild.oldRod.species) },
    goodRod: wild.goodRod.map((m) => ({ ...m, species: swap(m.species) })),
    superRod: Object.fromEntries(Object.entries(wild.superRod).map(([k, ms]) => [k, ms.map((m) => ({ ...m, species: swap(m.species) }))])),
  };
}

function randomizeTrainers(trainers: TrainerClassData[], swap: (id: number) => number): TrainerClassData[] {
  return trainers.map((t) => ({ ...t, parties: t.parties.map((p) => ({ ...p, mons: p.mons.map((m) => ({ ...m, species: swap(m.species) })) })) }));
}

/** The bundle the engine plays with: the ROM data, or a modded copy (the base is never mutated). */
export function applyMods(base: GameBundle, mods: GameMods | undefined): GameBundle {
  if (!mods?.randomizer) return base;
  const map = randomSpeciesMap(base, mods.randomizer.seed);
  const swap = (id: number) => map.get(id) ?? id;
  return { ...base, wild: randomizeWild(base.wild, swap), trainers: randomizeTrainers(base.trainers, swap) };
}
