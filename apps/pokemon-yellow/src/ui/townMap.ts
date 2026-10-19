/**
 * The Town Map (engine/items/town_map.asm): DisplayTownMap for the TOWN MAP
 * item and the wall maps, LoadTownMap_Fly for Fly, and LoadTownMap_Nest for
 * the Pokédex AREA page. Map tiles go to $60; the cursor, player, bird and nest
 * icon are OAM objects drawn with glyph overrides.
 */
import type { Co, Engine } from '../engine/Engine';
import { c } from '../rom/constants';
import { PAD_A, PAD_B, PAD_DOWN, PAD_UP } from '../engine/pad';
import { LowSensitivity, restoreScreen, saveScreen } from './menus';
import { encodePlain } from './TextPrinter';

const NOT_VISITED = 0xfe;
/** Object glyph codes outside the font range: 4 player tiles, 4 bird, 4 cursor, 1 nest icon. */
const OBJ_PLAYER = 0x400;
const OBJ_BIRD = 0x404;
const OBJ_CURSOR = 0x408;
const OBJ_NEST = 0x40c;

interface Obj {
  x: number;
  y: number;
  code: number;
}

/** LoadTownMapEntry: map coordinates (in 8 px units) and name. */
export function townMapEntry(e: Engine, map: number): { x: number; y: number; name: string } {
  const t = e.bundle.townMap;
  if (map < c('map', 'FIRST_INDOOR_MAP')) return t.external[map];
  const entry = t.internal.find((i) => map < i.below);
  if (!entry) throw new Error(`no town map entry for map ${map}`);
  return entry;
}

/** A 16x16 sheet frame as four 8x8 tiles (TL, TR, BL, BR). */
function quarters(px: ArrayLike<number>, frameOffset = 0): number[][] {
  return [0, 1, 2, 3].map((q) => {
    const out: number[] = [];
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) out.push(px[frameOffset + ((q >> 1) * 8 + y) * 16 + (q & 1) * 8 + x]);
    return out;
  });
}

/** WriteTownMapSpriteOAM: a 2x2 block at the entry, 4 px left and 3 px up of (x*8+24, y*8+24) in OAM space. */
function block(entry: { x: number; y: number }, base: number): Obj[] {
  const sx = entry.x * 8 + 24 - 4 - 8;
  const sy = entry.y * 8 + 24 - 3 - 16;
  return [0, 1, 2, 3].map((i) => ({ x: sx + (i & 1) * 8, y: sy + (i >> 1) * 8, code: base + i }));
}

function put(e: Engine, x: number, y: number, s: string): void {
  encodePlain(s).forEach((code, i) => e.screen.put(x + i, y, code));
}

/** LoadTownMap: the map tiles and tilemap, the town map palette, and the object glyphs. */
function loadTownMap(e: Engine): void {
  const t = e.bundle.townMap;
  const scr = e.screen;
  for (let i = 0; i < t.tiles.length / 64; i++) scr.setGlyphOverride(0x60 + i, t.tiles.slice(i * 64, i * 64 + 64));
  const red = e.bundle.sprites.find((s) => s.id === c('sprite', 'SPRITE_RED'))!;
  quarters(red.pixels).forEach((px, i) => scr.setGlyphOverride(OBJ_PLAYER + i, px));
  for (let i = 0; i < 4; i++) scr.setGlyphOverride(OBJ_BIRD + i, t.bird.slice(i * 64, i * 64 + 64));
  for (let i = 0; i < 4; i++) scr.setGlyphOverride(OBJ_CURSOR + i, t.cursor.slice(i * 64, i * 64 + 64));
  scr.setGlyphOverride(OBJ_NEST, t.nestIcon);
  scr.clear();
  t.tilemap.forEach((code, i) => scr.put(i % 20, Math.floor(i / 20), code));
  e.hooks.palette?.(c('palette', 'PAL_TOWNMAP'));
}

/** ExitTownMap */
function exitTownMap(e: Engine, saved: Int16Array): void {
  e.screen.setObjects([]);
  e.screen.clearGlyphOverrides();
  restoreScreen(e, saved);
  e.hooks.palette?.(undefined);
}

/** DisplayTownMap: browse TownMapOrder from the current map; A/B leave. */
export function* displayTownMap(e: Engine): Co {
  const saved = saveScreen(e);
  loadTownMap(e);
  const t = e.bundle.townMap;
  const player = block(townMapEntry(e, e.world.data.id), OBJ_PLAYER);
  let which = 0;
  let map = e.world.data.id;
  const js = new LowSensitivity(e);
  let anim = 0;
  for (;;) {
    e.screen.fill(0, 0, 20, 1, t.tilemap[0]);
    const entry = townMapEntry(e, map);
    put(e, 1, 0, entry.name);
    const cursor = block(entry, OBJ_CURSOR);
    // TownMapSpriteBlinkingAnimation: everything but the player (OAM 36-39) blinks every 25 frames
    for (;;) {
      anim++;
      if (anim === 50) anim = 0;
      e.screen.setObjects(anim >= 25 ? player : [...cursor, ...player]);
      yield;
      const b = js.read(e);
      if (!(b & (PAD_A | PAD_B | PAD_UP | PAD_DOWN))) continue;
      e.env.playSound('tink');
      if (b & PAD_UP) which = (which + 1) % t.order.length;
      else if (b & PAD_DOWN) which = (which + t.order.length - 1) % t.order.length;
      else return exitTownMap(e, saved);
      map = t.order[which];
      break;
    }
  }
}

/** BuildFlyLocationsList: visited towns by map id, NOT_VISITED otherwise. */
function flyLocations(e: Engine): number[] {
  const visited = e.env.vars.wTownVisitedFlag ?? 0;
  return Array.from({ length: c('map', 'NUM_CITY_MAPS') }, (_, m) => ((visited >> m) & 1 ? m : NOT_VISITED));
}

/** LoadTownMap_Fly: choose a visited town; A sets the Fly warp (true), B cancels. */
export function* chooseFlyDestination(e: Engine): Co<boolean> {
  const saved = saveScreen(e);
  loadTownMap(e);
  const t = e.bundle.townMap;
  e.screen.setGlyphOverride(0xed, t.upArrow);
  const list = flyLocations(e);
  put(e, 0, 0, t.strings.to);
  const player = block(townMapEntry(e, e.world.data.id), OBJ_PLAYER);
  let i = list.findIndex((m) => m !== NOT_VISITED);
  if (i < 0) i = 0;
  const js = new LowSensitivity(e);
  for (;;) {
    e.screen.put(18, 0, 0x7f);
    e.screen.fill(3, 0, 15, 1, t.tilemap[3]);
    const entry = townMapEntry(e, list[i]);
    e.screen.setObjects([...block(entry, OBJ_BIRD), ...player]);
    put(e, 3, 0, entry.name);
    yield* e.delayFrames(15);
    e.screen.put(18, 0, 0xed); // ▲
    e.screen.put(19, 0, 0xee); // ▼
    for (;;) {
      yield;
      const b = js.read(e);
      if (!(b & (PAD_A | PAD_B | PAD_UP | PAD_DOWN))) continue;
      if (b & PAD_A) {
        e.env.playSound('heal_ailment');
        e.ram.destinationMap = list[i];
        e.ram.flyWarp = true;
        e.ram.usedFly = true;
        exitTownMap(e, saved);
        return true;
      }
      e.env.playSound('tink');
      if (b & PAD_UP) {
        // the next visited town, wrapping to the start of the list
        do i = (i + 1) % list.length;
        while (list[i] === NOT_VISITED);
      } else if (b & PAD_DOWN) {
        do i = (i + list.length - 1) % list.length;
        while (list[i] === NOT_VISITED);
      } else {
        exitTownMap(e, saved);
        return false;
      }
      break;
    }
  }
}

/** MarkTownVisitedAndLoadToggleableObjects: entering a town marks it for Fly. */
export function markTownVisited(e: Engine): void {
  const map = e.world.data.id;
  if (map >= c('map', 'FIRST_ROUTE_MAP')) return;
  const v = e.env.vars.wTownVisitedFlag ?? 0;
  if (!((v >> map) & 1)) e.env.setVar('wTownVisitedFlag', v | (1 << map));
}

/** The Pokédex AREA page: nest icons where `species` lives (LoadTownMap_Nest). */
export function* displayNests(e: Engine, species: number): Co {
  const saved = saveScreen(e);
  loadTownMap(e);
  const t = e.bundle.townMap;
  const maps = wildLocations(e, species);
  const objs: Obj[] = [];
  const seen = new Set<number>();
  for (const m of maps) {
    const entry = townMapEntry(e, m);
    const key = entry.y * 16 + entry.x;
    // ZeroOutDuplicatesInList, and Cerulean Cave ($19) is never shown
    if (seen.has(key) || key === 0x19) continue;
    seen.add(key);
    objs.push({ x: entry.x * 8 + 24 - 8, y: entry.y * 8 + 24 - 16, code: OBJ_NEST });
  }
  if (!objs.length) {
    e.screen.box(1, 7, 2, 15);
    put(e, 2, 9, t.strings.areaUnknown);
  } else objs.push(...block(townMapEntry(e, e.world.data.id), OBJ_PLAYER));
  e.screen.setObjects(objs);
  const name = e.bundle.species[species]?.name ?? '';
  put(e, 1, 0, name + t.strings.nest);
  yield* e.waitForTextScrollButtonPress();
  exitTownMap(e, saved);
}

/** FindWildLocationsOfMon: maps whose grass or water table has the species. */
function wildLocations(e: Engine, species: number): number[] {
  const w = e.bundle.wild;
  const out: number[] = [];
  for (let m = 0; m < 0xff; m++) {
    const tables = [w.grass[m], w.water[m]].filter(Boolean);
    if (tables.some((t) => t!.slots.some((s) => s.species === species))) out.push(m);
  }
  return out;
}
