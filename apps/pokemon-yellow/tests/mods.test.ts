import { describe, expect, it } from 'vitest';
import type { GameBundle } from '../src/data/schema';
import { activeModNames, applyMods, formatSeed, parseSeed, randomSpeciesMap, validMods } from '../src/game/mods';
import { checksum, deserializeSave, serializeSave } from '../src/game/save';
import { newGameState } from '../src/game/state';
import { typeMultiplier } from '../src/battle/menus';

// A synthetic bundle: 151 species (internal id = dex + 100, a glitch id 0) with rising stats.
function bundle(): GameBundle {
  const species: Record<number, unknown> = { 0: { dex: 0, baseStats: { hp: 1, atk: 1, def: 1, spd: 1, spc: 1 } } };
  for (let dex = 1; dex <= 151; dex++) {
    const v = 20 + ((dex * 37) % 120);
    species[dex + 100] = { dex, baseStats: { hp: v, atk: v, def: v, spd: v, spc: v } };
  }
  const slots = [101, 116, 119, 125].map((species, i) => ({ species, level: 3 + i }));
  return {
    toggleableObjects: [],
    species,
    wild: {
      grass: { 12: { rate: 25, slots } }, water: {}, slotChances: [],
      oldRod: { species: 229, level: 5 }, goodRod: [{ species: 218, level: 10 }], superRod: { 1: [{ species: 160, level: 15 }] },
    },
    trainers: [{ id: 1, constName: 'YOUNGSTER', name: 'YOUNGSTER', baseMoney: 15, picLabel: '', aiMoveChoiceModifications: [], parties: [{ mons: [{ species: 119, level: 11 }] }] }],
  } as unknown as GameBundle;
}

describe('randomizer', () => {
  it('is a deterministic permutation of the 151 species within strength tiers', () => {
    const b = bundle();
    const map = randomSpeciesMap(b, 1234);
    expect(map.size).toBe(151);
    expect(new Set(map.values()).size).toBe(151);
    expect(map.has(100)).toBe(false); // glitch ids untouched
    expect([...randomSpeciesMap(b, 1234)]).toEqual([...map]);
    expect([...randomSpeciesMap(b, 99)]).not.toEqual([...map]);
    const bst = (id: number) => (b.species[id].baseStats.hp) * 5;
    for (const [from, to] of map) expect(Math.abs(bst(from) - bst(to))).toBeLessThanOrEqual(5 * 30);
    expect([...map].filter(([a, z]) => a !== z).length).toBeGreaterThan(100);
  });

  it('swaps wild, fishing and trainer species without touching the base bundle', () => {
    const b = bundle();
    const before = structuredClone({ wild: b.wild, trainers: b.trainers });
    const m = applyMods(b, { randomizer: { seed: 7 } });
    const map = randomSpeciesMap(b, 7);
    expect(m.wild.grass[12].slots.map((s) => s.species)).toEqual(b.wild.grass[12].slots.map((s) => map.get(s.species)));
    expect(m.wild.grass[12].slots.map((s) => s.level)).toEqual([3, 4, 5, 6]);
    expect(m.wild.oldRod.species).toBe(map.get(229));
    expect(m.wild.superRod[1][0].species).toBe(map.get(160));
    expect(m.trainers[0].parties[0].mons[0]).toEqual({ species: map.get(119), level: 11 });
    expect({ wild: b.wild, trainers: b.trainers }).toEqual(before);
    expect(m.species).toBe(b.species);
  });

  it('returns the ROM bundle itself without a randomizer', () => {
    const b = bundle();
    expect(applyMods(b, undefined)).toBe(b);
    expect(applyMods(b, { comfort: true })).toBe(b);
  });

  it('round-trips seeds through their short text form', () => {
    for (const seed of [0, 1, 1234, 0xffffffff]) expect(parseSeed(formatSeed(seed))).toBe(seed);
    expect(parseSeed('pika')).toBe(parseInt('pika', 36));
    expect(parseSeed('')).toBeUndefined();
    expect(parseSeed('no-way')).toBeUndefined();
    expect(parseSeed('zzzzzzz')).toBeUndefined(); // above 32 bits
  });
});

describe('mods in saves', () => {
  const state = () => newGameState({ toggleableObjects: [] } as unknown as GameBundle);
  const resave = (mods: unknown) => {
    const file = JSON.parse(serializeSave(state()));
    file.state.mods = mods;
    file.checksum = checksum(JSON.stringify(file.state));
    return JSON.stringify(file);
  };

  it('keeps chosen mods through a save', () => {
    const s = state();
    s.mods = { comfort: true, randomizer: { seed: 42 } };
    expect(deserializeSave(serializeSave(s)).state.mods).toEqual(s.mods);
    expect(deserializeSave(serializeSave(state())).state.mods).toBeUndefined();
  });

  it.each([null, [], 'comfort', { comfort: 1 }, { randomizer: {} }, { randomizer: { seed: -1 } }, { randomizer: { seed: 2 ** 33 } }, { cheats: true }])('rejects malformed mods %j', (mods) => {
    expect(validMods(mods)).toBe(false);
    expect(() => deserializeSave(resave(mods))).toThrow('malformed');
  });

  it('names active mods for the settings panel', () => {
    expect(activeModNames(undefined)).toEqual([]);
    expect(activeModNames({ comfort: true, randomizer: { seed: 35 } })).toEqual(['Comfort', 'Randomizer #000Z']);
  });
});

describe('comfort type hints', () => {
  const chart: [number, number, number][] = [[20, 22, 5], [20, 21, 20], [23, 4, 0], [20, 25, 20]];
  it('multiplies every matching chart entry, like the damage routine', () => {
    expect(typeMultiplier(chart, 20, [21, 21])).toBe(2);
    expect(typeMultiplier(chart, 20, [21, 25])).toBe(4);
    expect(typeMultiplier(chart, 20, [21, 22])).toBe(1);
    expect(typeMultiplier(chart, 20, [22, 22])).toBe(0.5);
    expect(typeMultiplier(chart, 23, [4, 0])).toBe(0);
    expect(typeMultiplier(chart, 0, [21, 22])).toBe(1);
  });
});
