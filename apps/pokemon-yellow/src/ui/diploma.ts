/**
 * The Pokédex diploma (engine/events/diploma.asm, diploma2.asm): DisplayDiploma
 * shows the top page; PrintDiploma sends both pages to the Game Boy Printer
 * (which, with none attached, stops at Printer Error 2 until B).
 */
import type { Co, Engine } from '../engine/Engine';
import { encodePlain } from './TextPrinter';
import { restoreScreen, saveScreen } from './menus';
import { printerJob } from './printer';
import { c } from '../rom/constants';

const W = 20;
const H = 18;

function loadDiplomaTiles(e: Engine): void {
  const t = e.bundle.ui.diploma.tiles;
  for (let i = 0; i < t.length / 64; i++) e.screen.setGlyphOverride(i, t.slice(i * 64, i * 64 + 64));
}

/** PlaceString with `{next}` moving down two rows. */
function place(e: Engine, x: number, y: number, s: string): void {
  s.split('{next}').forEach((line, i) => encodePlain(line).forEach((code, j) => e.screen.put(x + j, y + i * 2, code)));
}

/** DiplomaDrawHorizontalBorder / DiplomaDrawVerticalBorder */
function borders(e: Engine, topRow: number): void {
  const s = e.screen;
  for (let x = 0; x < W; x++) s.put(x, topRow, x & 1 ? 0x01 : 0x02);
  for (let y = 0; y < H; y++) {
    s.put(0, y, y & 1 ? 0x03 : 0x04);
    s.put(W - 1, y, y & 1 ? 0x03 : 0x04);
  }
  s.put(0, topRow, 0x00);
  s.put(W - 1, topRow, 0x00);
}

/** DisplayDiplomaTop */
export function drawDiplomaTop(e: Engine): void {
  const d = e.bundle.ui.diploma;
  const s = e.screen;
  s.clear();
  s.fill(0, 0, W, H, 0x7f);
  loadDiplomaTiles(e);
  borders(e, 0);
  d.title.filter((code) => code !== 0x50).forEach((code, i) => s.put(5 + i, 2, code));
  place(e, 3, 4, d.player);
  place(e, 10, 4, e.state.player.name);
  place(e, 2, 6, d.congrats);
  place(e, 9, 16, d.gameFreak);
  e.hooks.palette?.(c('palette', 'PAL_MEWMON')); // SET_PAL_GENERIC
}

/** DisplayDiplomaBottom (only reached when the printer accepted the first page) */
export function drawDiplomaBottom(e: Engine, ownedCount: number): void {
  const d = e.bundle.ui.diploma;
  const s = e.screen;
  s.clear();
  s.fill(0, 0, W, H, 0x7f);
  loadDiplomaTiles(e);
  borders(e, 17);
  const box = (map: number[], x: number, y: number, h: number, w: number) => {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) s.put(x + i, y + j, map[j * w + i]);
  };
  box(d.pikachuMap, 6, 2, 10, 12);
  box(d.congratulations, 5, 13, 1, 11);
  place(e, 2, 15, d.playTime);
  const minutes = Math.floor(e.state.frames / 3600);
  place(e, 12, 15, String(Math.min(Math.floor(minutes / 60), 255)));
  const hx = 12 + String(Math.min(Math.floor(minutes / 60), 255)).length;
  s.put(hx, 15, 0x16); // colon
  place(e, hx + 1, 15, String(minutes % 60).padStart(2, '0'));
  if (ownedCount === 151) box(d.mewMap, 2, 0, 4, 5);
}

/** DisplayDiploma: the top page until a button press. */
export function* displayDiploma(e: Engine): Co {
  const saved = saveScreen(e);
  e.ram.noTextDelay = true;
  drawDiplomaTop(e);
  yield* e.waitForTextScrollButtonPress();
  e.ram.noTextDelay = false;
  e.screen.clearGlyphOverrides();
  restoreScreen(e, saved);
  e.hooks.palette?.(undefined);
}

/** PrintDiploma: returns hCanceledPrinting. */
export function* printDiploma(e: Engine): Co<boolean> {
  drawDiplomaTop(e);
  const canceled = yield* printerJob(e);
  e.screen.clearGlyphOverrides();
  e.hooks.palette?.(undefined);
  return canceled;
}
