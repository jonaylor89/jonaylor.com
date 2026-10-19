/**
 * Hidden events and the tables their routines read:
 * data/events/hidden_events.asm (HiddenEventMaps), TextPredefs,
 * BookshelfTileIDs, HiddenItemCoords / HiddenCoinCoords, BenchGuyTextPointers,
 * MapBadgeFlags and GymTrashCans3c.
 */
import type { Rom } from '../Rom';
import type { GameBundle } from '../../data/schema';
import type { TextCollector } from './texts';
import { labelsAt, sym, toOffset, symBank } from '../symbols';
import { labelFor } from '../text';
import { textEntryAt } from './maps';
import { assert } from './util';

export function extractHiddenEvents(rom: Rom, texts: TextCollector): GameBundle['hidden'] {
  // TextPredefs: one word per entry, each entry labelled <Text>_id (ids start at 1)
  const predefs: GameBundle['hidden']['textPredefs'] = {};
  const predefIds: Record<string, number> = {};
  const tp = sym('TextPredefs');
  // The pointers are read in the bank of the routine that prints them, so resolve each by its label.
  for (let i = 0; ; i++) {
    const id = labelsAt(tp + i * 2).find((l) => l.endsWith('_id'));
    if (!id) break;
    const target = sym(id.slice(0, -3));
    assert((target & 0x3fff) === (rom.u16(tp + i * 2) & 0x3fff), `TextPredefs ${id}`);
    predefs[i + 1] = textEntryAt(rom, texts, target);
    predefIds[id.slice(0, -3)] = i + 1;
  }
  const predefCount = Object.keys(predefs).length;
  assert(predefCount >= 0x44, `TextPredefs has ${predefCount} entries`);

  const events: GameBundle['hidden']['events'] = {};
  const maps = sym('HiddenEventMaps');
  const bank = symBank('HiddenEventMaps');
  for (let p = maps; rom.u8(p) !== 0xff; p += 3) {
    const map = rom.u8(p);
    const list: GameBundle['hidden']['events'][number] = [];
    for (let q = toOffset(bank, rom.u16(p + 1)); rom.u8(q) !== 0xff; q += 6) {
      const fnOff = toOffset(rom.u8(q + 3), rom.u16(q + 4));
      const fn = labelsAt(fnOff).find((l) => !l.includes('.') && !l.endsWith('End')) ?? labelFor(fnOff);
      list.push({ y: rom.u8(q), x: rom.u8(q + 1), arg: rom.u8(q + 2), fn });
    }
    events[map] = list;
  }

  const triples = (label: string) => {
    const out: [number, number, number][] = [];
    for (let p = sym(label); rom.u8(p) !== 0xff; p += 3) out.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2)]);
    return out;
  };
  const coords = (label: string) => triples(label).map(([map, y, x]) => ({ map, y, x }));

  const badges: { map: number; mask: number }[] = [];
  for (let p = sym('MapBadgeFlags'); rom.u8(p) !== 0xff; p += 2) badges.push({ map: rom.u8(p), mask: rom.u8(p + 1) });

  // GymTrashCans3c, raw: Yellow_SampleSecondTrashCan reads up to 2*255 bytes past a row (the 3-entry bug)
  const trashCans = [...rom.slice(sym('GymTrashCans3c'), 15 * 9 + 2 * 256 + 2)];

  // texts printed by the hidden event routines' asm
  for (const l of [
    'TurnPageText',
    'ViridianSchoolNotebookText1',
    'ViridianSchoolNotebookText2',
    'ViridianSchoolNotebookText3',
    'ViridianSchoolNotebookText4',
    'ViridianSchoolNotebookText5',
    'ViridianSchoolBlackboardText1',
    'ViridianSchoolBlackboardText2',
    'ViridianBlackboardSleepText',
    'ViridianBlackboardPoisonText',
    'ViridianBlackboardPrlzText',
    'ViridianBlackboardBurnText',
    'ViridianBlackboardFrozenText',
    'LinkCableHelpText1',
    'LinkCableHelpText2',
    'LinkCableInfoText1',
    'LinkCableInfoText2',
    'LinkCableInfoText3',
    'SaffronCityPokecenterBenchGuyText1',
    'SaffronCityPokecenterBenchGuyText2',
    'IndigoPlateauStatuesText1',
    'IndigoPlateauStatuesText2',
    'IndigoPlateauStatuesText3',
    'PokemonBooksText',
    'DiglettSculptureText',
    'BillsHousePokemonListText1',
    'BillsHousePokemonListText2',
    'HiddenItemBagFullText',
    'CinnabarGymQuizIntroText',
    'CinnabarGymQuizShortIntroText',
    'CinnabarQuizQuestionsText1',
    'CinnabarQuizQuestionsText2',
    'CinnabarQuizQuestionsText3',
    'CinnabarQuizQuestionsText4',
    'CinnabarQuizQuestionsText5',
    'CinnabarQuizQuestionsText6',
    'CinnabarGymQuizCorrectText',
    'CinnabarGymQuizIncorrectText',
    'VendingMachineText1',
    'VendingMachineText4',
    'VendingMachineText5',
    'VendingMachineText6',
    'VendingMachineText7',
  ])
    texts.add(l);

  return {
    events,
    textPredefs: predefs,
    predefIds,
    bookshelves: triples('BookshelfTileIDs').map(([tileset, tile, predef]) => ({ tileset, tile, predef })),
    itemCoords: coords('HiddenItemCoords'),
    coinCoords: coords('HiddenCoinCoords'),
    benchGuys: triples('BenchGuyTextPointers').map(([map, facing, predef]) => ({ map, facing, predef })),
    mapBadgeFlags: badges,
    trashCans,
    // CinnabarGymGateCoords: x, y (blocks), gate block id, padding
    cinnabarGates: Array.from({ length: 6 }, (_, i) => {
      const p = sym('CinnabarGymGateCoords') + i * 4;
      return { x: rom.u8(p), y: rom.u8(p + 1), block: rom.u8(p + 2) };
    }),
    // VendingPrices: item id, 3-byte BCD price
    vendingPrices: Array.from({ length: 3 }, (_, i) => {
      const p = sym('VendingPrices') + i * 4;
      const bcd = (b: number) => (b >> 4) * 10 + (b & 0xf);
      return { item: rom.u8(p), price: bcd(rom.u8(p + 1)) * 10000 + bcd(rom.u8(p + 2)) * 100 + bcd(rom.u8(p + 3)) };
    }),
    // PikachuMovementDatabase (4 bytes per command $00-$3e) and SineWave_3f (32 words)
    pikachuMovement: [...rom.slice(sym('PikachuMovementDatabase'), 0x3f * 4)],
    pikachuSine: Array.from({ length: 32 }, (_, i) => rom.u16(sym('SineWave_3f') + i * 2)),
    silphCoMaps: (() => {
      const out: number[] = [];
      for (let p = sym('SilphCoMapList'); rom.u8(p) !== 0xff; p++) out.push(rom.u8(p));
      return out;
    })(),
  };
}
