/** Species, Pokédex, moves, items, types, wild encounters and trainers. */
import type { Rom } from '../Rom';
import { c, constEntries, nextLabelOffset, symBank, toOffset } from '../symbols';
import type {
  DexEntry,
  Evolution,
  ItemData,
  MoveData,
  SpeciesData,
  TrainerClassData,
  TypeData,
  WildData,
  WildTable,
} from '../../data/schema';
import { decodeFixed, decodeString, labelFor } from '../text';
import { assert, bcd } from './util';
import type { TextCollector } from './texts';

function names(group: string, prefix = ''): Map<number, string> {
  const m = new Map<number, string>();
  for (const [k, v] of constEntries(group, prefix)) if (!m.has(v)) m.set(v, k);
  return m;
}

/** Read `count` consecutive "@"-terminated strings. */
function stringList(rom: Rom, off: number, count: number): string[] {
  const out: string[] = [];
  let p = off;
  for (let i = 0; i < count; i++) {
    const s = decodeString(rom, p, 64);
    out.push(s);
    // advance past the terminator
    while (rom.u8(p) !== 0x50) p++;
    p++;
  }
  return out;
}

export function extractSpecies(rom: Rom): { species: Record<number, SpeciesData>; dexOrder: number[] } {
  const numIndexes = c('pokemon', 'NUM_POKEMON_INDEXES');
  const size = c('pokemon_data', 'BASE_DATA_SIZE');
  const baseStats = rom.sym('BaseStats');
  const dexOrderOff = rom.sym('PokedexOrder');
  const namesOff = rom.sym('MonsterNames');
  const evos = rom.sym('EvosMovesPointerTable');
  const evosBank = symBank('EvosMovesPointerTable');
  const constNames = names('pokemon');
  const numTmHm = c('item', 'NUM_TM_HM');

  const dexOrder: number[] = [0];
  const species: Record<number, SpeciesData> = {};
  for (let index = 1; index <= numIndexes; index++) {
    const dex = rom.u8(dexOrderOff + index - 1);
    dexOrder.push(dex);
    const name = decodeFixed(rom, namesOff + (index - 1) * 10, 10);

    // evolutions + learnset
    let p = toOffset(evosBank, rom.u16(evos + (index - 1) * 2));
    const evolutions: Evolution[] = [];
    for (;;) {
      const method = rom.u8(p++);
      if (method === 0) break;
      if (method === 1) {
        evolutions.push({ method: 'level', level: rom.u8(p), species: rom.u8(p + 1) });
        p += 2;
      } else if (method === 2) {
        evolutions.push({ method: 'item', item: rom.u8(p), minLevel: rom.u8(p + 1), species: rom.u8(p + 2) });
        p += 3;
      } else if (method === 3) {
        evolutions.push({ method: 'trade', minLevel: rom.u8(p), species: rom.u8(p + 1) });
        p += 2;
      } else throw new Error(`unknown evolution method ${method} for species ${index}`);
    }
    const learnset: { level: number; move: number }[] = [];
    for (;;) {
      const level = rom.u8(p++);
      if (level === 0) break;
      learnset.push({ level, move: rom.u8(p++) });
    }
    if (dex === 0) continue; // MissingNo. slots
    const r = rom.reader(baseStats + (dex - 1) * size);
    const storedDex = r.u8();
    assert(storedDex === dex, `base stats order for dex ${dex}`);
    const baseStatsObj = { hp: r.u8(), atk: r.u8(), def: r.u8(), spd: r.u8(), spc: r.u8() };
    const types: [number, number] = [r.u8(), r.u8()];
    const catchRate = r.u8();
    const baseExp = r.u8();
    const frontSpriteDims = r.u8();
    r.u16();
    r.u16(); // front/back pic pointers (pics are decoded by the graphics extractor)
    const level1Moves = [r.u8(), r.u8(), r.u8(), r.u8()].filter((m) => m !== 0);
    const growthRate = r.u8();
    const bits = r.bytes(7);
    const tmhm: number[] = [];
    for (let n = 0; n < numTmHm; n++) if (bits[n >> 3] & (1 << (n & 7))) tmhm.push(n + 1);
    species[index] = {
      index,
      constName: constNames.get(index) ?? `MON_${index}`,
      name,
      dex,
      baseStats: baseStatsObj,
      types,
      catchRate,
      baseExp,
      frontSpriteDims,
      level1Moves,
      growthRate,
      tmhm,
      evolutions,
      learnset,
    };
  }
  return { species, dexOrder };
}

export function extractDexEntries(rom: Rom, dexOrder: number[], texts: TextCollector): Record<number, DexEntry> {
  const table = rom.sym('PokedexEntryPointers');
  const bank = symBank('PokedexEntryPointers');
  const out: Record<number, DexEntry> = {};
  for (let index = 1; index < dexOrder.length; index++) {
    const dex = dexOrder[index];
    if (!dex) continue;
    let p = toOffset(bank, rom.u16(table + (index - 1) * 2));
    const category = decodeString(rom, p, 16);
    while (rom.u8(p) !== 0x50) p++;
    p++;
    const heightFeet = rom.u8(p);
    const heightInches = rom.u8(p + 1);
    const weightTenthsLb = rom.u16(p + 2);
    p += 4;
    assert(rom.u8(p) === 0x17, `dex entry ${dex} text_far`);
    const target = toOffset(rom.u8(p + 3), rom.u16(p + 1));
    const textLabel = labelFor(target);
    texts.add(textLabel, target);
    out[dex] = { dex, category, heightFeet, heightInches, weightTenthsLb, textLabel };
  }
  return out;
}

export function extractMoves(rom: Rom): MoveData[] {
  const num = c('move', 'NUM_ATTACKS');
  const len = c('battle', 'MOVE_LENGTH');
  const table = rom.sym('Moves');
  const moveNames = stringList(rom, rom.sym('MoveNames'), num);
  const constNames = names('move');
  const out: MoveData[] = [];
  for (let id = 1; id <= num; id++) {
    const r = rom.reader(table + (id - 1) * len);
    out.push({
      id,
      constName: constNames.get(id) ?? `MOVE_${id}`,
      name: moveNames[id - 1],
      animation: r.u8(),
      effect: r.u8(),
      power: r.u8(),
      type: r.u8(),
      accuracy: r.u8(),
      pp: r.u8(),
    });
  }
  return out;
}

export function extractTypes(rom: Rom): TypeData {
  const table = rom.sym('TypeNames');
  const bank = symBank('TypeNames');
  const num = c('type', 'NUM_TYPES');
  const typeNames: Record<number, string> = {};
  const valid = new Set(constEntries('type').filter(([k]) => !/UNUSED|NUM_|PHYSICAL|SPECIAL/.test(k)).map(([, v]) => v));
  for (let t = 0; t < num; t++) {
    typeNames[t] = valid.has(t) ? decodeString(rom, toOffset(bank, rom.u16(table + t * 2)), 16) : '';
  }
  const chart: [number, number, number][] = [];
  for (let p = rom.sym('TypeEffects'); rom.u8(p) !== 0xff; p += 3) chart.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2)]);
  return { names: typeNames, chart };
}

export function extractItems(rom: Rom): ItemData[] {
  const numItems = c('item', 'NUM_ITEMS');
  const numFloors = c('item', 'NUM_FLOORS');
  const itemNames = stringList(rom, rom.sym('ItemNames'), numItems + numFloors);
  const prices = rom.sym('ItemPrices');
  const tmPrices = rom.sym('TechnicalMachinePrices');
  const constNames = names('item');
  const keyFlags = rom.sym('KeyItemFlags');
  const out: ItemData[] = [];
  for (let id = 1; id <= numItems + numFloors; id++) {
    out.push({
      id,
      constName: constNames.get(id) ?? `ITEM_${id}`,
      name: itemNames[id - 1],
      price: id <= numItems ? bcd(rom, prices + (id - 1) * 3, 3) : 0,
      // IsKeyItem_: bit (id - 1) of KeyItemFlags
      isKey: id <= numItems && ((rom.u8(keyFlags + ((id - 1) >> 3)) >> ((id - 1) & 7)) & 1) === 1,
    });
  }
  // HMs and TMs: names are generated by the game ("HM01", "TM01"); TM prices are nybbles in thousands.
  const hm01 = c('item', 'HM01');
  const tm01 = c('item', 'TM01');
  for (let i = 0; i < c('item', 'NUM_HMS'); i++) {
    out.push({ id: hm01 + i, constName: constNames.get(hm01 + i)!, name: `HM${String(i + 1).padStart(2, '0')}`, price: 0, isKey: true });
  }
  for (let i = 0; i < c('item', 'NUM_TMS'); i++) {
    const byte = rom.u8(tmPrices + (i >> 1));
    const nyb = i & 1 ? byte & 0xf : byte >> 4;
    out.push({ id: tm01 + i, constName: constNames.get(tm01 + i)!, name: `TM${String(i + 1).padStart(2, '0')}`, price: nyb * 1000, isKey: false });
  }
  return out;
}

export function extractWild(rom: Rom): WildData {
  const numMaps = c('map', 'NUM_MAPS');
  const table = rom.sym('WildDataPointers');
  const bank = symBank('WildDataPointers');
  const grass: Record<number, WildTable> = {};
  const water: Record<number, WildTable> = {};
  const readTable = (p: number): [WildTable | undefined, number] => {
    const rate = rom.u8(p++);
    if (!rate) return [undefined, p];
    const slots = [];
    for (let i = 0; i < 10; i++) {
      slots.push({ level: rom.u8(p), species: rom.u8(p + 1) });
      p += 2;
    }
    return [{ rate, slots }, p];
  };
  for (let map = 0; map < numMaps; map++) {
    let p = toOffset(bank, rom.u16(table + map * 2));
    const [g, next] = readTable(p);
    p = next;
    const [w] = readTable(p);
    if (g) grass[map] = g;
    if (w) water[map] = w;
  }
  const slotChances = [];
  const sc = rom.sym('WildMonEncounterSlotChances');
  for (let i = 0; i < 10; i++) slotChances.push(rom.u8(sc + i * 2));

  // Old Rod: `lb bc, 5, MAGIKARP` inside ItemUseOldRod (ld bc = $01, c=species, b=level).
  const oldRodCode = rom.sym('ItemUseOldRod');
  let oldRod: { species: number; level: number } | undefined;
  for (let p = oldRodCode; p < oldRodCode + 16; p++) {
    if (rom.u8(p) === 0x01) {
      oldRod = { species: rom.u8(p + 1), level: rom.u8(p + 2) };
      break;
    }
  }
  assert(oldRod, 'old rod encounter');

  const gr = rom.sym('GoodRodMons');
  const goodRod = [0, 1].map((i) => ({ level: rom.u8(gr + i * 2), species: rom.u8(gr + i * 2 + 1) }));

  const superRod: WildData['superRod'] = {};
  for (let p = rom.sym('SuperRodFishingSlots'); rom.u8(p) !== 0xff; p += 9) {
    const map = rom.u8(p);
    superRod[map] = [0, 1, 2, 3].map((i) => ({ species: rom.u8(p + 1 + i * 2), level: rom.u8(p + 2 + i * 2) }));
  }
  return { grass, water, slotChances, oldRod, goodRod, superRod };
}

export function extractTrainers(rom: Rom): TrainerClassData[] {
  const num = c('trainer', 'NUM_TRAINERS');
  const trainerNames = stringList(rom, rom.sym('TrainerNames'), num);
  const picMoney = rom.sym('TrainerPicAndMoneyPointers');
  // Trainer pics all live in one bank (see gfx/pics.asm); YoungsterPic is the first.
  const picBank = symBank('YoungsterPic');
  const parties = rom.sym('TrainerDataPointers');
  const partyBank = symBank('TrainerDataPointers');
  const constNames = names('trainer');

  // move choice modification lists, one per class
  const modsPerClass: number[][] = [];
  let mp = rom.sym('TrainerClassMoveChoiceModifications');
  for (let i = 0; i < num; i++) {
    const list = [];
    for (;;) {
      const b = rom.u8(mp++);
      if (b === 0) break;
      list.push(b);
    }
    modsPerClass.push(list);
  }

  const out: TrainerClassData[] = [];
  for (let id = 1; id <= num; id++) {
    const start = toOffset(partyBank, rom.u16(parties + (id - 1) * 2));
    const end = nextLabelOffset(start);
    const list = [];
    let p = start;
    while (p < end) {
      const first = rom.u8(p++);
      const mons: { species: number; level: number }[] = [];
      if (first === 0xff) {
        for (;;) {
          const level = rom.u8(p++);
          if (level === 0) break;
          mons.push({ level, species: rom.u8(p++) });
        }
      } else {
        for (;;) {
          const species = rom.u8(p++);
          if (species === 0) break;
          mons.push({ level: first, species });
        }
      }
      list.push({ mons });
    }
    const picPtr = toOffset(picBank, rom.u16(picMoney + (id - 1) * 5));
    out.push({
      id,
      constName: constNames.get(id) ?? `TRAINER_${id}`,
      name: trainerNames[id - 1],
      // The table stores bcd3, but GetTrainerInformation copies only its
      // first TWO bytes into wTrainerBaseMoney (the low table byte is unused).
      baseMoney: bcd(rom, picMoney + (id - 1) * 5 + 2, 2),
      picLabel: labelFor(picPtr),
      parties: list,
      aiMoveChoiceModifications: modsPerClass[id - 1],
    });
  }
  return out;
}

export function extractGrowthRates(rom: Rom): { a: number; b: number; c: number; d: number; e: number }[] {
  const t = rom.sym('GrowthRateTable');
  const out = [];
  for (let i = 0; i < c('pokemon_data', 'NUM_GROWTH_RATES'); i++) {
    const p = t + i * 4;
    const ab = rom.u8(p);
    const cs = rom.u8(p + 1);
    out.push({ a: ab >> 4, b: ab & 0xf, c: cs & 0x80 ? -(cs & 0x7f) : cs, d: rom.u8(p + 2), e: rom.u8(p + 3) });
  }
  return out;
}

export function extractDexRatings(rom: Rom, texts: TextCollector): { below: number; textLabel: string }[] {
  const p0 = rom.sym('DexRatingsTable');
  const bank = symBank('DexRatingsTable');
  const out = [];
  for (let p = p0; ; p += 3) {
    const below = rom.u8(p);
    const target = toOffset(bank, rom.u16(p + 1));
    const textLabel = labelFor(target);
    texts.add(textLabel, target);
    out.push({ below, textLabel });
    if (below > 151) break;
  }
  return out;
}
