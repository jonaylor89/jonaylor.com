/**
 * The party menu: DisplayPartyMenu / GoBackToPartyMenu / PartyMenuInit /
 * HandlePartyMenuInput (home/pokemon.asm), DrawPartyMenu_ / RedrawPartyMenu_
 * (engine/menus/party_menu.asm), the party icons (engine/gfx/mon_icons.asm)
 * and SwitchPartyMon (engine/menus/start_sub_menus.asm).
 */
import { withoutTextAsm } from '../rom/text';
import type { Co, Engine } from '../engine/Engine';
import type { PartyMon } from '../game/state';
import type { Battle } from '../battle/Battle';
import { PAD_A, PAD_B } from '../engine/pad';
import { encodePlain } from './TextPrinter';
import { handleMenuInput } from './menus';
import { species } from '../game/pokemon';
import { statusString, BattleUI } from '../battle/BattleUI';
import { isStarterPikachu } from '../game/pikachu';

export type PartyMenuMode = 'normal' | 'item' | 'battle' | 'tm' | 'swap' | 'stone';

export interface PartyMenuOptions {
  party: PartyMon[];
  mode: PartyMenuMode;
  battle?: Battle;
  /** TM/HM being taught (ABLE / NOT ABLE). */
  tmMove?: number;
  /** Evolution stone being used (ABLE / NOT ABLE). */
  stone?: number;
  /** wMenuItemToSwap (1-based): the mon picked first in SWITCH mode. */
  swapFrom?: number;
  /** A message to show instead of the mode's prompt (item-use results). */
  message?: { label: string; mem?: Record<number, string | number> };
}

const ICON_BASE = 0x400;
const MODE_TEXT: Record<PartyMenuMode, string> = {
  normal: '_PartyMenuNormalText',
  item: '_PartyMenuItemUseText',
  battle: '_PartyMenuBattleText',
  tm: '_PartyMenuUseTMText',
  swap: '_PartyMenuSwapMonText',
  stone: '_PartyMenuItemUseText',
};

/** DisplayPartyMenu: returns the chosen party index, or undefined on B / empty party. */
export function* partyMenu(e: Engine, o: PartyMenuOptions): Co<number | undefined> {
  loadIconTiles(e);
  e.screen.clear();
  e.screen.fill(0, 0, 20, 18, 0x7f);
  return yield* goBackToPartyMenu(e, o);
}

/** GoBackToPartyMenu: redraw and handle input again. */
export function* goBackToPartyMenu(e: Engine, o: PartyMenuOptions): Co<number | undefined> {
  for (;;) {
    yield* redrawPartyMenu(e, o);
    const max = Math.max(0, o.party.length - 1);
    let keys = PAD_A | PAD_B;
    if (o.battle?.forcePlayerToChooseMon) {
      o.battle.forcePlayerToChooseMon = 0;
      keys = PAD_A;
    }
    let anim = 0;
    const [item, key] = yield* handleMenuInput(e, {
      topX: 0,
      topY: 1,
      maxItem: max,
      current: Math.min(e.ram.partySavedMenuItem, max),
      watchedKeys: keys,
      wrap: true,
      idle: () => {
        anim = animatePartyMon(e, o.party, cursorItem(e), anim);
      },
    });
    e.ram.partySavedMenuItem = item;
    e.screen.setObjects(iconObjects(e, o.party, -1, 0));
    if (!(key & PAD_B) && isStarterPikachu(e.state, o.party[item]) && e.ram.pikachuOverworldStateFlags & 2) {
      yield* e.printText('_SleepingPikachuText1');
      return undefined;
    }
    e.screen.put(0, 1 + item * 2, 0xec); // PlaceUnfilledArrowMenuCursor
    if (key & PAD_B || !o.party.length) return undefined;
    return item;
  }
}

function cursorItem(e: Engine): number {
  const loc = e.ram.menuCursorLoc;
  return loc ? (loc[1] - 1) >> 1 : 0;
}

/** RedrawPartyMenu_ */
export function* redrawPartyMenu(e: Engine, o: PartyMenuOptions): Co {
  const s = e.screen;
  // ErasePartyMenuCursors + clear the entries
  for (let row = 0; row < 12; row++) s.fill(0, row, 20, 1, 0x7f);
  o.party.forEach((pm, i) => {
    const y = i * 2;
    put(e, 3, y, pm.nickname);
    if (o.swapFrom && o.swapFrom - 1 === i) s.put(0, y, 0xec);
    if (o.mode === 'tm' || o.mode === 'stone') {
      const able = o.mode === 'tm' ? canLearnTM(e, pm.species, o.tmMove ?? 0) : canUseStone(e, pm.species, o.stone ?? 0);
      put(e, 3 + 9, y + 1, able ? 'ABLE' : 'NOT ABLE');
    } else {
      // PrintStatusCondition at +14 (FNT when fainted)
      const st = pm.hp ? statusString(pm.status) : 'FNT';
      if (st) put(e, 3 + 14, y, st);
      drawHP2(e, pm, 4, y + 1);
    }
    // PrintLevel at +10
    if (pm.level >= 100) put(e, 13, y, String(pm.level));
    else {
      s.put(13, y, 0x6e);
      put(e, 14, y, String(pm.level));
    }
  });
  s.setObjects(iconObjects(e, o.party, -1, 0));
  // .printMessage (no text delay)
  const msg = o.message;
  const label = msg?.label ?? MODE_TEXT[o.mode];
  const mem = msg?.mem;
  const ops = withoutTextAsm(e.bundle.texts[label]!);
  const savedDelay = e.ram.noTextDelay;
  e.ram.noTextDelay = true;
  yield* e.printOps(ops, mem ? { ram: (l, a) => (a !== undefined && a in mem ? mem[a] : e.ramValue(l, a)) } : undefined);
  e.ram.noTextDelay = savedDelay;
  o.message = undefined;
  yield* frames(3);
}

/** DrawHP2: HP bar with the fraction to its right (party menu style). */
function drawHP2(e: Engine, pm: PartyMon, x: number, y: number): void {
  const ui = e.screen;
  const px = pm.hp ? BattleUI.barPixels(pm.hp, pm.maxHp) : 0;
  ui.put(x, y, 0x71);
  ui.put(x + 1, y, 0x62);
  for (let i = 0; i < 6; i++) ui.put(x + 2 + i, y, 0x63);
  ui.put(x + 8, y, 0x6c);
  let rest = px || (pm.hp ? 1 : 0);
  for (let i = 0; rest > 0 && i < 6; i++) {
    if (rest >= 8) {
      ui.put(x + 2 + i, y, 0x6b);
      rest -= 8;
    } else {
      ui.put(x + 2 + i, y, 0x63 + rest);
      rest = 0;
    }
  }
  put(e, x + 9, y, `${String(pm.hp).padStart(3, ' ')}/${String(pm.maxHp).padStart(3, ' ')}`);
}

/** CanLearnTM: the species' TM/HM bit for the move. */
export function canLearnTM(e: Engine, sp: number, move: number): boolean {
  const tmMoves = e.bundle.tmMoves;
  const idx = tmMoves.indexOf(move);
  if (idx < 0) return false;
  return species(e.bundle, sp).tmhm.includes(idx + 1);
}

/** The evolution stone check of RedrawPartyMenu_. */
export function canUseStone(e: Engine, sp: number, stone: number): boolean {
  return species(e.bundle, sp).evolutions.some((ev) => ev.method === 'item' && ev.item === stone);
}

// ------------------------------------------------------------ icons
function loadIconTiles(e: Engine): void {
  const t = e.bundle.ui.partyIcons.tiles;
  for (let i = 0; i < 128; i++) e.screen.setGlyphOverride(ICON_BASE + i, t.slice(i * 64, i * 64 + 64));
  // x-flipped copies for the symmetric halves
  for (let i = 0; i < 128; i++) {
    const src = t.slice(i * 64, i * 64 + 64);
    const flipped = new Array<number>(64);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) flipped[y * 8 + x] = src[y * 8 + 7 - x];
    e.screen.setGlyphOverride(ICON_BASE + 0x80 + i, flipped);
  }
}

const ICON_BALL = 1;
const ICON_HELIX = 2;
const ICONOFFSET = 0x40;

/** WriteMonPartySpriteOAM for every party mon; `frame2` selects the alternate frame for one mon. */
function iconObjects(e: Engine, party: PartyMon[], frame2Index: number, bounce: number): { x: number; y: number; code: number }[] {
  const out: { x: number; y: number; code: number }[] = [];
  party.forEach((pm, i) => {
    const icon = e.bundle.ui.partyIcons.byDex[species(e.bundle, pm.species).dex - 1];
    let base = icon << 2;
    const alt = i === frame2Index;
    let dy = 0;
    if (alt) {
      if (icon === ICON_BALL || icon === ICON_HELIX) dy = bounce;
      else base += ICONOFFSET;
    }
    const y = i * 16 + dy;
    const x = 8;
    if (icon === ICON_HELIX) {
      out.push({ x, y, code: ICON_BASE + base }, { x: x + 8, y, code: ICON_BASE + base + 1 });
      out.push({ x, y: y + 8, code: ICON_BASE + base + 2 }, { x: x + 8, y: y + 8, code: ICON_BASE + base + 3 });
    } else {
      out.push({ x, y, code: ICON_BASE + base }, { x: x + 8, y, code: ICON_BASE + 0x80 + base });
      out.push({ x, y: y + 8, code: ICON_BASE + base + 2 }, { x: x + 8, y: y + 8, code: ICON_BASE + 0x80 + base + 2 });
    }
  });
  return out;
}

/** AnimatePartyMon: the selected mon's icon alternates at a speed set by its HP bar color. */
function animatePartyMon(e: Engine, party: PartyMon[], item: number, counter: number): number {
  const pm = party[item];
  if (!pm) return counter;
  const px = BattleUI.barPixels(pm.hp, pm.maxHp);
  const color = px >= 27 ? 0 : px >= 10 ? 1 : 2;
  const speeds = [5, 16, 32];
  const c = speeds[color]; // + (wOnSGB xor 1): 0 on SGB/GBC
  const period = c * 2;
  let next = counter;
  if (counter === 0) e.screen.setObjects(iconObjects(e, party, -1, 0));
  else if (counter === c) e.screen.setObjects(iconObjects(e, party, item, 1));
  next = (counter + 1) % period;
  return next;
}

/** SwitchPartyMon: exchange two party slots (the caller handles the menu flow). */
export function switchPartyMon(party: PartyMon[], a: number, b: number): void {
  [party[a], party[b]] = [party[b], party[a]];
}

const put = (e: Engine, x: number, y: number, s: string) =>
  encodePlain(s.replace(/\{poke\}/g, 'POKé')).forEach((code, i) => e.screen.put(x + i, y, code));

function* frames(n: number): Co {
  for (let i = 0; i < n; i++) yield;
}
