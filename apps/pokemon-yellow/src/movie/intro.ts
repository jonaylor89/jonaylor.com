/**
 * PlayIntro (engine/movie/intro.asm, splash.asm, intro_yellow.asm): the
 * copyright screen, the Game Freak shooting star with its falling small stars,
 * and the Yellow intro scenes (running, kicking, surfing and flying Pikachu, the
 * close-up and the thunderbolt flash). A, B or START skips ahead to the title.
 */
import type { Co, Engine } from '../engine/Engine';
import type { IntroData } from '../data/schema';
import { GbHardware } from '../gb/hardware';
import { AnimatedObjects, ANIM_OBJ_FIELD_B, ANIM_OBJ_FIELD_C, ANIM_OBJ_INDEX, ANIM_OBJ_X_COORD, ANIM_OBJ_Y_COORD, ANIM_OBJ_Y_OFFSET } from '../gb/animatedObjects';
import { inputToPad, PAD_A, PAD_B, PAD_SELECT, PAD_START, PAD_UP } from '../engine/pad';
import { LowSensitivity } from '../ui/menus';
import { c } from '../rom/constants';

/** CheckForUserInterruption over n frames: true when UP+SELECT+B, START or A came in. */
function* interruptible(hw: GbHardware, js: LowSensitivity, n: number): Co<boolean> {
  for (let i = 0; i < n; i++) {
    yield* hw.vblank();
    const fresh = js.read(hw.e);
    const held = inputToPad(hw.e.input, 'held');
    if ((held & (PAD_UP | PAD_SELECT | PAD_B)) === (PAD_UP | PAD_SELECT | PAD_B)) return true;
    if (fresh & (PAD_START | PAD_A)) return true;
  }
  return false;
}

/** PlayIntro: returns once the title screen should start. */
export function* playIntro(e: Engine): Co {
  const hw = new GbHardware(e);
  e.screen.setPpu(hw.ppu);
  yield* playShootingStar(e, hw);
  yield* playIntroScene(e, hw);
  e.screen.setPpu(undefined);
}

/** LoadCopyrightAndTextBoxTiles + PlayShootingStar */
function* playShootingStar(e: Engine, hw: GbHardware): Co {
  const p = hw.ppu;
  const d = e.bundle.intro;
  const P = (n: string) => c('palette', n);
  e.hooks.fade?.(0);
  // SET_PAL_GAME_FREAK_INTRO
  e.hooks.paletteLayout?.([P('PAL_GAMEFREAK'), P('PAL_REDMON'), P('PAL_VIRIDIAN'), P('PAL_BLUEMON')], [
    { pal: 1, x0: 5, y0: 11, x1: 7, y1: 13 },
    { pal: 2, x0: 8, y0: 11, x1: 9, y1: 13 },
    { pal: 3, x0: 12, y0: 11, x1: 14, y1: 13 },
  ]);
  Object.assign(p, { lcdOn: true, bgOn: true, objOn: true, winOn: false, bgMap: 1, winMap: 1, tileData8000: false, lyTarget: undefined });
  hw.wy = 0;
  hw.autoBgDest = 0x9c00;
  // the copyright lines (LoadTextBoxTilePatterns, LoadCopyrightTiles)
  const ui = e.bundle.ui;
  p.loadTiles(0x160, ui.fontExtra.pixels, ui.fontExtra.count);
  p.loadTiles(0x160, ui.credits.copyrightTiles);
  hw.tileMap.fill(0x7f);
  ui.credits.copyrightRows.forEach((row, r) => row.forEach((code, i) => (hw.tileMap[(7 + r * 2) * 20 + 2 + i] = code)));
  hw.copyTileMapNow();
  p.bgp = 0xe4;
  yield* hw.delayFrames(180);
  // IntroDrawBlackBars and the Game Freak graphics
  hw.tileMap.fill(0);
  hw.tileMap.fill(1, 0, 4 * 20);
  hw.tileMap.fill(1, 14 * 20, 18 * 20);
  p.bgMaps[1].fill(0);
  p.bgMaps[1].fill(1, 0, 4 * 32);
  p.bgMaps[1].fill(1, 14 * 32, 18 * 32);
  hw.copyTileMapNow();
  p.loadTiles(0x100, new Array(64).fill(0), 1);
  p.loadTiles(0x101, new Array(64).fill(3), 1);
  p.loadTiles(0x160, d.gameFreak);
  p.loadTiles(0x80, d.gameFreak);
  yield* hw.delayFrames(64);
  const interrupted = yield* animateShootingStar(e, hw, d);
  if (!interrupted) yield* hw.delayFrames(40);
  // IntroClearMiddleOfScreen, ClearSprites
  hw.tileMap.fill(0, 4 * 20, 14 * 20);
  hw.copyTileMapNow();
  hw.clearOam();
  yield* hw.delayFrames(3);
}

/** AnimateShootingStar: true when the player interrupted it. */
function* animateShootingStar(e: Engine, hw: GbHardware, d: IntroData): Co<boolean> {
  const p = hw.ppu;
  const oam = hw.shadowOam;
  const js = new LowSensitivity(e);
  // LoadShootingStarGraphics
  p.obp0 = 0xf9;
  p.obp1 = 0xa4;
  p.loadTiles(0x80 + 0x20, d.starTiles, 2);
  p.loadTiles(0x80 + 0x22, d.fallingStar);
  d.logoOam.forEach(([y, x, tile, attr], i) => Object.assign(oam[24 + i], { y, x, tile, attr }));
  d.shootingStarOam.forEach(([y, x, tile, attr], i) => Object.assign(oam[i], { y, x, tile, attr }));
  e.env.playSound('shooting_star');
  // the big star moves down and left
  for (;;) {
    for (let i = 0; i < 4; i++) {
      oam[i].y = (oam[i].y + 4) & 0xff;
      oam[i].x = (oam[i].x - 4) & 0xff;
    }
    if (yield* interruptible(hw, js, 1)) return true;
    if (oam[0].y === 80) continue;
    if (oam[0].y === 0xa0) break;
  }
  for (let i = 0; i < 4; i++) oam[i].y = 160;
  // the logo flashes
  for (let i = 0; i < 3; i++) {
    p.obp0 = ((p.obp0 >> 2) | (p.obp0 << 6)) & 0xff; // rrc twice
    if (yield* interruptible(hw, js, 10)) return true;
  }
  // 24 small stars, off-screen until their wave comes
  const [sy, sx, stile, sattr] = d.smallStarOam;
  for (let i = 0; i < 24; i++) Object.assign(oam[i], { y: sy, x: sx, tile: stile, attr: sattr });
  let count = 0; // wMoveDownSmallStarsOAMCount
  for (const wave of d.smallStarWaves) {
    wave.forEach(([y, x, low], i) => {
      const o = oam[20 + i];
      o.y = y;
      o.x = x;
      o.attr = (o.attr & 0xf0) | low;
    });
    if (wave.length && count !== 24) count += 6;
    // MoveDownSmallStars
    for (let b = 0; b < 8; b++) {
      for (let k = 0; k < count; k++) {
        const o = oam[23 - k];
        if (o) o.y = (o.y + 1) & 0xff;
      }
      p.obp1 ^= 0xa0;
      if (yield* interruptible(hw, js, 3)) return true;
    }
    // shift the existing stars down to make room for the next wave
    for (let i = 0; i < 20; i++) Object.assign(oam[i], { ...oam[i + 4] });
  }
  return false;
}

// ------------------------------------------------------------------ the Yellow intro
class YellowIntro {
  readonly objs: AnimatedObjects;
  scene = 0;
  timer = 0;
  current: Uint8Array | undefined;
  readonly lyBuffer = new Uint8Array(0x100);
  private copyLy = false;
  private cloudTiles: number[] | undefined;

  constructor(
    readonly e: Engine,
    readonly hw: GbHardware,
    readonly d: IntroData,
  ) {
    this.objs = new AnimatedObjects(
      d.anim,
      [() => {}, () => {}, (o) => this.slideLeft(o), (o) => this.slideRight(o), (o) => this.bounce(o), (o) => this.speedBar(o)],
      hw.shadowOam,
    );
  }

  /** Func_fa079: the 64-step sine scaled by d */
  sine(a: number, d: number): number {
    const i = a & 0x3f;
    const v = (((this.d.sine[i & 0x1f] * d) & 0xffff) >> 8) & 0xff;
    return i >= 0x20 ? -v & 0xff : v;
  }

  // the object callbacks (YellowIntro_AnimatedObjectJumptable)
  private slideLeft(o: Uint8Array): void {
    if (o[ANIM_OBJ_X_COORD] !== 0x58) o[ANIM_OBJ_X_COORD] -= 4;
  }
  private slideRight(o: Uint8Array): void {
    let a = o[ANIM_OBJ_X_COORD];
    if (a !== 0x58) {
      a = (a + 4) & 0xff;
      o[ANIM_OBJ_X_COORD] = a;
    }
    if (a !== 0x58) o[ANIM_OBJ_Y_COORD] = (a + 1) & 0xff;
  }
  private bounce(o: Uint8Array): void {
    if (o[ANIM_OBJ_FIELD_B] === 0) {
      if (o[ANIM_OBJ_Y_COORD] !== 0x58) {
        o[ANIM_OBJ_Y_COORD] -= 2;
        return;
      }
      o[ANIM_OBJ_FIELD_B]++;
    }
    const a = o[ANIM_OBJ_FIELD_C]++;
    o[ANIM_OBJ_Y_OFFSET] = this.sine(a, 8);
  }
  private speedBar(o: Uint8Array): void {
    o[ANIM_OBJ_X_COORD] = (o[ANIM_OBJ_X_COORD] + o[ANIM_OBJ_FIELD_B]) & 0xff;
  }

  spawn(type: number, x: number, y: number): Uint8Array | undefined {
    const s = this.objs.spawn(type, x, y);
    this.current = s;
    return s;
  }
  maskCurrent(): void {
    if (this.current) this.current[ANIM_OBJ_INDEX] = 0;
  }
  maskAll(): void {
    for (const s of this.objs.structs) s[ANIM_OBJ_INDEX] = 0;
  }
  /** YellowIntro_CheckFrameTimerDecrement: true once the timer has run out */
  timerExpired(): boolean {
    if (!this.timer) return true;
    this.timer--;
    return false;
  }

  /** YellowIntro_BlankPalsDelay2AndDisableLCD */
  *blankAndDisable(): Co {
    const p = this.hw.ppu;
    p.bgp = p.obp0 = p.obp1 = 0;
    yield* this.hw.vblank();
    yield* this.hw.vblank();
    p.lcdOn = false;
  }

  /** Func_f9e9a: the palette, scroll reset, LCD on */
  enable(beach: boolean): void {
    const e = this.e;
    e.hooks.palette?.(c('palette', beach ? 'PAL_PIKACHUS_BEACH' : 'PAL_MEWMON'));
    const hw = this.hw;
    hw.scx = hw.scy = 0;
    hw.wy = 0x90;
    Object.assign(hw.ppu, { lcdOn: true, bgOn: true, objOn: true, winOn: true, bgMap: 0, winMap: 1, tileData8000: false, bgp: 0xe4, obp0: 0xe4, obp1: 0xe0 });
  }

  /** Func_f9e5f: black bars over and under a white middle */
  bars(): void {
    const m = this.hw.ppu.bgMaps[0];
    m.fill(1, 0, 0x80);
    m.fill(0, 0x80, 0x80 + 0x140);
    m.fill(1, 0x1c0, 0x1c0 + 0x80);
  }

  /** The scene functions (Jumptable_f9906); returns after one frame's work. */
  *runScene(): Co {
    const hw = this.hw;
    const p = hw.ppu;
    const m = p.bgMaps[0];
    const d = this.d;
    switch (this.scene) {
      case 0:
        p.lyTarget = undefined;
        this.spawn(1, 0x58, 0x58);
        hw.scx = hw.scy = 0;
        hw.wy = 0x90;
        p.bgp = p.obp0 = 0xe4;
        p.obp1 = 0xc4;
        this.timer = 130;
        this.scene++;
        return;
      case 1:
      case 5:
      case 9:
        if (!this.timerExpired()) return;
        this.maskCurrent();
        this.scene++;
        return;
      case 2: {
        yield* this.blankAndDisable();
        p.lyTarget = undefined;
        m.fill(0);
        // YellowIntroScene2_PlaceGraphic: 6x6 tiles from $90 at (20, 6), off the right edge
        for (let r = 0; r < 6; r++) for (let i = 0; i < 6; i++) m[(6 + r) * 32 + 20 + i] = 0x90 + r * 0x10 + i;
        for (const [x, y, speed] of d.speedBars) {
          const o = this.objs.spawn(8, x, y);
          if (o) o[ANIM_OBJ_FIELD_B] = speed;
        }
        this.enable(true);
        this.timer = 128;
        this.scene++;
        return;
      }
      case 3:
        if (this.timerExpired()) {
          this.maskAll();
          this.scene++;
          return;
        }
        if (hw.scx !== 0x68) hw.scx = (hw.scx + 4) & 0xff;
        return;
      case 4:
        yield* this.blankAndDisable();
        p.lyTarget = undefined;
        this.bars();
        this.spawn(2, 0x58, 0x58);
        this.enable(false);
        this.timer = 128;
        this.scene++;
        return;
      case 6:
        yield* this.blankAndDisable();
        p.lyTarget = 'scy';
        for (let i = 0; i < 8; i++) this.lyBuffer.set(d.sineWave, i * 32);
        m.fill(0, 0, 0x60);
        for (let i = 0; i < 16; i++) {
          m[0x60 + i * 2] = 0x20;
          m[0x60 + i * 2 + 1] = 0x21;
        }
        m.fill(0x10, 0x80, 0x80 + 0x300);
        this.spawn(5, 0xf8, 0x40);
        this.enable(true);
        this.timer = 88;
        this.scene++;
        return;
      case 7: {
        if (this.timerExpired()) {
          this.maskCurrent();
          this.scene++;
          return;
        }
        hw.scx = (hw.scx + 2) & 0xff;
        const first = this.lyBuffer[0];
        this.lyBuffer.copyWithin(0, 1);
        this.lyBuffer[0xff] = first;
        this.copyLy = true; // Request7TileTransferFromC810ToC710
        return;
      }
      case 8:
        yield* this.blankAndDisable();
        p.lyTarget = undefined;
        this.bars();
        this.spawn(3, 0x58, 0x58);
        this.enable(false);
        this.timer = 128;
        this.scene++;
        return;
      case 10: {
        yield* this.blankAndDisable();
        p.lyTarget = undefined;
        m.fill(0);
        m.fill(2, 0, 0x100);
        const box = (map: number[], x: number, y: number, h: number, w: number) => {
          for (let r = 0; r < h; r++) for (let i = 0; i < w; i++) m[(y + r) * 32 + x + i] = map[r * w + i];
        };
        box(d.tilemapSky, 0, 8, 6, 20);
        box(d.tilemapCloud, 12, 4, 3, 4);
        box(d.tilemapSmall, 3, 7, 2, 2);
        this.spawn(6, 0x58, 0x98);
        this.enable(true);
        this.timer = 128;
        this.scene++;
        return;
      }
      case 11:
        if (this.timerExpired()) {
          this.maskCurrent();
          this.scene++;
          return;
        }
        if (this.timer & 7) return;
        // the drifting clouds: four tiles copied to $9600 at VBlank
        this.cloudTiles = d.clouds.slice(((this.timer & 8) << 3) * 4, ((this.timer & 8) << 3) * 4 + 4 * 64);
        return;
      case 12: {
        yield* this.blankAndDisable();
        p.lyTarget = undefined;
        this.bars();
        // the 8x12 close-up at (5, 6) from tile 4, each row 16 tiles on
        for (let r = 0, t = 4; r < 8; r++, t += 16) for (let i = 0; i < 12; i++) m[(6 + r) * 32 + 5 + i] = t + i;
        m[6 * 32 + 4] = 0x03;
        m[7 * 32 + 4] = 0x74;
        m[0x1a5] = 0x00;
        this.spawn(9, 0x58, 0x60);
        this.enable(false);
        this.timer = 128;
        this.scene++;
        return;
      }
      case 13:
        if (!this.timerExpired()) return;
        this.objs.spawn(0x0a, 0x58, 0x68);
        this.scene++;
        return;
      case 14: {
        const a = d.thunderPals[this.timer++];
        if (a !== 0xff) {
          p.bgp = p.obp0 = a;
          p.obp1 = a & 0xf0;
          return;
        }
        this.maskAll();
        hw.clearOam();
        hw.tileMap.fill(1, 0, 4 * 20);
        hw.tileMap.fill(0, 4 * 20, 14 * 20);
        hw.tileMap.fill(1, 14 * 20, 18 * 20);
        hw.autoBgDest = 0x9800;
        hw.autoBgTransfer = true;
        yield* hw.delayFrames(3);
        hw.autoBgTransfer = false;
        p.bgp = p.obp0 = 0xe4;
        this.spawn(7, 0x58, 0x58);
        this.scene++;
        this.timer = 0x28;
        return;
      }
      case 15:
        if (!this.timerExpired()) {
          if (this.timer & 3) return;
          p.obp0 ^= 0xff;
          p.bgp ^= 3;
          return;
        }
        p.lyTarget = undefined;
        p.bgp = p.obp0 = 0xe4;
        this.scene++;
        // falls through into scene 16
        yield* this.fadeStep();
        return;
      case 16:
        yield* this.fadeStep();
        return;
      case 17:
        yield* hw.delayFrames(64);
        this.scene |= 0x80;
        return;
    }
  }

  /** YellowIntroScene16: the fade to white */
  private *fadeStep(): Co {
    const a = this.d.fadePals[this.timer++];
    if (a === 0xff || a === undefined) {
      this.scene++;
      return;
    }
    this.hw.ppu.obp0 = this.hw.ppu.bgp = a;
  }

  /** The VBlank copies this intro requests */
  vblankCopies(): void {
    if (this.copyLy) {
      this.hw.ppu.lyOverrides.set(this.lyBuffer.subarray(0x10, 0x10 + 7 * 16), 0x10);
      this.copyLy = false;
    }
    if (this.cloudTiles) {
      this.hw.ppu.loadTiles(0x160, this.cloudTiles, 4);
      this.cloudTiles = undefined;
    }
  }
}

/** PlayIntroScene */
function* playIntroScene(e: Engine, hw: GbHardware): Co {
  const d = e.bundle.intro;
  const p = hw.ppu;
  // InitYellowIntroGFXAndMusic
  hw.scx = hw.scy = 0;
  hw.autoBgDest = 0x9800;
  hw.tileMap.fill(1);
  hw.tileMap.fill(0, 4 * 20, 14 * 20);
  hw.autoBgTransfer = true;
  yield* hw.delayFrames(3);
  hw.autoBgTransfer = false;
  p.loadTiles(0x00, d.graphics2);
  p.loadTiles(0x100, d.graphics1);
  const intro = new YellowIntro(e, hw, d);
  intro.objs.clear();
  e.hooks.palette?.(c('palette', 'PAL_MEWMON')); // SET_PAL_GENERIC
  e.playMusic('MUSIC_YELLOW_INTRO');
  yield* hw.vblank();
  const js = new LowSensitivity(e);
  for (;;) {
    if (intro.scene & 0x80) break;
    if (js.read(e) & (PAD_A | PAD_B | PAD_START)) break;
    yield* intro.runScene();
    intro.objs.oamOffset = 0;
    intro.objs.keepAttributes = intro.scene === 7;
    intro.objs.run();
    intro.vblankCopies();
    yield* hw.vblank();
  }
  // .go_to_title_screen
  p.bgp = p.obp0 = p.obp1 = 0;
  p.lyTarget = undefined;
  yield* hw.vblank();
  hw.wy = 0x90;
  intro.objs.clear();
  hw.tileMap.fill(0);
  hw.clearOam();
  hw.autoBgTransfer = true;
  yield* hw.delayFrames(3);
  hw.autoBgTransfer = false;
}
