/**
 * The Game Boy Printer jobs (engine/printer/printer.asm, printer2.asm) as they
 * run with no printer attached: the link check reads $FF, so
 * GBPrinter_CheckForErrors reports Printer Error 2 until B cancels the job
 * (hCanceledPrinting = 1). The job's own screen is drawn first, as the original
 * draws it before transmitting.
 */
import type { Co, Engine } from '../engine/Engine';
import type { PartyMon } from '../game/state';
import { PAD_B } from '../engine/pad';
import { LowSensitivity } from './menus';
import { encodePlain } from './TextPrinter';
import { picPixels } from '../rom/extract/pics';
import { species as speciesData } from '../game/pokemon';

const put = (e: Engine, x: number, y: number, s: string) => encodePlain(s).forEach((code, i) => e.screen.put(x + i, y, code));

/** LoadFlippedFrontSpriteByMonIndex: the front pic, mirrored, in the 7x7 tiles at (x, y). */
export function drawFlippedFrontPic(e: Engine, speciesIndex: number, x: number, y: number, base = 0x100): void {
  const s = e.screen;
  const pic = e.bundle.pics.front[speciesIndex];
  if (!pic) return;
  const W = pic.width * 8;
  const src = picPixels(pic);
  const ox = (7 - pic.width) >> 1;
  const oy = 7 - pic.width;
  for (let ty = 0; ty < 7; ty++)
    for (let tx = 0; tx < 7; tx++) {
      const tile = new Array<number>(64).fill(0);
      for (let yy = 0; yy < 8; yy++)
        for (let xx = 0; xx < 8; xx++) {
          const px = tx * 8 + xx - ox * 8;
          const py = ty * 8 + yy - oy * 8;
          if (px >= 0 && py >= 0 && px < W && py < W) tile[yy * 8 + xx] = src[py * W + (W - 1 - px)];
        }
      s.setGlyphOverride(base + ty * 7 + tx, tile);
      s.put(x + tx, y + ty, base + ty * 7 + tx);
    }
}

/**
 * The transmission loop with no printer: the printer music, then the status box
 * (Printer Error 2) until B is pressed. Returns hCanceledPrinting (always 1 here).
 */
export function* printerJob(e: Engine): Co<boolean> {
  const str = e.bundle.strings;
  e.playMusic('MUSIC_GB_PRINTER');
  e.screen.box(0, 5, 10, 18);
  put(e, 1, 7, str['GBPrinter_UpdateStatusMessage.Error2']);
  put(e, 2, 15, str['GBPrinter_UpdateStatusMessage.PressBToCancel']);
  const js = new LowSensitivity(e);
  for (;;) {
    yield;
    if (js.read(e) & PAD_B) break;
  }
  e.playDefaultMusic(); // Printer_PlayMapMusic
  return true;
}

/** Printer_GetMonStats: the stat card the Fan Club chairman prints. */
export function drawMonStatsCard(e: Engine, mon: PartyMon): void {
  const s = e.screen;
  const b = e.bundle;
  const str = b.strings;
  const t = b.ui.printerGlyphs;
  s.clear();
  s.fill(0, 0, 20, 18, 0x7f);
  // the HP and Lv glyphs this screen loads over $71 / $6e
  s.setGlyphOverride(0x71, t.hp);
  s.setGlyphOverride(0x6e, t.lv);
  s.box(0, 0, 16, 18);
  s.box(0, 12, 4, 18);
  // PrintLevelFull at (3,10), then the Lv glyph moved to (2,10) and the HP glyph ('’') at (2,11)
  put(e, 4, 10, String(mon.level));
  s.put(2, 10, 0x6e);
  s.put(3, 10, 0x7f);
  s.put(2, 11, 0x71);
  put(e, 4, 11, String(mon.maxHp).padStart(3, ' '));
  put(e, 8, 2, mon.nickname);
  const sp = speciesData(b, mon.species);
  put(e, 9, 3, sp.name);
  s.put(2, 8, 0x74); // №
  s.put(3, 8, 0xf2); // <DOT>
  put(e, 4, 8, String(sp.dex).padStart(3, '0'));
  put(e, 8, 4, str['Printer_GetMonStats.OT']);
  put(e, 9, 5, mon.otName);
  // .IDNo: "<ID>№/"
  s.put(9, 6, 0x73);
  s.put(10, 6, 0x74);
  put(e, 11, 6, '/');
  put(e, 13, 6, String(mon.otId).padStart(5, '0'));
  str['Printer_GetMonStats.Stats'].split('{next}').forEach((line, i) => put(e, 9, 8 + i, line)); // single-spaced
  [mon.atk, mon.def, mon.spd, mon.spc].forEach((v, i) => put(e, 16, 8 + i, String(v).padStart(3, ' ')));
  mon.moves.forEach((mv, i) => put(e, 1, 13 + i, mv ? b.moves[mv - 1].name : str['Printer_GetMonStats.Blank']));
  drawFlippedFrontPic(e, mon.species, 1, 1);
}

/** PrintFanClubPortrait: the card, then the (failing) transmission. */
export function* printFanClubPortrait(e: Engine, mon: PartyMon): Co<boolean> {
  drawMonStatsCard(e, mon);
  return yield* printerJob(e);
}
