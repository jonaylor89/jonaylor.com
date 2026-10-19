/**
 * Full extraction: user ROM bytes -> GameBundle.
 * Runs identically in the browser (Web Worker) and in Node (tools/extract.ts).
 */
import { Rom } from '../Rom';
import { SCHEMA_VERSION, type GameBundle } from '../../data/schema';
import { extractMaps, extractSpecialWarps, extractToggleableObjects } from './maps';
import { extractTilesets, extractTileTables } from './tilesets';
import { extractOverworldSprites, extractPalettes } from './sprites';
import { extractHiddenEvents } from './hidden';
import { extractPikachuEmotions } from './pikachuEmotions';
import { extractTrades } from './trades';
import { extractTownMap } from './townMap';
import { extractSurfing } from './surfing';
import { extractIntro } from './intro';
import { extractAudio } from './audio';
import { extractBattleAnims } from './battleAnims';
import { bcd, decode2bpp, readUntil } from './util';
import { decodeString } from '../text';
import { extractDexRatings, extractGrowthRates, extractDexEntries, extractItems, extractMoves, extractSpecies, extractTrainers, extractTypes, extractWild } from './pokemon';
import { TextCollector } from './texts';
import { extractUiGraphics } from './ui';
import { analyzeSimpleAsm } from './simpleAsm';
import { extractStrings } from './strings';
import { extractPics } from './pics';
import { extractBattleData } from './battle';

export const EXTRACTOR_VERSION = '0.1.0';

export const DERIVED_NOTICE =
  'This data was extracted locally from your own Pokémon Yellow ROM. ' +
  'It is derived from copyrighted material owned by Nintendo / Creatures / GAME FREAK ' +
  'and must not be redistributed.';

export type ProgressFn = (step: string, done: number, total: number) => void;

export interface ExtractionResult {
  bundle: GameBundle;
  warnings: string[];
}

export async function extractBundle(bytes: Uint8Array, progress: ProgressFn = () => {}): Promise<ExtractionResult> {
  const { rom, sha1, title } = await Rom.load(bytes);
  const texts = new TextCollector(rom);
  const steps = 10;
  let n = 0;
  const step = <T>(name: string, fn: () => T): T => {
    progress(name, n++, steps);
    return fn();
  };

  const tilesets = step('tilesets', () => extractTilesets(rom));
  const tileTables = step('tile tables', () => extractTileTables(rom));
  const maps = step('maps', () => extractMaps(rom, texts));
  const toggleableObjects = step('toggleable objects', () => extractToggleableObjects(rom));
  const sprites = step('sprites', () => extractOverworldSprites(rom));
  const palettes = step('palettes', () => extractPalettes(rom));
  const ui = extractUiGraphics(rom);
  const { species, dexOrder } = step('pokemon', () => extractSpecies(rom));
  const dexEntries = step('pokedex', () => extractDexEntries(rom, dexOrder, texts));
  const moves = extractMoves(rom);
  const types = extractTypes(rom);
  const items = extractItems(rom);
  const wild = step('encounters', () => extractWild(rom));
  const trainers = step('trainers', () => extractTrainers(rom));
  step('text', () => {
    texts.addAllTextBankLabels();
    texts.addScriptTextLabels();
  });
  const strings = extractStrings(rom);
  const pics = extractPics(rom, { species, trainers });
  const hidden = extractHiddenEvents(rom, texts);
  const pikachuEmotions = extractPikachuEmotions(rom, texts, hidden.pikachuMovement);
  const trades = extractTrades(rom, texts);
  const simpleAsm = analyzeSimpleAsm(rom, { texts: texts.texts }, texts);
  progress('done', steps, steps);

  const bundle: GameBundle = {
    meta: {
      schemaVersion: SCHEMA_VERSION,
      extractorVersion: EXTRACTOR_VERSION,
      sourceSha1: sha1,
      romTitle: title,
      extractedAt: new Date().toISOString(),
      derivedFromUserRom: true,
      notice: DERIVED_NOTICE,
    },
    maps,
    toggleableObjects,
    tilesets,
    tileTables,
    sprites,
    palettes,
    ui,
    species,
    dexOrder,
    dexEntries,
    growthRates: extractGrowthRates(rom),
    dexRatings: extractDexRatings(rom, texts),
    moves,
    types,
    items,
    wild,
    trainers,
    texts: texts.texts,
    simpleAsm,
    strings,
    pics,
    battle: extractBattleData(rom),
    specialWarps: extractSpecialWarps(rom),
    // TechnicalMachines: the move taught by TM01..TM50, HM01..HM05
    hidden,
    pikachuEmotions,
    trades,
    townMap: extractTownMap(rom),
    surfing: extractSurfing(rom),
    battleAnims: extractBattleAnims(rom),
    intro: extractIntro(rom),
    audio: extractAudio(rom),
    misc: {
      guardDrinks: readUntil(rom, rom.sym('GuardDrinksList'), 0),
      roofDrinks: readUntil(rom, rom.sym('CeladonMartRoofDrinkList'), 0),
      elevators: Object.fromEntries(
        ['CeladonMartElevator', 'RocketHideoutElevator', 'SilphCoElevator'].map((l) => {
          const f = rom.sym(`${l}Floors`);
          const floors = [...rom.slice(f + 1, rom.u8(f))];
          const w = rom.sym(`${l}WarpMaps`);
          const warps = floors.map((_, i) => ({ warp: rom.u8(w + i * 2), map: rom.u8(w + i * 2 + 1) }));
          return [l, { floors, warps }];
        }),
      ),
      prizes: [0, 1, 2].map((i) => {
        const p = rom.sym('PrizeDifferentMenuPtrs') + i * 4;
        const bank = Math.floor(p / 0x4000);
        const at = (ptr: number) => bank * 0x4000 + (ptr - 0x4000);
        const entries = [...rom.slice(at(rom.u16(p)), 3)];
        const costs = [0, 1, 2].map((k) => bcd(rom, at(rom.u16(p + 2)) + k * 2, 2));
        return { entries, costs };
      }),
      prizeMonLevels: Object.fromEntries(
        Array.from({ length: 6 }, (_, i) => [rom.u8(rom.sym('PrizeMonLevelDictionary') + i * 2), rom.u8(rom.sym('PrizeMonLevelDictionary') + i * 2 + 1)]),
      ),
      // DefaultNamesPlayer/Rival (the menu text) and their lists (GetDefaultName)
      defaultNames: Object.fromEntries(
        ['Player', 'Rival'].map((who) => {
          const names: string[] = [];
          let p = rom.sym(`DefaultNames${who}List`);
          for (let i = 0; i < 4; i++) {
            names.push(decodeString(rom, p, 20));
            while (rom.u8(p) !== 0x50) p++;
            p++;
          }
          return [who.toLowerCase(), { menu: decodeString(rom, rom.sym(`DefaultNames${who}`), 80), names }];
        }),
      ) as Record<'player' | 'rival', { menu: string; names: string[] }>,
      // SilphCo11FTeamRocketLeavesScript's toggle lists
      silphRocketsLeave: {
        hide: readUntil(rom, rom.sym('SilphCo11FTeamRocketLeavesScript.HideToggleableObjectIDs')),
        show: readUntil(rom, rom.sym('SilphCo11FTeamRocketLeavesScript.ShowToggleableObjectIDs')),
      },
      // LedgeHoppingShadow: one 1bpp tile, copied doubled (set bits are color 3)
      ledgeShadow: [...rom.slice(rom.sym('LedgeHoppingShadow'), 8)].flatMap((row) => [7, 6, 5, 4, 3, 2, 1, 0].map((b) => ((row >> b) & 1) * 3)),
      // SpinnerArrowAnimTiles: four 8x8 tiles (2-bit pixels)
      spinnerTiles: [0, 1, 2, 3].map((i) => decode2bpp(rom.slice(rom.sym('SpinnerArrowAnimTiles') + i * 16, 16))),
      arrowTiles: Object.fromEntries(
        ['ViridianGym', 'RocketHideout2', 'RocketHideout3'].map((m) => {
          const label = `${m}ArrowTilePlayerMovement`;
          const bank = Math.floor(rom.sym(label) / 0x4000);
          const out: { x: number; y: number; rle: number[] }[] = [];
          for (let p = rom.sym(label); rom.u8(p) !== 0xff; p += 4) {
            const list = bank * 0x4000 + (rom.u16(p + 2) - 0x4000);
            out.push({ y: rom.u8(p), x: rom.u8(p + 1), rle: readUntil(rom, list) });
          }
          return [m, out];
        }),
      ),
    },
    tmMoves: Array.from({ length: 55 }, (_, i) => rom.u8(rom.sym('TechnicalMachines') + i)),
  };
  const warnings = Object.entries(texts.failures).map(([l, m]) => `text ${l}: ${m}`);
  return { bundle, warnings };
}
