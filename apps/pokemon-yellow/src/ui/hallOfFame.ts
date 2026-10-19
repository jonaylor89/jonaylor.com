/**
 * The Hall of Fame and the credits (engine/movie/hall_of_fame.asm, credits.asm):
 * each party mon slides in (back pic right-to-left, then front pic), its info is
 * recorded, the player's stats are shown, and the credits roll with silhouetted
 * mons, ending on THE END.
 */
import type { Co, Engine } from '../engine/Engine';
import type { HallOfFameMon } from '../game/state';
import { backPixels, frontPixels, placePixels } from './picTiles';
import { encodePlain } from './TextPrinter';
import { printMonType } from './statusScreen';
import { isStarterPikachu } from '../game/pikachu';
import { playPikachuCry, pikachuCry } from '../engine/pikachuEmotions';
import { formatBCD } from './TextPrinter';
import { c } from '../rom/constants';
import { PAD_B } from '../engine/pad';

const PIC_BASE = 0x100; // glyph codes for the 7x7 pic (the original uses $00/$31 in VRAM)
const BLANK = 0x7f;

function put(e: Engine, x: number, y: number, s: string): void {
  s.split('{next}').forEach((line, i) => encodePlain(line).forEach((code, j) => e.screen.put(x + j, y + i * 2, code)));
}

/**
 * The hardware scroll (hSCX/hSCY) of a screen where only the pic at (12,5) is drawn:
 * the 256-pixel background wraps, so the pic's on-screen position is (96 - SCX) mod 256.
 */
function scrollPic(e: Engine, scx: number, scy: number): void {
  const wrap = (v: number, limit: number) => {
    const m = v & 0xff;
    return m >= limit ? m - 256 : m;
  };
  e.screen.setScroll(wrap(96 - scx, 200) - 96, wrap(40 - scy, 160) - 40);
}

/** HoFFadeOutScreenAndMusic */
function* fadeOutScreenAndMusic(e: Engine): Co {
  e.stopAllMusic(); // the audio fade-out (wAudioFadeOutControl)
  yield* e.env.fadeToWhite();
}

/** HoFShowMonOrPlayer: the back pic scrolls across, then the front pic slides in. */
function* showMonOrPlayer(e: Engine, species: number): Co {
  e.screen.clear();
  e.screen.fill(0, 0, 20, 18, BLANK);
  let scx = 0xc0;
  let scy = 0xd0;
  const front = species ? e.bundle.pics.front[species] : e.bundle.pics.special.RedPicFront;
  const back = species ? e.bundle.pics.back[species] : e.bundle.pics.special.RedPicBack;
  // SET_PAL_POKEMON_WHOLE_SCREEN (the player gets PAL_REDMON... via species 0's palette)
  e.hooks.palette?.(e.bundle.palettes.monsterPalettes[species ? (e.bundle.species[species]?.dex ?? 0) : 0]);
  yield* e.env.fadeFromWhite();
  if (back) placePixels(e, backPixels(back), 12, 5);
  scrollPic(e, scx, scy);
  while (scx !== 0xa0) {
    yield;
    scx = (scx + 4) & 0xff;
    scrollPic(e, scx, scy);
  }
  scy = 0;
  if (front) placePixels(e, frontPixels(front), 12, 5, PIC_BASE + 49);
  while (scx !== 0) {
    yield;
    scx = (scx - 4) & 0xff;
    scrollPic(e, scx, scy);
  }
  e.screen.setScroll(0, 0);
}

/** HoFDisplayMonInfo */
function displayMonInfo(e: Engine, m: HallOfFameMon): void {
  e.screen.box(0, 2, 9, 10);
  put(e, 2, 6, e.bundle.strings.HoFMonInfoText);
  put(e, 1, 4, m.nick);
  put(e, 8, 7, String(m.level));
  const sp = e.bundle.species[m.species];
  if (sp) printMonType(e, sp, 3, 9);
}

/** HoFDisplayPlayerStats */
function* displayPlayerStats(e: Engine): Co {
  const env = e.env;
  env.setEvent('EVENT_HALL_OF_FAME_DEX_RATING');
  yield* env.displayDexRating();
  e.screen.box(0, 4, 6, 10);
  e.screen.box(5, 0, 2, 9);
  put(e, 7, 2, e.state.player.name);
  put(e, 1, 6, e.bundle.strings.HoFPlayTimeText);
  const minutes = Math.floor(e.state.frames / 3600);
  const hours = Math.min(Math.floor(minutes / 60), 255);
  put(e, 5, 7, String(hours).padStart(3, ' '));
  e.screen.put(8, 7, 0x6d);
  put(e, 9, 7, String(minutes % 60).padStart(2, '0'));
  put(e, 1, 9, e.bundle.strings.HoFMoneyText);
  put(e, 4, 10, formatBCD(e.state.money, 3 | 0x80 | 0x20));
  for (const label of ['DexSeenOwnedText', 'DexRatingText', e.ram.dexRatingText]) {
    if (!label) continue;
    yield* e.printText(label);
    yield* e.delayFrames(120);
  }
}

/** AnimateHallOfFame */
export function* animateHallOfFame(e: Engine): Co {
  yield* fadeOutScreenAndMusic(e);
  e.screen.clear();
  yield* e.delayFrames(100);
  const prevNoDelay = e.ram.noTextDelay;
  e.ram.noTextDelay = true;
  const n = e.env.getVar('wNumHoFTeams');
  if (n < 255) e.env.setVar('wNumHoFTeams', n + 1);
  e.playMusic('MUSIC_HALL_OF_FAME');
  const team: HallOfFameMon[] = [];
  for (const mon of e.state.party) {
    const m = { species: mon.species, level: mon.level, nick: mon.nickname };
    yield* showMonOrPlayer(e, m.species);
    // HoFDisplayAndRecordMonInfo
    displayMonInfo(e, m);
    if (isStarterPikachu(e.state, mon)) yield* playPikachuCry(e, pikachuCry(35));
    else e.hooks.playCry?.(m.species);
    team.push(m);
    yield* e.delayFrames(80);
    e.screen.box(2, 13, 3, 14);
    put(e, 4, 15, e.bundle.strings.HallOfFameText);
    yield* e.delayFrames(180);
    yield* e.env.fadeToWhite();
  }
  e.store.dispatch({ type: 'addHallOfFameTeam', team }, { undoable: false });
  yield* showMonOrPlayer(e, 0);
  yield* displayPlayerStats(e);
  yield* fadeOutScreenAndMusic(e);
  e.ram.noTextDelay = prevNoDelay;
}

// ------------------------------------------------------------------ the PKMN LEAGUE PC
/** PKMNLeaguePC: every recorded team, one mon per button press; B leaves. */
export function* pkmnLeaguePC(e: Engine): Co {
  yield* e.printText('AccessedHoFPCText');
  const prevNoDelay = e.ram.noTextDelay;
  e.ram.noTextDelay = true;
  const teams = e.state.hallOfFame ?? [];
  const total = e.env.getVar('wNumHoFTeams');
  // with more teams than the capacity, numbering starts at the oldest one still recorded
  let teamNo = total > c('pokemon_data', 'HOF_TEAM_CAPACITY') ? total - c('pokemon_data', 'HOF_TEAM_CAPACITY') : 0;
  const count = Math.min(total, teams.length);
  outer: for (let t = 0; t < count; t++) {
    teamNo++;
    for (const m of teams[t]) {
      // LeaguePCShowMon
      yield* e.env.fadeToWhite();
      e.screen.clear();
      e.screen.fill(0, 0, 20, 18, BLANK);
      e.hooks.palette?.(e.bundle.palettes.monsterPalettes[e.bundle.species[m.species]?.dex ?? 0]);
      const pic = e.bundle.pics.front[m.species];
      if (pic) placePixels(e, frontPixels(pic), 12, 5);
      yield* e.env.fadeFromWhite();
      e.screen.box(0, 13, 2, 18);
      put(e, 1, 15, e.bundle.strings.HallOfFameNoText);
      put(e, 16, 15, String(teamNo).padStart(3, ' '));
      // Func_7033f
      displayMonInfo(e, m);
      e.hooks.playCry?.(m.species);
      yield* e.waitForTextScrollButtonPress();
      if (e.ram.joyHeld & PAD_B) break outer;
    }
  }
  e.ram.noTextDelay = prevNoDelay;
  yield* e.env.fadeToWhite();
  e.screen.clear();
  e.screen.clearGlyphOverrides();
  e.hooks.palette?.(undefined);
  yield* e.env.fadeFromWhite();
}

// ------------------------------------------------------------------ credits
const BLACK = 0x17e; // CreditsLoadFont: tile $7e filled solid black (a private glyph here)
/** The font with color 3 shifted to 1 (ShiftFontColorIndex) so the text can fade in by palette. */
const FADE_STEPS: [number, number, number, number][] = [
  [0, 0, 0, 3],
  [0, 1, 0, 3],
  [0, 2, 0, 3],
  [0, 3, 0, 3],
];

/** FadeInCredits: rBGP %11000000 → %11110000 in four 5-frame steps (color 1 darkens). */
function* fadeInCredits(e: Engine): Co {
  for (const pal of FADE_STEPS) {
    e.screen.setShadeMap(pal);
    yield* e.delayFrames(5);
  }
}

function fillRows(e: Engine, y: number, rows: number, code: number): void {
  e.screen.fill(0, y, 20, rows, code);
}

/** DisplayCreditsMon: the next mon as a black silhouette, scrolled away to the left. */
function* displayCreditsMon(e: Engine, species: number): Co {
  fillRows(e, 4, 10, BLANK);
  const pic = e.bundle.pics.front[species];
  if (pic) placePixels(e, frontPixels(pic), 8, 6);
  e.screen.setShadeMap([0, 3, 3, 3]); // %11111100: the mon a black silhouette
  for (let i = 0; i < 10; i++) {
    e.screen.setScroll(-i * 8, 0);
    yield;
  }
  e.screen.fill(0, 4, 10, 10, BLANK);
  for (let i = 10; i < 20; i++) {
    e.screen.setScroll(-i * 8, 0);
    yield;
  }
  e.screen.fill(10, 4, 10, 10, BLANK);
  for (let i = 20; i < 28; i++) {
    e.screen.setScroll(-i * 8, 0);
    yield;
  }
  e.screen.setShadeMap([0, 0, 0, 3]);
  e.screen.setScroll(0, 0);
}

/** HallOfFamePC: the Hall of Fame, then the credits. */
export function* hallOfFamePC(e: Engine): Co {
  yield* animateHallOfFame(e);
  e.screen.clear();
  yield* e.delayFrames(100);
  e.screen.fill(0, 0, 20, 18, BLANK);
  e.screen.setGlyphOverride(BLACK, new Array(64).fill(3));
  fillRows(e, 0, 4, BLACK);
  fillRows(e, 14, 4, BLACK);
  e.screen.setShadeMap([0, 0, 0, 3], true);
  e.hooks.palette?.(c('palette', 'PAL_BLACK'));
  e.hooks.fade?.(0); // the credits set rBGP directly (the screen was faded to white)
  e.stopAllMusic();
  e.playMusic('MUSIC_CREDITS');
  yield* e.delayFrames(128);
  // THE END stays up (tiles and palette untouched) until the soft reset
  yield* credits(e);
}

/** Credits: CreditsOrder, one screen of text at a time. */
function* credits(e: Engine): Co {
  const cr = e.bundle.ui.credits;
  const C = (n: string) => c('credits', n);
  let mon = 0;
  let line = 6;
  const newScreen = () => {
    fillRows(e, 4, 10, BLANK);
    line = 6;
  };
  newScreen();
  for (const cmd of cr.order) {
    if (cmd >= 0) {
      // PlaceCreditsText
      const t = cr.texts[cmd];
      put(e, 9 + t.dx, line, t.text);
      line += 2;
      continue;
    }
    if (cmd === C('CRED_COPYRIGHT')) {
      const tiles = cr.copyrightTiles;
      for (let i = 0; i < tiles.length / 64; i++) e.screen.setGlyphOverride(0x60 + i, tiles.slice(i * 64, i * 64 + 64));
      cr.copyrightRows.forEach((row, i) => row.forEach((code, j) => e.screen.put(2 + j, 7 + i * 2, code)));
      continue;
    }
    if (cmd === C('CRED_THE_END')) {
      yield* e.delayFrames(24);
      fillRows(e, 4, 10, BLANK);
      for (let i = 0; i < cr.theEnd.length / 64; i++) e.screen.setGlyphOverride(0x60 + i, cr.theEnd.slice(i * 64, i * 64 + 64));
      const top = [0x60, BLANK, 0x62, BLANK, 0x64, BLANK, BLANK, 0x64, BLANK, 0x66, BLANK, 0x68];
      top.forEach((code, i) => {
        e.screen.put(4 + i, 8, code);
        e.screen.put(4 + i, 9, code === BLANK ? BLANK : code + 1);
      });
      yield* fadeInCredits(e);
      return;
    }
    const fade = cmd === C('CRED_TEXT_FADE_MON') || cmd === C('CRED_TEXT_FADE');
    const withMon = cmd === C('CRED_TEXT_FADE_MON') || cmd === C('CRED_TEXT_MON');
    if (fade) yield* fadeInCredits(e);
    yield* e.delayFrames((withMon ? 122 : 152) - (fade ? 20 : 0));
    // the text stays visible (rBGP keeps the faded-in value) until a mon resets it
    if (withMon) yield* displayCreditsMon(e, cr.mons[mon++]);
    newScreen();
  }
}
