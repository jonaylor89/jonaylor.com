/**
 * StatusScreen / StatusScreen2 (engine/pokemon/status_screen.asm): the two
 * pages shown for STATS in the party menu (and from the PC).
 */
import type { Co, Engine } from '../engine/Engine';
import type { PartyMon } from '../game/state';
import { calcExperience, calcStats, movePP, species } from '../game/pokemon';
import { encodePlain } from './TextPrinter';
import { picPixels } from '../rom/extract/pics';
import { statusString, BattleUI } from '../battle/BattleUI';
import { isStarterPikachu } from '../game/pikachu';
import { printStatsBox } from '../battle/experience';
import { PP_MASK } from '../battle/state';
import { playPikachuCry, pikachuCry } from '../engine/pikachuEmotions';

const put = (e: Engine, x: number, y: number, s: string) => {
  let cy = y;
  for (const line of s.split('{next}')) {
    encodePlain(line).forEach((code, i) => e.screen.put(x + i, cy, code));
    cy += 2;
  }
};

/** Shows both pages for `party[which]`; `box` recalculates stats from the box level. */
export function* statusScreen(e: Engine, party: PartyMon[], which: number, box = false): Co {
  const s = e.screen;
  const saved = s.cells.slice();
  const pm = structuredClone(party[which]);
  const sp = species(e.bundle, pm.species);
  if (box) {
    pm.level = pm.boxLevel || pm.level;
    Object.assign(pm, calcStats(sp, pm.dvs, pm.statExp, pm.level, true));
  }
  loadTiles(e);
  s.setObjects([]);
  s.clear();
  s.fill(0, 0, 20, 18, 0x7f);
  // page 1
  drawLineBox(e, 19, 1, 6, 10);
  // DrawLineBox leaves hl on the half arrow at (8,7); -6 → <DOT> at (2,7), then № at (1,7)
  s.put(2, 7, 0xf2);
  s.put(1, 7, 0x74);
  drawLineBox(e, 19, 9, 8, 6);
  put(e, 10, 9, 'TYPE1/{next}TYPE2/');
  s.put(10, 13, 0x73); // <ID>
  s.put(11, 13, 0x74); // №
  put(e, 12, 13, '/');
  put(e, 10, 15, 'OT/');
  drawHP(e, pm, 11, 3);
  const st = pm.hp ? statusString(pm.status) : 'FNT';
  put(e, 16, 6, st || 'OK');
  put(e, 9, 6, 'STATUS/');
  printLevel(e, 14, 2, pm.level, false);
  put(e, 3, 7, String(sp.dex).padStart(3, '0'));
  printMonType(e, sp, 11, 10);
  put(e, 9, 1, pm.nickname);
  put(e, 12, 16, pm.otName);
  put(e, 12, 14, String(pm.otId).padStart(5, '0'));
  // PrintStatsBox with STATUS_SCREEN_STATS_BOX: box at (0,8), stats at (1,9)
  s.box(0, 8, 8, 8);
  ['ATTACK', 'DEFENSE', 'SPEED', 'SPECIAL'].forEach((l, i) => {
    put(e, 1, 9 + i * 2, l);
    put(e, 6, 10 + i * 2, String([pm.atk, pm.def, pm.spd, pm.spc][i]).padStart(3, ' '));
  });
  yield* e.delayFrames(3);
  drawFlippedPic(e, pm.species, 1, 0);
  if (isStarterPikachu(e.state, party[which])) yield* playPikachuCry(e, pikachuCry(17));
  else e.hooks.playCry?.(pm.species);
  yield* e.waitForTextScrollButtonPress();
  // page 2
  s.fill(9, 2, 10, 5, 0x7f);
  s.put(19, 3, 0x78);
  s.box(0, 8, 8, 18);
  for (let i = 0; i < 4; i++) {
    const m = pm.moves[i];
    put(e, 2, 9 + i * 2, m ? e.bundle.moves[m - 1].name : '-');
  }
  const known = pm.moves.filter((m) => m).length;
  for (let i = 0; i < 4; i++) {
    if (i < known) s.put(11, 10 + i * 2, 0x72);
    else s.put(11, 10 + i * 2, 0xe3); // '-'
    if (i < known) s.put(12, 10 + i * 2, 0x72);
    else s.put(12, 10 + i * 2, 0xe3);
  }
  for (let i = 0; i < known; i++) {
    const base = movePP(e.bundle, pm.moves[i]);
    const ups = pm.pp[i] >> 6;
    const max = base + Math.min(Math.floor(base / 5), 7) * ups;
    put(e, 14, 10 + i * 2, `${String(pm.pp[i] & PP_MASK).padStart(2, ' ')}/${String(max).padStart(2, ' ')}`);
  }
  put(e, 9, 3, 'EXP POINTS{next}LEVEL UP');
  s.put(14, 6, 0x70); // <to>
  printLevel(e, 16, 6, pm.level >= 100 ? pm.level : pm.level + 1, false);
  put(e, 12, 4, String(pm.exp).padStart(7, ' '));
  const toNext = pm.level >= 100 ? 0 : calcExperience(e.bundle, sp.growthRate, pm.level + 1) - pm.exp;
  put(e, 7, 6, String(toNext & 0xffffff).padStart(7, ' '));
  s.fill(9, 0, 10, 1, 0x7f);
  s.fill(9, 1, 10, 1, 0x7f);
  put(e, 9, 1, sp.name);
  yield* e.delayFrames(3);
  yield* e.waitForTextScrollButtonPress();
  s.clearGlyphOverrides();
  s.cells.set(saved);
  s.markDirty();
}

function loadTiles(e: Engine): void {
  const s = e.screen;
  const hp = e.bundle.ui.hpBarAndStatus;
  for (let t = 0; t < hp.count && 0x62 + t <= 0x7f; t++) s.setGlyphOverride(0x62 + t, hp.pixels.slice(t * 64, t * 64 + 64));
  const b = e.bundle.battle;
  for (let t = 0; t < 3; t++) s.setGlyphOverride(0x6d + t, b.hudTiles1.slice(t * 64, t * 64 + 64));
  s.setGlyphOverride(0x78, b.hudTiles23.slice(0, 64));
  s.setGlyphOverride(0x76, b.hudTiles23.slice(3 * 64, 4 * 64));
  s.setGlyphOverride(0x77, b.hudTiles23.slice(4 * 64, 5 * 64));
  s.setGlyphOverride(0x72, b.pTile);
  // the "to", <ID> and № glyphs come from the text box tiles
  const fx = e.bundle.ui.fontExtra;
  for (const code of [0x70, 0x73, 0x74]) {
    const i = code - fx.firstChar!;
    s.setGlyphOverride(code, fx.pixels.slice(i * 64, i * 64 + 64));
  }
}

/** DrawLineBox: a vertical line down from (x,y), then a line left ending in the half arrow. */
function drawLineBox(e: Engine, x: number, y: number, h: number, w: number): void {
  const s = e.screen;
  for (let i = 0; i < h; i++) s.put(x, y + i, 0x78);
  s.put(x, y + h, 0x77);
  for (let i = 1; i <= w; i++) s.put(x - i, y + h, 0x76);
  s.put(x - w - 1, y + h, 0x6f);
}

/** DrawHP (status screen style: fraction below the bar). */
function drawHP(e: Engine, pm: PartyMon, x: number, y: number): void {
  const s = e.screen;
  const px = pm.hp ? BattleUI.barPixels(pm.hp, pm.maxHp) : 0;
  s.put(x, y, 0x71);
  s.put(x + 1, y, 0x62);
  for (let i = 0; i < 6; i++) s.put(x + 2 + i, y, 0x63);
  s.put(x + 8, y, 0x6d);
  let rest = px || (pm.hp ? 1 : 0);
  for (let i = 0; rest > 0 && i < 6; i++) {
    if (rest >= 8) {
      s.put(x + 2 + i, y, 0x6b);
      rest -= 8;
    } else {
      s.put(x + 2 + i, y, 0x63 + rest);
      rest = 0;
    }
  }
  put(e, x + 1, y + 1, `${String(pm.hp).padStart(3, ' ')}/${String(pm.maxHp).padStart(3, ' ')}`);
}

function printLevel(e: Engine, x: number, y: number, level: number, full: boolean): void {
  if (level >= 100 && !full) {
    put(e, x, y, String(level));
    return;
  }
  e.screen.put(x, y, 0x6e);
  put(e, x + 1, y, String(level));
}

/** PrintMonType: TYPE1, then TYPE2 two rows below (or erase "TYPE2/" for single-typed mons). */
export function printMonType(e: Engine, sp: { types: [number, number] }, x: number, y: number): void {
  const names = e.bundle.types.names;
  put(e, x, y, names[sp.types[0]] ?? '');
  if (sp.types[0] === sp.types[1]) {
    e.screen.fill(x - 1, y + 1, 6, 1, 0x7f);
    return;
  }
  put(e, x, y + 2, names[sp.types[1]] ?? '');
}

/** LoadFlippedFrontSpriteByMonIndex at (x,y). */
export function drawFlippedPic(e: Engine, sp: number, x: number, y: number): void {
  const pic = e.bundle.pics.front[sp];
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
      e.screen.setGlyphOverride(0x100 + ty * 7 + tx, tile);
      e.screen.put(x + tx, y + ty, 0x100 + ty * 7 + tx);
    }
}

export { printStatsBox };
