/**
 * DisplayListMenuID (home/list_menu.asm): the scrolling item/Pokémon/move
 * list with CANCEL at the end, item swapping with SELECT
 * (HandleItemListSwapping, engine/menus/swap_items.asm) and the quantity
 * chooser (DisplayChooseQuantityMenu).
 */
import type { Co, Engine } from '../engine/Engine';
import type { ItemSlot } from '../game/state';
import { PAD_A, PAD_B, PAD_DOWN, PAD_SELECT, PAD_UP } from '../engine/pad';
import { itemData } from '../game/pokemon';
import { encodePlain, formatBCD } from './TextPrinter';
import { handleMenuInput, LowSensitivity } from './menus';

/** 'special' is SPECIALLISTMENU: names only (elevator floors). */
export type ListMenuKind = 'items' | 'priced' | 'moves' | 'pcmons' | 'special';

export interface ListEntry {
  /** Item id, move id or species. */
  id: number;
  qty?: number;
  /** Name shown for Pokémon lists (nickname). */
  name?: string;
  level?: number;
}

export interface ListMenuOptions {
  kind: ListMenuKind;
  /** The list being shown; for 'items' it is edited in place by SELECT swapping. */
  entries: ListEntry[];
  /** wCurrentMenuItem / wListScrollOffset to start from (updated on return). */
  cursor: { item: number; scroll: number };
  /** Simulated input (Old Man / Prof. Oak battles): pick the first entry after 20 frames. */
  simulated?: boolean;
  /** Called after SELECT swapped entries (to write the bag back). */
  onSwap?: (entries: ListEntry[]) => void;
}

export interface ListChoice {
  index: number;
  entry: ListEntry;
}

const put = (e: Engine, x: number, y: number, s: string) => encodePlain(s).forEach((code, i) => e.screen.put(x + i, y, code));

/** Returns the chosen entry, or undefined when cancelled (B or CANCEL). */
export function* displayListMenu(e: Engine, o: ListMenuOptions): Co<ListChoice | undefined> {
  const list = o.entries;
  // LIST_MENU_BOX
  e.screen.box(4, 2, 9, 14);
  let maxItem = list.length < 2 ? 1 : 2;
  let swap = 0; // wMenuItemToSwap (1-based)
  yield* frames(10);
  for (;;) {
    printEntries(e, o, swap);
    yield* frames(3);
    let item: number;
    let key: number;
    if (o.simulated) {
      e.screen.put(5, 4, 0xed);
      yield* frames(20);
      item = 0;
      key = PAD_A;
    } else {
      [item, key] = yield* handleMenuInput(e, {
        topX: 5,
        topY: 4,
        maxItem,
        current: Math.min(o.cursor.item, maxItem),
        watchedKeys: PAD_A | PAD_B | PAD_SELECT,
        exitOnBounds: true,
        idle: () => blinkArrow(e),
      });
    }
    o.cursor.item = item;
    if (key & PAD_A) {
      e.screen.put(5, 4 + item * 2, 0xec); // PlaceUnfilledArrowMenuCursor
      const idx = o.cursor.scroll + item;
      if (!list.length || idx > list.length - 1) return undefined;
      return { index: idx, entry: list[idx] };
    }
    if (key & PAD_B) return undefined;
    if (key & PAD_SELECT) {
      if (o.kind !== 'items') continue;
      const idx = o.cursor.scroll + item;
      if (idx >= list.length) continue; // CANCEL can't be swapped
      if (!swap) {
        swap = idx + 1;
        yield* frames(20);
        continue;
      }
      if (swap === idx + 1) continue;
      const first = swap - 1;
      swap = 0;
      yield* frames(20);
      const a = list[first];
      const b = list[idx];
      if (a.id === b.id) {
        const sum = (a.qty ?? 0) + (b.qty ?? 0);
        if (sum >= 100) {
          a.qty = sum - 99;
          b.qty = 99;
        } else {
          b.qty = sum;
          list.splice(first, 1);
          if (list.length === 1) maxItem = 1;
          o.cursor.scroll = 0;
          o.cursor.item = 0;
        }
      } else {
        list[first] = b;
        list[idx] = a;
      }
      o.onSwap?.(list);
      continue;
    }
    if (key & PAD_DOWN) {
      if (o.cursor.scroll + 3 <= list.length) o.cursor.scroll++;
    } else if (key & PAD_UP) {
      if (o.cursor.scroll) o.cursor.scroll--;
    }
  }
}

let blink = 0;
function blinkArrow(e: Engine): void {
  // HandleDownArrowBlinkTiming at (18,11) when the ▼ is shown
  const v = e.screen.get(18, 11);
  if (v !== 0xee && v !== 0x7f) return;
  blink = (blink + 1) % 64;
  if (v === 0xee && blink === 0) e.screen.put(18, 11, 0x7f);
  else if (v === 0x7f && blink === 32) e.screen.put(18, 11, 0xee);
}

/** PrintListMenuEntries */
function printEntries(e: Engine, o: ListMenuOptions, swap: number): void {
  const s = e.screen;
  s.fill(5, 3, 14, 9, 0x7f);
  const b = e.bundle;
  for (let row = 0; row < 4; row++) {
    const idx = o.cursor.scroll + row;
    const y = 4 + row * 2;
    if (idx >= o.entries.length) {
      put(e, 6, y, 'CANCEL');
      return;
    }
    const en = o.entries[idx];
    if (o.kind === 'pcmons') {
      put(e, 6, y, en.name ?? '');
      s.put(6 + 8, y + 1, 0x6e);
      put(e, 6 + 9, y + 1, String(en.level ?? 0));
    } else if (o.kind === 'moves') put(e, 6, y, b.moves[en.id - 1]?.name ?? '');
    else {
      const it = itemData(b, en.id);
      put(e, 6, y, it.name);
      if (o.kind === 'priced') put(e, 6 + 5, y + 1, formatBCD(it.price, 3 | 0x80 | 0x20));
      if (o.kind === 'items' && !it.isKey) {
        s.put(6 + 8, y + 1, 0xf1); // ×
        put(e, 6 + 9, y + 1, String(en.qty ?? 0).padStart(2, ' '));
      }
    }
    if (swap && swap === idx + 1) s.put(5, y, 0xec);
  }
  s.put(18, 11, 0xee); // ▼
}

/** Bag slots → list entries (shared objects so swapping edits the bag order). */
export function bagEntries(bag: ItemSlot[]): ListEntry[] {
  return bag.map((sl) => ({ id: sl.item, qty: sl.qty }));
}

export function entriesToBag(list: ListEntry[]): ItemSlot[] {
  return list.map((en) => ({ item: en.id, qty: en.qty ?? 0 }));
}

/**
 * DisplayChooseQuantityMenu: ×01 that wraps between 1 and max; returns the
 * quantity, or undefined on B. With `unitPrice`, shows the total price
 * (halved when selling).
 */
export function* chooseQuantity(e: Engine, max: number, unitPrice?: number, halve = false): Co<number | undefined> {
  const s = e.screen;
  const priced = unitPrice !== undefined;
  if (priced) s.box(7, 9, 1, 11);
  else s.box(15, 9, 1, 3);
  let q = 1;
  const draw = () => {
    if (priced) {
      let total = unitPrice * q;
      if (halve) total = Math.floor(total / 2);
      put(e, 12, 10, '      ');
      put(e, 12, 10, formatBCD(total, 3 | 0x80 | 0x20));
      s.put(8, 10, 0xf1);
      put(e, 9, 10, String(q).padStart(2, '0'));
    } else {
      s.put(16, 10, 0xf1);
      put(e, 17, 10, String(q).padStart(2, '0'));
    }
  };
  draw();
  const js = new LowSensitivity(e);
  for (;;) {
    yield;
    const k = js.read(e);
    if (k & PAD_A) return q;
    if (k & PAD_B) return undefined;
    if (k & PAD_UP) {
      q = q + 1 > max ? 1 : q + 1;
      draw();
    } else if (k & PAD_DOWN) {
      q = q - 1 < 1 ? max : q - 1;
      draw();
    }
  }
}

function* frames(n: number): Co {
  for (let i = 0; i < n; i++) yield;
}
