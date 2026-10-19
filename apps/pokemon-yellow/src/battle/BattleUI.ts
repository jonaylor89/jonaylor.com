/**
 * The Game Boy battle screen on the tile-grid UI layer: HUDs and HP bars
 * (DrawPlayerHUDAndHPBar / DrawEnemyHUDAndHPBar / DrawHPBar), pics, the
 * party Poké Balls, send-out/retreat animations, the substitute doll and the
 * screen shakes. Coordinates follow the original hlcoord values.
 */
import type { Co, Engine } from '../engine/Engine';
import type { Pic } from '../data/schema';
import { picPixels } from '../rom/extract/pics';
import { encodePlain } from '../ui/TextPrinter';
import { EMPTY } from '../ui/TileScreen';

const BLANK = 0x7f;
/** Glyph code ranges used for pics and sprites (above the 8-bit character set). */
export const ENEMY_PIC_BASE = 0x100;
export const PLAYER_PIC_BASE = 0x200;
const SMALL_PIC_BASE = 0x280;
const BALL_BASE = 0x330; // + $31..$34 like the OAM tile ids
const SUB_BASE = 0x380;

export interface HudMon {
  nick: string;
  level: number;
  hp: number;
  maxHp: number;
  status: number;
}

export interface BallParty {
  party: { hp: number; status: number }[];
  enemyParty: { hp: number; status: number }[];
  isTrainerBattle(): boolean;
}

export class BattleUI {
  /** The pics currently shown (for redraws after menus and animations). */
  enemyPic?: Pic;
  playerPic?: Pic;

  constructor(readonly e: Engine) {}

  get screen() {
    return this.e.screen;
  }

  /** Battle screen setup: blank background, HP bar/status, HUD and ball tiles. */
  enter(): void {
    this.reloadHudTiles();
    this.screen.clear();
    this.screen.fill(0, 0, 20, 18, BLANK);
    this.e.hooks.battleScene?.(true);
  }

  /** LoadHudAndHpBarAndStatusTilePatterns (+ the Poké Ball tiles). */
  reloadHudTiles(): void {
    const s = this.screen;
    const hp = this.e.bundle.ui.hpBarAndStatus;
    for (let t = 0; t < hp.count && 0x62 + t <= 0x7f; t++) s.setGlyphOverride(0x62 + t, hp.pixels.slice(t * 64, t * 64 + 64));
    const b = this.e.bundle.battle;
    for (let t = 0; t < b.hudTiles1.length / 64; t++) s.setGlyphOverride(0x6d + t, b.hudTiles1.slice(t * 64, t * 64 + 64));
    for (let t = 0; t < b.hudTiles23.length / 64; t++) s.setGlyphOverride(0x73 + t, b.hudTiles23.slice(t * 64, t * 64 + 64));
    const balls = this.e.bundle.ui.pokeballs;
    for (let t = 0; t < balls.count; t++) s.setGlyphOverride(BALL_BASE + 0x31 + t, balls.pixels.slice(t * 64, t * 64 + 64));
  }

  leave(): void {
    this.e.hooks.battleScene?.(false);
    this.e.hooks.palette?.(undefined);
    this.screen.setObjects([]);
    this.screen.setScroll(0, 0);
    this.screen.clearGlyphOverrides();
    this.screen.clear();
  }

  clearScreen(): void {
    this.screen.setObjects([]);
    this.screen.fill(0, 0, 20, 18, BLANK);
  }

  clearSprites(): void {
    this.screen.setObjects([]);
  }

  put(x: number, y: number, str: string): number {
    const codes = encodePlain(str.replace(/\{poke\}/g, 'POKé').replace(/\{pkmn\}/g, '<PK><MN>'));
    codes.forEach((code, i) => this.screen.put(x + i, y, code));
    return x + codes.length;
  }

  /** ClearScreenArea(x, y, h, w) */
  clearArea(x: number, y: number, h: number, w: number): void {
    this.screen.fill(x, y, w, h, BLANK);
  }

  /** Shift a rectangle's tiles horizontally by dx (vacated tiles become blank). */
  shiftArea(x: number, y: number, h: number, w: number, dx: number): void {
    const s = this.screen;
    for (let row = y; row < y + h; row++) {
      const vals: number[] = [];
      for (let col = x; col < x + w; col++) vals.push(s.get(col, row));
      for (let i = 0; i < w; i++) {
        const src = i - dx;
        s.put(x + i, row, src >= 0 && src < w ? vals[src] : BLANK);
      }
    }
  }

  // ------------------------------------------------------------ pics
  /** Front pic in the 7x7 area (bottom-aligned, centered), clipped to the screen. */
  setEnemyPic(pic: Pic | undefined, x = 12, y = 0): void {
    this.enemyPic = pic;
    this.placePic(pic, ENEMY_PIC_BASE, x, y);
  }

  /** Redraw the enemy pic (AnimationShowMonPic). */
  showEnemyPic(): void {
    this.placePic(this.enemyPic, ENEMY_PIC_BASE, 12, 0);
  }

  /** Trainer front pic (always 7x7). */
  setTrainerPic(pic: Pic | undefined): void {
    this.setEnemyPic(pic);
  }

  /** ScaleSpriteByTwo: the top-left 28x28 of a 4x4 back pic doubled into 7x7 tiles at (1+dx, 5). */
  setPlayerBackPic(pic: Pic | undefined, dx = 0): void {
    this.playerPic = pic;
    if (!pic) {
      this.clearArea(1 + dx, 5, 7, 7);
      return;
    }
    this.placePixels(this.backPixels(pic), 7, PLAYER_PIC_BASE, 1 + dx, 5);
  }

  showPlayerPic(): void {
    this.setPlayerBackPic(this.playerPic);
  }

  private backPixels(pic: Pic): number[] {
    const W = pic.width * 8;
    const src = picPixels(pic);
    const out = new Array<number>(56 * 56).fill(0);
    for (let y = 0; y < 56; y++) for (let x = 0; x < 56; x++) out[y * 56 + x] = src[(y >> 1) * W + (x >> 1)] ?? 0;
    return out;
  }

  private frontPixels(pic: Pic): number[] {
    const W = pic.width * 8;
    const src = picPixels(pic);
    const out = new Array<number>(56 * 56).fill(0);
    const ox = (7 - pic.width) >> 1;
    const oy = 7 - pic.width;
    for (let py = 0; py < W; py++)
      for (let px = 0; px < W; px++) {
        const tx = ox * 8 + px;
        const ty = oy * 8 + py;
        if (tx < 56 && ty < 56) out[ty * 56 + tx] = src[py * W + px];
      }
    return out;
  }

  private placePic(pic: Pic | undefined, base: number, x: number, y: number): void {
    if (!pic) {
      this.clearArea(Math.max(0, x), y, 7, 7);
      return;
    }
    this.placePixels(this.frontPixels(pic), 7, base, x, y);
  }

  private placePixels(px: number[], tiles: number, base: number, x: number, y: number): void {
    const W = tiles * 8;
    for (let ty = 0; ty < tiles; ty++)
      for (let tx = 0; tx < tiles; tx++) {
        const sx = x + tx;
        if (sx < 0 || sx >= 20) continue;
        const tile = new Array<number>(64);
        for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) tile[yy * 8 + xx] = px[(ty * 8 + yy) * W + tx * 8 + xx];
        const code = base + ty * tiles + tx;
        this.screen.setGlyphOverride(code, tile);
        this.screen.put(sx, y + ty, code);
      }
  }

  /** A pic shrunk to n x n tiles (CopyDownscaledMonTiles). */
  private placeSmall(pixels: number[], n: number, x: number, y: number): void {
    const out = new Array<number>(n * 8 * n * 8);
    const scale = 56 / (n * 8);
    for (let yy = 0; yy < n * 8; yy++)
      for (let xx = 0; xx < n * 8; xx++) out[yy * n * 8 + xx] = pixels[Math.floor(yy * scale) * 56 + Math.floor(xx * scale)];
    this.placePixels(out, n, SMALL_PIC_BASE, x, y);
  }

  /** AnimateSendingOutMon: poof tile, 3x3, 5x5, then the full pic. (cx, cy) = bottom center. */
  *animateSendingOutMon(pic: Pic | undefined, cx: number, cy: number, player = false): Co {
    if (!pic) return;
    const px = player ? this.backPixels(pic) : this.frontPixels(pic);
    const x0 = cx - 3;
    const y0 = cy - 6;
    this.clearArea(x0, y0, 7, 7);
    this.screen.put(cx, cy, 0x4c);
    yield* frames(3);
    this.clearArea(x0, y0, 7, 7);
    this.placeSmall(px, 3, cx - 1, cy - 2);
    yield* frames(4);
    this.clearArea(x0, y0, 7, 7);
    this.placeSmall(px, 5, cx - 2, cy - 4);
    yield* frames(5);
    this.clearArea(x0, y0, 7, 7);
    if (player) this.setPlayerBackPic(pic);
    else this.setEnemyPic(pic);
  }

  /** AnimateRetreatingPlayerMon: 5x5, 3x3, then a single tile before vanishing. */
  *animateRetreatingPlayerMon(): Co {
    const pic = this.playerPic;
    this.clearArea(1, 5, 7, 7);
    if (!pic) return;
    const px = this.backPixels(pic);
    this.placeSmall(px, 5, 3, 7);
    yield* frames(4);
    this.clearArea(1, 5, 7, 7);
    this.placeSmall(px, 3, 4, 9);
    yield* frames(3);
    this.clearArea(1, 5, 7, 7);
    this.screen.put(5, 11, 0x4c);
    this.clearArea(1, 5, 7, 7);
  }

  /** SlideDownFaintedMonPic: shift the 7x7 pic area down one row per 2 frames. */
  *slideDownPic(x: number, y: number): Co {
    for (let step = 0; step < 7; step++) {
      for (let row = y + 6; row > y; row--) for (let col = x; col < x + 7; col++) this.screen.put(col, row, this.screen.get(col, row - 1));
      for (let col = x; col < x + 7; col++) this.screen.put(col, y, BLANK);
      yield* frames(2);
    }
  }

  /** AnimationSlideEnemyMonOff */
  *slideEnemyPicOff(): Co {
    for (let i = 0; i < 8; i++) {
      this.shiftArea(12, 0, 7, 8, 1);
      yield* frames(2);
    }
  }

  // ------------------------------------------------------------ substitute
  private substitutePixels(player: boolean): number[] {
    const tiles = this.e.bundle.battle.substituteTiles;
    const out = new Array<number>(56 * 56).fill(0);
    // front doll at tiles (2,4),(3,4),(2,5),(3,5); back doll at (3,4),(4,4),(3,5),(4,5)
    const x0 = player ? 3 : 2;
    const first = player ? 4 : 0;
    const spots = [
      [x0, 4],
      [x0 + 1, 4],
      [x0, 5],
      [x0 + 1, 5],
    ];
    spots.forEach(([tx, ty], i) => {
      const t = tiles.slice((first + i) * 64, (first + i) * 64 + 64);
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) out[(ty * 8 + yy) * 56 + tx * 8 + xx] = t[yy * 8 + xx];
    });
    return out;
  }

  /** AnimationSubstitute: replace the user's pic with the doll. */
  *showSubstitute(turn: number): Co {
    const player = turn === 0;
    this.placePixels(this.substitutePixels(player), 7, SUB_BASE + (player ? 0 : 0x40), player ? 1 : 12, player ? 5 : 0);
    yield;
  }

  /** HideSubstituteShowMonAnim: slide the doll away and show the mon. */
  *hideSubstitute(turn: number): Co {
    yield* this.slideMonOff(turn);
    if (turn === 0) this.showPlayerPic();
    else this.showEnemyPic();
  }

  /** ReshowSubstituteAnim */
  *reshowSubstitute(turn: number): Co {
    yield* this.slideMonOff(turn);
    yield* this.showSubstitute(turn);
  }

  /** The substitute broke (Func_79929): flash, then the mon reappears. */
  *substituteBroke(turn: number): Co {
    yield* this.blinkMonPic(turn === 0 ? 1 : 12, turn === 0 ? 5 : 0, 2);
    if (turn === 0) this.showPlayerPic();
    else this.showEnemyPic();
  }

  /** AnimationSlideMonOff */
  *slideMonOff(turn: number): Co {
    const player = turn === 0;
    for (let i = 0; i < 8; i++) {
      if (player) this.shiftArea(0, 5, 7, 9, -1);
      else this.shiftArea(12, 0, 7, 8, 1);
      yield* frames(1);
    }
  }

  // ------------------------------------------------------------ effects
  /** PredefShakeScreenHorizontally(b) */
  *shakeScreenHorizontally(n: number): Co {
    let wx = 0;
    for (let b = n; b > 0; b--) {
      wx ^= b;
      this.screen.setScroll(wx & 0x80 ? 0 : wx, 0);
      yield* frames(4);
      yield* frames(1);
      wx ^= b;
      this.screen.setScroll(wx & 0x80 ? 0 : wx, 0);
      yield* frames(4);
    }
    this.screen.setScroll(0, 0);
  }

  /** PredefShakeScreenVertically(b) */
  *shakeScreenVertically(n: number): Co {
    let wy = 0;
    for (let b = n; b > 0; b--) {
      wy ^= b;
      this.screen.setScroll(0, wy);
      yield* frames(3);
      wy ^= b;
      this.screen.setScroll(0, wy);
      yield* frames(3);
    }
    this.screen.setScroll(0, 0);
  }

  /** AnimationShakeScreenHorizontallySlow(b, c) */
  *shakeScreenHorizontallySlow(b: number, c: number): Co {
    for (let k = 0; k < c; k++) {
      for (let i = 1; i <= b; i++) {
        this.screen.setScroll(i, 0);
        yield* frames(2);
      }
      for (let i = b - 1; i >= 0; i--) {
        this.screen.setScroll(i, 0);
        yield* frames(2);
      }
    }
    this.screen.setScroll(0, 0);
  }

  /** AnimationBlinkMon: hide/show the pic, 5 frames each. */
  *blinkMonPic(x: number, y: number, times = 6): Co {
    const saved: number[] = [];
    for (let j = 0; j < 7; j++) for (let i = 0; i < 7; i++) saved.push(this.screen.get(x + i, y + j));
    for (let n = 0; n < times; n++) {
      this.clearArea(x, y, 7, 7);
      yield* frames(5);
      saved.forEach((code, k) => this.screen.put(x + (k % 7), y + Math.floor(k / 7), code));
      yield* frames(5);
    }
  }

  // ------------------------------------------------------------ Poké Balls
  /** SetupPokeballs: ball tile ids for a party (empty slots padded to 6). */
  private balls(party: { hp: number; status: number }[]): number[] {
    const out = Array<number>(6).fill(0x34);
    party.forEach((m, i) => (out[i] = !m.hp ? 0x33 : m.status ? 0x32 : 0x31));
    return out;
  }

  /** DrawAllPokeballs */
  drawAllPokeballs(b: BallParty): void {
    this.placePlayerHUDTiles();
    const objs = this.balls(b.party).map((t, i) => ({ x: 0x60 - 8 + i * 8, y: 0x60 - 16, code: BALL_BASE + t }));
    if (b.isTrainerBattle()) {
      this.placeEnemyHUDTiles();
      objs.push(...this.balls(b.enemyParty).map((t, i) => ({ x: 0x48 - 8 - i * 8, y: 0x20 - 16, code: BALL_BASE + t })));
    }
    this.screen.setObjects(objs);
  }

  /** DrawEnemyPokeballs */
  drawEnemyPokeballs(b: BallParty): void {
    this.placeEnemyHUDTiles();
    this.screen.setObjects(this.balls(b.enemyParty).map((t, i) => ({ x: 0x48 - 8 - i * 8, y: 0x20 - 16, code: BALL_BASE + t })));
  }

  // ------------------------------------------------------------ HUDs
  /** HPBarLength: pixels (0-48) for an HP bar. */
  static barPixels(hp: number, maxHp: number): number {
    if (!hp) return 0;
    let prod = hp * 48;
    let div = maxHp;
    if (maxHp > 255) {
      div = (maxHp >> 2) & 0xff;
      prod = prod >> 2;
    }
    if (!div) return 0;
    return Math.min(0xff, Math.floor(prod / div));
  }

  /** DrawHPBar: "HP:" + 6 segments at (x,y); type 1 = battle/status screen end cap. */
  drawHPBar(x: number, y: number, pixels: number, sliver: boolean, type: number): void {
    const s = this.screen;
    s.put(x, y, 0x71);
    s.put(x + 1, y, 0x62);
    for (let i = 0; i < 6; i++) s.put(x + 2 + i, y, 0x63);
    s.put(x + 8, y, type === 1 ? 0x6d : 0x6c);
    let e = pixels;
    if (!e && sliver) e = 1;
    let i = 0;
    while (e > 0 && i < 6) {
      if (e >= 8) {
        s.put(x + 2 + i, y, 0x6b);
        e -= 8;
        i++;
      } else {
        s.put(x + 2 + i, y, 0x63 + e);
        e = 0;
      }
    }
  }

  /** PrintStatusConditionNotFainted, else PrintLevel. */
  printStatusOrLevel(x: number, y: number, m: HudMon): void {
    const st = statusString(m.status);
    if (st) {
      this.put(x + 1, y, st);
      return;
    }
    if (m.level >= 100) this.put(x, y, String(m.level));
    else {
      this.screen.put(x, y, 0x6e); // <LV>
      this.put(x + 1, y, String(m.level));
    }
  }

  /** CenterMonName: names of 1-2 letters move right 2 tiles, 3-4 letters 1 tile. */
  private centerName(x: number, nick: string): number {
    const len = encodePlain(nick).length;
    let shift = 2;
    if (len > 2) shift--;
    if (len > 4) shift--;
    return x + shift;
  }

  /** PlacePlayerHUDTiles */
  placePlayerHUDTiles(): void {
    const s = this.screen;
    s.put(18, 10, 0x73);
    s.put(18, 11, 0x77);
    for (let i = 1; i <= 8; i++) s.put(18 - i, 11, 0x76);
    s.put(18 - 9, 11, 0x6f);
  }

  /** PlaceEnemyHUDTiles */
  placeEnemyHUDTiles(): void {
    const s = this.screen;
    s.put(1, 2, 0x73);
    s.put(1, 3, 0x74);
    for (let i = 1; i <= 8; i++) s.put(1 + i, 3, 0x76);
    s.put(1 + 9, 3, 0x78);
  }

  drawPlayerHUD(m: HudMon): void {
    this.clearArea(9, 7, 5, 11);
    this.placePlayerHUDTiles();
    this.screen.put(18, 9, 0x73);
    this.put(this.centerName(10, m.nick), 7, m.nick);
    this.printStatusOrLevel(14, 8, m);
    this.drawHPBar(10, 9, BattleUI.barPixels(m.hp, m.maxHp), m.hp > 0, 1);
    this.put(11, 10, `${String(m.hp).padStart(3, ' ')}/${String(m.maxHp).padStart(3, ' ')}`);
  }

  drawEnemyHUD(m: HudMon): void {
    this.clearArea(0, 0, 4, 12);
    this.placeEnemyHUDTiles();
    this.put(this.centerName(1, m.nick), 0, m.nick);
    this.printStatusOrLevel(4, 1, m);
    this.drawHPBar(2, 2, BattleUI.barPixels(m.hp, m.maxHp), false, 0);
  }

  /**
   * UpdateHPBar2: animate the bar one pixel at a time (2 frames per pixel),
   * updating the player's HP number as it goes.
   */
  *animateHPBar(isPlayer: boolean, m: HudMon, oldHp: number): Co {
    const from = BattleUI.barPixels(oldHp, m.maxHp);
    const to = BattleUI.barPixels(m.hp, m.maxHp);
    const x = isPlayer ? 10 : 2;
    const y = isPlayer ? 9 : 2;
    const step = to < from ? -1 : 1;
    let px = from;
    while (px !== to) {
      px += step;
      this.drawHPBar(x, y, px, px > 0, isPlayer ? 1 : 0);
      if (isPlayer) {
        const shown = Math.round(oldHp + ((m.hp - oldHp) * Math.abs(px - from)) / Math.max(1, Math.abs(to - from)));
        this.put(11, 10, `${String(shown).padStart(3, ' ')}/${String(m.maxHp).padStart(3, ' ')}`);
      }
      yield* frames(2);
    }
    if (isPlayer) this.drawPlayerHUD(m);
    else this.drawEnemyHUD(m);
  }

  /** Text box area (rows 12-17). */
  textBox(): void {
    this.screen.box(0, 12, 4, 18);
  }

  /** Whole-screen snapshot/restore (SaveScreenTilesToBuffer1). */
  save(): Int16Array {
    return this.screen.cells.slice();
  }
  restore(buf: Int16Array): void {
    this.screen.cells.set(buf);
    this.screen.markDirty();
  }

  isEmpty(x: number, y: number): boolean {
    return this.screen.get(x, y) === EMPTY;
  }
}

export function statusString(status: number): string {
  if (status & (1 << 3)) return 'PSN';
  if (status & (1 << 4)) return 'BRN';
  if (status & (1 << 5)) return 'FRZ';
  if (status & (1 << 6)) return 'PAR';
  if (status & 7) return 'SLP';
  return '';
}

function* frames(n: number): Co {
  for (let i = 0; i < n; i++) yield;
}
