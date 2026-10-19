/**
 * Menus drawn on the tile-grid UI layer: HandleMenuInput, the two-option
 * menus (DisplayTwoOptionMenu) and the naming screen (DisplayNamingScreen).
 */
import type { Co, Engine } from '../engine/Engine';
import { inputToPad, PAD_A, PAD_B, PAD_DOWN, PAD_LEFT, PAD_RIGHT, PAD_SELECT, PAD_START, PAD_UP } from '../engine/pad';
import { c } from '../rom/constants';
import { encodePlain, tokenize } from './TextPrinter';

const CURSOR = 0xed; // ▶
const BLANK = 0x7f;

/**
 * JoypadLowSensitivity: a new press counts immediately; holding repeats
 * after 30 frames, then every 5 frames.
 */
export class LowSensitivity {
  private last = 0;
  private held = 0;
  /** Starts from the buttons held now (hJoyLast), so a press that opened this menu isn't seen again. */
  constructor(e?: Engine) {
    if (e) this.last = inputToPad(e.input, 'held');
  }
  read(e: Engine): number {
    const now = inputToPad(e.input, 'held');
    const fresh = now & ~this.last;
    this.last = now;
    if (fresh) {
      this.held = 0;
      return fresh;
    }
    if (!now) return 0;
    this.held++;
    if (this.held >= 30 && (this.held - 30) % 5 === 0) return now;
    return 0;
  }
}

/** Snapshot/restore of the UI layer (SaveScreenTilesToBuffer1 / LoadScreenTilesFromBuffer1). */
export function saveScreen(e: Engine): Int16Array {
  return e.screen.cells.slice();
}
export function restoreScreen(e: Engine, buf: Int16Array): void {
  e.screen.cells.set(buf);
  e.screen.markDirty();
}

export interface MenuSpec {
  topX: number;
  topY: number;
  maxItem: number;
  current: number;
  watchedKeys: number;
  /** Items are 2 rows apart (default) or 1 (single-spaced lists). */
  spacing?: number;
  /** wMenuWrappingEnabled (off unless a menu turns it on). */
  wrap?: boolean;
  /** wMenuWatchMovingOutOfBounds: return when moving past the top/bottom (scrolling lists). */
  exitOnBounds?: boolean;
  /** Called every frame while waiting (blinking arrows, animated party icons). */
  idle?: () => void;
}

/** HandleMenuInput: move the ▶ cursor until a watched key is pressed. Returns [item, key]. */
export function* handleMenuInput(e: Engine, m: MenuSpec): Co<[number, number]> {
  const js = new LowSensitivity(e);
  const sp = m.spacing ?? 2;
  let item = m.current;
  // PlaceMenuCursor: restore the tile behind the old cursor, save the one behind the new one
  const place = () => {
    const r = e.ram;
    if (r.menuCursorLoc) {
      const [ox, oy] = r.menuCursorLoc;
      if (e.screen.get(ox, oy) === CURSOR) e.screen.put(ox, oy, r.tileBehindCursor);
    }
    const x = m.topX;
    const y = m.topY + item * sp;
    const under = e.screen.get(x, y);
    r.tileBehindCursor = under === CURSOR || under < 0 ? BLANK : under;
    e.screen.put(x, y, CURSOR);
    r.menuCursorLoc = [x, y];
  };
  for (;;) {
    // .loop1
    place();
    yield;
    yield;
    yield;
    for (;;) {
      m.idle?.();
      const k = js.read(e);
      if (k) {
        let changed = false;
        if (!(k & PAD_A)) {
          if (k & PAD_UP) {
            if (item > 0) {
              item--;
              changed = true;
            } else if (m.wrap) {
              item = m.maxItem;
              changed = true;
            } else if (m.exitOnBounds) return [item, k];
          } else if (k & PAD_DOWN) {
            if (item < m.maxItem) {
              item++;
              changed = true;
            } else if (m.wrap) {
              item = 0;
              changed = true;
            } else if (m.exitOnBounds) return [item, k];
          }
        }
        const hit = k & m.watchedKeys;
        if (hit) {
          if (k & (PAD_A | PAD_B)) e.hooks.playSound?.('press_ab');
          return [item, k];
        }
        if (changed) break;
      }
      yield;
    }
  }
}

/** EraseMenuCursor */
export function eraseMenuCursor(e: Engine): void {
  if (!e.ram.menuCursorLoc) return;
  const [x, y] = e.ram.menuCursorLoc;
  e.screen.put(x, y, BLANK);
}

/** DisplayTwoOptionMenu at (x, y). Returns 0 for the first option, 1 for the second (B = second). */
export function* twoOptionMenu(e: Engine, menu: string, x: number, y: number, secondDefault = false): Co<number> {
  const id = c('menu', menu);
  const spec = e.bundle.ui.twoOptionMenus[id];
  const saved = saveScreen(e);
  e.screen.box(x, y, spec.height, spec.width);
  const rows = spec.text.split('{next}');
  const startY = y + (spec.blankLine ? 2 : 1);
  rows.forEach((r, i) => encodePlain(r).forEach((code, j) => e.screen.put(x + 2 + j, startY + i * 2, code)));
  const [item, key] = yield* handleMenuInput(e, {
    topX: x + 1,
    topY: startY,
    maxItem: 1,
    current: secondDefault ? 1 : 0,
    watchedKeys: PAD_A | PAD_B,
  });
  restoreScreen(e, saved);
  return key & PAD_B ? 1 : item;
}

export type NamingType = 'player' | 'rival' | 'mon';

/** DisplayNamingScreen. Returns the entered name ('' if submitted empty). */
export function* namingScreen(e: Engine, type: NamingType, monName = ''): Co<string> {
  const ui = e.bundle.ui;
  const scr = e.screen;
  const saved = saveScreen(e);
  const maxLen = type === 'mon' ? c('text', 'NAME_LENGTH') - 1 : c('text', 'PLAYER_NAME_LENGTH') - 1;
  // LoadHpBarAndStatusTilePatterns puts the HP bar tiles at $62-$7F; LoadEDTile puts ED at $F0.
  const hp = ui.hpBarAndStatus;
  for (let t = 0; t < hp.count && 0x62 + t <= 0x7f; t++) scr.setGlyphOverride(0x62 + t, hp.pixels.slice(t * 64, t * 64 + 64));
  scr.setGlyphOverride(0xf0, ui.edTile);
  scr.clear();
  scr.fill(0, 0, 20, 18, BLANK);
  scr.box(0, 4, 9, 18);
  // PrintNamingText
  const put = (x: number, y: number, s: string) => encodePlain(s).forEach((code, i) => scr.put(x + i, y, code));
  if (type === 'mon') {
    put(4, 1, monName);
    put(1, 3, 'NICKNAME?');
  } else {
    const head = type === 'player' ? 'YOUR ' : "RIVAL's ";
    put(0, 1, head + 'NAME?');
  }
  let lower = false;
  let name: number[] = [];
  let row = 1; // wCurrentMenuItem: 1..5 letter rows, 6 = case switch
  let col = 1; // wTopMenuItemX: 1,3,...,17
  const printAlphabet = () => {
    const a = lower ? ui.alphabets.lower : ui.alphabets.upper;
    for (let r = 0; r < 5; r++) for (let k = 0; k < 9; k++) scr.put(2 + k * 2, 5 + r * 2, a[r * 9 + k]);
    scr.fill(2, 15, 17, 1, BLANK);
    put(2, 15, lower ? ui.alphabets.lowerSwitch : ui.alphabets.upperSwitch);
  };
  const printName = () => {
    scr.fill(10, 2, 10, 1, BLANK);
    name.forEach((code, i) => scr.put(10 + i, 2, code));
    for (let i = 0; i < maxLen; i++) scr.put(10 + i, 3, 0x76);
    let raised = name.length;
    if (name.length === maxLen) {
      // all spaces filled: force the cursor onto ED and keep the last underscore raised
      col = 0x11;
      row = 5;
      raised = maxLen - 1;
    }
    scr.put(10 + raised, 3, 0x77);
  };
  const placeCursor = () => {
    for (let r = 1; r <= 6; r++) for (let k = 1; k <= 17; k += 2) scr.put(k, 3 + r * 2, BLANK);
    scr.put(row === 6 ? 1 : col, 3 + row * 2, CURSOR);
  };
  printAlphabet();
  printName();
  placeCursor();
  const js = new LowSensitivity(e);
  for (;;) {
    yield;
    const k = js.read(e);
    if (!k) continue;
    if (k & PAD_START) break;
    if (k & PAD_SELECT) {
      lower = !lower;
      printAlphabet();
      continue;
    }
    if (k & PAD_A) {
      if (row === 5 && col === 0x11) break; // ED
      if (row === 6) {
        lower = !lower;
        printAlphabet();
        continue;
      }
      const alpha = lower ? ui.alphabets.lower : ui.alphabets.upper;
      const letter = alpha[(row - 1) * 9 + (col - 1) / 2];
      if (name.length < maxLen) {
        name.push(letter);
        e.hooks.playSound?.('press_ab');
      }
      printName();
      placeCursor();
      continue;
    }
    if (k & PAD_B) {
      if (name.length) name = name.slice(0, -1);
      printName();
      placeCursor();
      continue;
    }
    if (k & PAD_RIGHT && row !== 6) col = col === 0x11 ? 1 : col + 2;
    else if (k & PAD_LEFT && row !== 6) col = col === 1 ? 0x11 : col - 2;
    else if (k & PAD_UP) {
      row--;
      if (row === 0) {
        row = 6;
        col = 1;
      }
    } else if (k & PAD_DOWN) {
      row++;
      if (row === 7) row = 1;
      else if (row === 6) col = 1;
    }
    placeCursor();
  }
  scr.clearGlyphOverrides();
  restoreScreen(e, saved);
  return decodeCodes(name);
}

/** Codes back to a display string (the inverse of encodePlain for name characters). */
export function decodeCodes(codes: number[]): string {
  const map = new Map<number, string>();
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789 ()-?!.,/:;[]×♂♀é¥') {
    const t = tokenize(ch);
    if ('code' in t[0]) map.set(t[0].code, ch);
  }
  map.set(0xe1, '<PK>');
  map.set(0xe2, '<MN>');
  map.set(0xf2, '.');
  return codes.map((x) => map.get(x) ?? '').join('');
}
