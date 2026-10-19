/**
 * Pokédex screens: ShowPokedexData / DrawDexEntryOnScreen
 * (engine/menus/pokedex.asm), and the Pokédex list with its side menu (ShowPokedexMenu).
 */
import { withoutTextAsm } from '../rom/text';
import type { Co, Engine } from '../engine/Engine';
import { PAD_A, PAD_B, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_UP } from '../engine/pad';
import { encodePlain } from './TextPrinter';
import { handleMenuInput, LowSensitivity } from './menus';
import { drawFlippedFrontPic, printerJob } from './printer';
import { displayNests } from './townMap';
import { c } from '../rom/constants';
import { getBit } from '../game/state';

const put = (e: Engine, x: number, y: number, s: string) =>
  encodePlain(s.replace(/\{poke\}/g, 'POKé')).forEach((code, i) => e.screen.put(x + i, y, code));

/** LoadPokedexTilePatterns: HP bar tiles, then the Pokédex frame tiles at $60 and a ball at $72. */
function loadPokedexTiles(e: Engine): void {
  const hp = e.bundle.ui.hpBarAndStatus;
  for (let t = 0; t < hp.count && 0x62 + t <= 0x7f; t++) e.screen.setGlyphOverride(0x62 + t, hp.pixels.slice(t * 64, t * 64 + 64));
  const dex = e.bundle.ui.pokedexTiles;
  for (let t = 0; t < dex.count; t++) e.screen.setGlyphOverride(0x60 + t, dex.pixels.slice(t * 64, t * 64 + 64));
  const ball = e.bundle.ui.pokeballs;
  e.screen.setGlyphOverride(0x72, ball.pixels.slice(0, 64));
}

/** ShowPokedexData for a species index; waits for A/B. */
export function* showPokedexData(e: Engine, speciesIndex: number): Co {
  const s = e.screen;
  const savedCells = s.cells.slice();
  s.clear();
  loadPokedexTiles(e);
  yield* drawDexEntryOnScreen(e, speciesIndex);
  const js = new LowSensitivity(e);
  for (;;) {
    yield;
    if (js.read(e) & (PAD_A | PAD_B)) break;
  }
  s.clearGlyphOverrides();
  s.cells.set(savedCells);
  s.markDirty();
}

/** DrawDexEntryOnScreen (+ Pokedex_PrintFlavorTextAtRow11 when owned). */
function* drawDexEntryOnScreen(e: Engine, speciesIndex: number): Co {
  const s = e.screen;
  const b = e.bundle;
  const sp = b.species[speciesIndex];
  s.fill(0, 0, 20, 18, 0x7f);
  s.fill(0, 0, 20, 1, 0x64);
  s.fill(0, 17, 20, 1, 0x6f);
  s.fill(0, 1, 1, 16, 0x66);
  s.fill(19, 1, 1, 16, 0x67);
  s.put(0, 0, 0x63);
  s.put(19, 0, 0x65);
  s.put(0, 17, 0x6c);
  s.put(19, 17, 0x6e);
  [0x68, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x6b, 0x6b, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6b, 0x69, 0x6a].forEach((code, i) =>
    s.put(i, 9, code),
  );
  put(e, 9, 6, 'HT  ?');
  s.put(14, 6, 0x60); // ′
  put(e, 15, 6, '??');
  s.put(17, 6, 0x61); // ″
  put(e, 9, 8, 'WT   ???lb');
  put(e, 9, 2, sp.name);
  const entry = b.dexEntries[sp.dex];
  put(e, 9, 4, entry?.category ?? '');
  s.put(2, 8, 0x74); // №
  s.put(3, 8, 0xf2); // <DOT>
  put(e, 4, 8, String(sp.dex).padStart(3, '0'));
  const owned = getBit(e.state.pokedex.owned, sp.dex - 1);
  yield* e.delayFrames(3);
  // LoadFlippedFrontSpriteByMonIndex at (1,1)
  drawFlippedFrontPic(e, speciesIndex, 1, 1);
  e.hooks.playCry?.(speciesIndex);
  if (!owned || !entry) return;
  put(e, 12, 6, String(entry.heightFeet).padStart(2, ' '));
  s.put(14, 6, 0x60); // ′
  put(e, 15, 6, String(entry.heightInches).padStart(2, '0'));
  s.put(17, 6, 0x61); // ″
  // weight: 5 digits at (11,8), then the last digit moves right for the decimal point
  const w = entry.weightTenthsLb;
  const digits = String(w).padStart(5, ' ');
  put(e, 11, 8, digits);
  if (w < 10) s.put(14, 8, 0xf6); // '0'
  const last = s.get(15, 8);
  s.put(16, 8, last);
  s.put(15, 8, 0xf2);
  const ops = b.texts[entry.textLabel];
  if (ops) {
    const savedDelay = e.ram.noTextDelay;
    e.ram.noTextDelay = true;
    yield* e.textCommandProcessor(withoutTextAsm(ops), 1, 11);
    e.ram.noTextDelay = savedDelay;
  }
}

// ------------------------------------------------------------------ the Pokédex list (ShowPokedexMenu)
const isSet = (bits: number[], dex: number) => getBit(bits, dex - 1);

/** The species index for a Pokédex number (PokedexToIndex). */
function dexToSpecies(e: Engine, dex: number): number {
  for (const [k, sp] of Object.entries(e.bundle.species)) if (sp?.dex === dex) return Number(k);
  return 0;
}

/** ShowPokedexMenu: the list, then DATA / CRY / AREA / PRNT / QUIT for the chosen entry. */
export function* showPokedexMenu(e: Engine): Co {
  const s = e.screen;
  const savedCells = s.cells.slice();
  e.hooks.fade?.(1, 'white'); // GBPalWhiteOut
  s.clear();
  s.fill(0, 0, 20, 18, 0x7f);
  const st = { cursor: 0, scroll: 0 };
  let reload = true;
  for (;;) {
    if (reload) loadPokedexTiles(e);
    reload = false;
    e.hooks.palette?.(c('palette', 'PAL_MEWMON')); // SET_PAL_GENERIC
    const chose = yield* handlePokedexListMenu(e, st);
    if (!chose) break;
    const r = yield* handlePokedexSideMenu(e, st);
    if (r === 'quit') break;
    if (r === 'shown') {
      reload = true;
      s.fill(0, 0, 20, 18, 0x7f);
    }
  }
  e.hooks.fade?.(1, 'white'); // GBPalWhiteOutWithDelay3
  yield* e.delayFrames(3);
  s.clearGlyphOverrides();
  e.hooks.palette?.(undefined);
  s.cells.set(savedCells);
  s.markDirty();
  e.hooks.fade?.(0);
}

function maxSeen(e: Engine): number {
  for (let dex = 151; dex >= 1; dex--) if (isSet(e.state.pokedex.seen, dex)) return dex;
  return 0;
}

/** Pokedex_DrawInterface */
function drawInterface(e: Engine): void {
  const s = e.screen;
  const str = e.bundle.strings;
  for (let x = 15; x < 20; x++) s.put(x, 6, 0x7a); // '─'
  s.put(14, 0, 0x71);
  for (const y0 of [1, 9]) for (let i = 0; i < 9; i++) s.put(14, y0 + i, i & 1 ? 0x70 : 0x71);
  const count = (bits: number[]) => {
    let n = 0;
    for (let dex = 1; dex <= 151; dex++) if (isSet(bits, dex)) n++;
    return n;
  };
  put(e, 16, 2, String(count(e.state.pokedex.seen)).padStart(3, ' '));
  put(e, 16, 5, String(count(e.state.pokedex.owned)).padStart(3, ' '));
  put(e, 16, 1, str.PokedexSeenText);
  put(e, 16, 4, str.PokedexOwnText);
  put(e, 1, 1, str.PokedexContentsText);
  str.PokedexMenuItemsText.split('{next}').forEach((line, i) => put(e, 16, 8 + i * 2, line));
}

/** Pokedex_PlacePokemonList */
function placeList(e: Engine, scroll: number, max: number): void {
  const s = e.screen;
  s.fill(4, 2, 10, 14, 0x7f);
  const n = Math.min(7, max);
  for (let i = 0; i < n; i++) {
    const dex = scroll + i + 1;
    const y = 3 + i * 2;
    put(e, 1, y - 1, String(dex).padStart(3, '0'));
    s.put(3, y, isSet(e.state.pokedex.owned, dex) ? 0x72 : 0x7f);
    const name = isSet(e.state.pokedex.seen, dex) ? (e.bundle.species[dexToSpecies(e, dex)]?.name ?? '') : '----------';
    put(e, 4, y, name);
  }
}

/** HandlePokedexListMenu: true when A picked an entry, false for B. */
function* handlePokedexListMenu(e: Engine, st: { cursor: number; scroll: number }): Co<boolean> {
  drawInterface(e);
  const max = maxSeen(e);
  for (;;) {
    placeList(e, st.scroll, max);
    e.hooks.fade?.(0); // GBPalNormal
    const maxItem = max < 7 ? max - 1 : 6;
    const [item, key] = yield* handleMenuInput(e, {
      topX: 0,
      topY: 3,
      maxItem,
      current: Math.min(st.cursor, Math.max(0, maxItem)),
      watchedKeys: PAD_LEFT | PAD_RIGHT | PAD_B | PAD_A,
      exitOnBounds: true,
    });
    st.cursor = item;
    if (key & PAD_B) return false;
    if (key & PAD_A) return true;
    if (key & PAD_UP) st.scroll = Math.max(0, st.scroll - 1);
    else if (key & PAD_DOWN) {
      if (max >= 7 && st.scroll !== max - 7) st.scroll++;
    } else if (key & PAD_RIGHT) {
      if (max >= 7) {
        st.scroll += 7;
        if (st.scroll >= max - 6) st.scroll = max - 7;
      }
    } else if (key & PAD_LEFT) st.scroll = Math.max(0, st.scroll - 7);
  }
}

/** HandlePokedexSideMenu */
function* handlePokedexSideMenu(e: Engine, st: { cursor: number; scroll: number }): Co<'shown' | 'quit' | 'back'> {
  const s = e.screen;
  s.put(0, 3 + st.cursor * 2, 0xec); // PlaceUnfilledArrowMenuCursor
  const dex = st.scroll + st.cursor + 1;
  const done = (r: 'shown' | 'quit' | 'back') => {
    for (let y = 3; y < 16; y++) s.put(0, y, 0x7f); // cover the list cursor
    return r;
  };
  if (!isSet(e.state.pokedex.seen, dex)) return done('back');
  const species = dexToSpecies(e, dex);
  let current = 0;
  for (;;) {
    const [item, key] = yield* handleMenuInput(e, { topX: 15, topY: 8, maxItem: 4, current, watchedKeys: PAD_A | PAD_B });
    current = item;
    if (key & PAD_B) {
      for (let y = 8; y < 17; y++) s.put(15, y, 0x7f);
      return done('back');
    }
    if (item === 0) {
      // ShowPokedexDataInternal
      s.fill(0, 0, 20, 18, 0x7f);
      yield* drawDexEntryOnScreen(e, species);
      const js = new LowSensitivity(e);
      for (;;) {
        yield;
        if (js.read(e) & (PAD_A | PAD_B)) break;
      }
      return done('shown');
    }
    if (item === 1) {
      e.hooks.playCry?.(species);
      continue;
    }
    if (item === 2) {
      yield* displayNests(e, species);
      return done('shown');
    }
    if (item === 3) {
      // PrintPokedexEntry: with no printer attached the job stops at the error box
      yield* printerJob(e);
      s.fill(0, 0, 20, 18, 0x7f);
      return done('shown');
    }
    return done('quit');
  }
}
