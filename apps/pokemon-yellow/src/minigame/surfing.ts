/**
 * Pikachu's Beach, the Surfing Pikachu minigame (engine/minigame/surfing_pikachu.asm),
 * driven on the small PPU: the intro, the course (waves built column by column
 * from metatile slices, Pikachu riding the wave height, jumps, flips and
 * landings), the results screen with the high score, and the printed
 * high-score card (engine/printer/printer.asm).
 */
import type { Co, Engine } from '../engine/Engine';
import type { SurfingData } from '../data/schema';
import { Ppu, type OamEntry } from '../gb/ppu';
import {
  AnimatedObjects,
  ANIM_OBJ_FIELD_B,
  ANIM_OBJ_FIELD_C,
  ANIM_OBJ_FIELD_D,
  ANIM_OBJ_FIELD_E,
  ANIM_OBJ_FRAME_SET,
  ANIM_OBJ_INDEX,
  ANIM_OBJ_X_COORD,
  ANIM_OBJ_Y_COORD,
  ANIM_OBJ_Y_OFFSET,
} from '../gb/animatedObjects';
import { PAD_A, PAD_LEFT, PAD_RIGHT, PAD_SELECT } from '../engine/pad';
import { isSurfingPikachuInParty } from '../game/pikachu';
import { playPikachuCry, pikachuCry } from '../engine/pikachuEmotions';
import { encodePlain } from '../ui/TextPrinter';
import { c } from '../rom/constants';

const FLAT_WATER_Y = 0x74;
const CENTER_X = 160 / 2 + 8;

const enum State {
  Riding,
  Jumping,
  Landing,
  Crashed,
  GameEnd,
  InitResults,
  Results,
}

/** wPikachuMapScriptFlags (kept in vars) */
const SURF_SELECT = 1 << 1;
const PAUSE_IGT = 1 << 0;

const bcdDec = (v: number) => {
  // sub 1 / daa on a non-zero BCD byte
  const lo = v & 0xf;
  return lo ? v - 1 : ((v >> 4) - 1) * 16 + 9;
};

/** BCD add with carry: [result, carry] */
function bcdAdd(a: number, b: number, carryIn = 0): [number, number] {
  const dec = (a >> 4) * 10 + (a & 0xf) + (b >> 4) * 10 + (b & 0xf) + carryIn;
  const out = dec % 100;
  return [((out / 10) | 0) * 16 + (out % 10), dec >= 100 ? 1 : 0];
}

class Surfing {
  readonly ppu = new Ppu();
  readonly shadowOam: OamEntry[] = Array.from({ length: 40 }, () => ({ y: 0, x: 0, tile: 0, attr: 0 }));
  readonly objs: AnimatedObjects;
  readonly d: SurfingData;
  /** wTileMap and hAutoBGTransferEnabled (copied to vBGMap0 a third per frame) */
  readonly tileMap = new Uint8Array(20 * 18);
  autoBgTransfer = false;
  private autoBgPart = 0;
  /** hSCX / hSCY / hWY written to the PPU at VBlank */
  scx = 0;
  scy = 0;
  wy = 144;
  /** RedrawRowOrColumn (column mode) and VBlankCopy of the BG map read buffer */
  private redrawDest = -1;
  private readonly redrawSrc = new Uint8Array(40);
  private copySource = -1;
  // ---- wSurfingMinigame* variables
  routine = 0;
  routineDelay = 0;
  gameOver = false;
  gameOverDelay = 0;
  speed = 0; // 8.8 pixels per frame
  hp = [0, 0]; // little-endian BCD
  distance = [0, 0, 0];
  objectHeight = 0;
  readonly waveHeight = new Uint8Array(20);
  waveRandom = 0;
  waveFunction = 0;
  readonly readBuffer = new Uint8Array(16);
  scxFraction = 0;
  scx2 = 0;
  scxHi = 0;
  xOffset = 0;
  pikachuState = State.Riding;
  crashTimer = 0;
  jumpMagnitude = 0;
  jumpFraction = 0;
  jumpDescending = false;
  radnessMeter = 0;
  trickFlags = 0;
  radness = [0, 0];
  total = [0, 0];
  boardAngleTimer = 0;
  boardAngleOffset = 0;
  boardAngleDecreasing = false;
  waterSprayCounter = 0;
  cloudFraction = 0;
  musicTempoEnabled = false;
  introFinished = false;
  /** hFrameCounter / hJoy5 (held input sampled every third frame) */
  private frameCounter = 0;
  joy5 = 0;

  constructor(readonly e: Engine) {
    this.d = e.bundle.surfing;
    this.objs = new AnimatedObjects(
      { spawn: this.d.spawn, frames: this.d.frames, oam: this.d.oam },
      [() => {}, (o) => this.pikachuFn(o), (o) => this.moveBannerToCenter(o), (o) => this.flippingPika(o), (o) => this.introPikachu(o)],
      this.shadowOam,
    );
  }

  // ------------------------------------------------------------------ hardware glue
  /** DelayFrame: everything the VBlank handler does for this screen, then one frame. */
  *delayFrame(): Co {
    const p = this.ppu;
    p.scx = this.scx;
    p.scy = this.scy;
    p.wy = this.wy;
    if (this.autoBgTransfer) {
      // AutoBgMapTransfer: rows 0-5, 6-11, 12-17 on successive frames
      for (let y = this.autoBgPart * 6; y < this.autoBgPart * 6 + 6; y++) for (let x = 0; x < 20; x++) p.bgMaps[0][y * 32 + x] = this.tileMap[y * 20 + x];
      this.autoBgPart = (this.autoBgPart + 1) % 3;
    }
    if (this.redrawDest >= 0) {
      let at = this.redrawDest;
      for (let r = 0; r < 18; r++) {
        p.bgMaps[0][at & 0x3ff] = this.redrawSrc[r * 2];
        p.bgMaps[0][(at + 1) & 0x3ff] = this.redrawSrc[r * 2 + 1];
        at += 32;
      }
      this.redrawDest = -1;
    }
    if (this.copySource >= 0) {
      for (let i = 0; i < 16; i++) {
        const a = (this.copySource + i) & 0x7ff;
        this.readBuffer[i] = p.bgMaps[a >> 10][a & 0x3ff];
      }
      this.copySource = -1;
    }
    this.shadowOam.forEach((o, i) => Object.assign(p.oam[i], o)); // OAM DMA
    if (this.frameCounter) this.frameCounter--;
    this.e.screen.ppuFrameReady();
    yield;
  }

  joypad(): { held: number; pressed: number } {
    this.e.joypad();
    return { held: this.e.ram.joyHeld, pressed: this.e.ram.joyPressed };
  }

  sound(name: string): void {
    this.e.env.playSound(name);
  }

  // ------------------------------------------------------------------ the intro
  *intro(): Co {
    const p = this.ppu;
    this.tileMap.fill(0);
    this.shadowOam.forEach((o) => (o.y = o.x = o.tile = o.attr = 0));
    this.autoBgTransfer = false;
    this.objs.clear();
    p.loadTiles(0x80, this.d.graphics3, 144);
    this.objs.spawn(0x0c, CENTER_X, FLAT_WATER_Y);
    // DrawSurfingPikachuMinigameIntroBackground
    this.tileMap.fill(0xff);
    this.tileMap.set(this.d.beachIntro, 6 * 20);
    for (let r = 0; r < 6; r++) for (let x = 0; x < 12; x++) this.tileMap[r * 20 + 4 + x] = this.d.title[r * 12 + x];
    for (let r = 0; r < 3; r++) for (let x = 0; x < 15; x++) this.tileMap[(7 + r) * 20 + 3 + x] = 0xff;
    this.tileMap.set(this.d.useControlPad, 7 * 20 + 3);
    this.tileMap.set(this.d.toSurfRad, 9 * 20 + 4);
    this.scx = this.scy = 0;
    this.wy = 144;
    // SET_PAL_SURFING_PIKACHU_MINIGAME: the title box gets PAL_PIKACHUS_BEACH_TITLE
    const P = (n: string) => c('palette', n);
    this.e.hooks.paletteLayout?.([P('PAL_PIKACHUS_BEACH'), P('PAL_PIKACHUS_BEACH_TITLE'), P('PAL_PIKACHUS_BEACH'), P('PAL_PIKACHUS_BEACH')], [
      { pal: 1, x0: 4, y0: 0, x1: 15, y1: 5 },
    ]);
    Object.assign(p, { lcdOn: true, bgOn: true, objOn: true, winOn: true, bgMap: 0, winMap: 1, tileData8000: false, lyTarget: undefined });
    this.autoBgTransfer = true;
    for (let i = 0; i < 3; i++) yield* this.delayFrame();
    this.setPals();
    yield* this.delayFrame();
    this.e.playMusic('MUSIC_SURFING_PIKACHU');
    this.introFinished = false;
    while (!this.introFinished) {
      this.objs.oamOffset = 0;
      this.objs.run();
      yield* this.delayFrame();
    }
  }

  /** SurfingPikachuMinigame_SetBGPals (SGB) and the OBJ palettes */
  setPals(): void {
    this.ppu.bgp = 0xe4;
    this.ppu.obp0 = 0xe4;
    this.ppu.obp1 = 0xe0;
  }

  /** SurfingMinigameAnimatedObjectFn_IntroAnimationPikachu */
  private introPikachu(o: Uint8Array): void {
    const b = o[ANIM_OBJ_FIELD_B];
    o[ANIM_OBJ_FIELD_B] = (b + 1) & 0xff;
    if (!(b & 1)) return;
    if (o[ANIM_OBJ_X_COORD] === 0xc0) {
      this.introFinished = true;
      o[ANIM_OBJ_INDEX] = 0;
      return;
    }
    o[ANIM_OBJ_X_COORD]++;
  }

  // ------------------------------------------------------------------ the course
  /** SurfingPikachuMinigame_LoadGFXAndLayout */
  loadGfxAndLayout(): void {
    const p = this.ppu;
    this.tileMap.fill(0);
    this.shadowOam.forEach((o) => (o.y = o.x = o.tile = o.attr = 0));
    this.resetVariables();
    this.ppu.lyOverrides.fill(0);
    this.autoBgTransfer = false;
    this.objs.clear();
    p.loadTiles(0x100, this.d.graphics1, 80);
    p.loadTiles(0x00, this.d.graphics2, 256);
    p.bgMaps[0].fill(0);
    p.bgMaps[1].fill(0);
    p.bgMaps[0].fill(0x0b, 6 * 32, 18 * 32);
    this.objs.spawn(1, CENTER_X, FLAT_WATER_Y);
    this.objectHeight = FLAT_WATER_Y;
    // SurfingMinigame_InitScanlineOverrides
    for (let i = 0; i < 0x100; i++) p.lyOverrides[i] = this.d.lyInitialSine[i & (this.d.lyInitialSine.length - 1)];
    this.scx = this.scy = 0;
    this.wy = 0x7e;
    p.lyTarget = 'scy';
    this.speed = 0x40;
    this.hp = [0x00, 0x60];
    this.waveHeight.fill(FLAT_WATER_Y);
    // SurfingPikachuMinigame_InitStaticSpriteLayout
    const row = (first: number, tiles: number[], y: number, x: number) =>
      tiles.forEach((t, i) => Object.assign(this.shadowOam[first + i], { y, x: x + i * 8, tile: t, attr: 0 }));
    row(0, [0xd0, 0xd0, 0xd0, 0xd0], 0x97, 0x80);
    row(4, [0xfe], 0x96, 0x50);
    row(5, [0xec, 0xed, 0xed, 0xee, 0xef], 0x14, 0x20);
    row(10, [0xec, 0xed, 0xee, 0xef], 0x20, 0x80);
    // SurfingPikachuMinigame_DrawStaticTilemapLayout (the window)
    this.d.statusBar.forEach((t, i) => (p.bgMaps[1][32 + 1 + i] = t));
    p.bgMaps[1][1] = 0x15;
    p.bgMaps[1][2] = 0x16;
    p.bgMaps[1][32 + 12] = 0x1b;
    p.bgMaps[1][32 + 13] = 0x1c;
    Object.assign(p, { lcdOn: true, bgOn: true, objOn: true, winOn: true, bgMap: 0, winMap: 1, tileData8000: false });
    this.setPals();
  }

  private resetVariables(): void {
    Object.assign(this, {
      routine: 0,
      routineDelay: 0,
      gameOver: false,
      gameOverDelay: 0,
      speed: 0,
      hp: [0, 0],
      distance: [0, 0, 0],
      objectHeight: 0,
      waveRandom: 0,
      waveFunction: 0,
      scxFraction: 0,
      scx2: 0,
      scxHi: 0,
      xOffset: 0,
      pikachuState: State.Riding,
      crashTimer: 0,
      jumpMagnitude: 0,
      jumpFraction: 0,
      jumpDescending: false,
      radnessMeter: 0,
      trickFlags: 0,
      radness: [0, 0],
      total: [0, 0],
      boardAngleTimer: 0,
      boardAngleOffset: 0,
      boardAngleDecreasing: false,
      waterSprayCounter: 0,
      cloudFraction: 0,
      musicTempoEnabled: false,
    });
    this.waveHeight.fill(0);
    this.readBuffer.fill(0);
  }

  /** SurfingPikachuLoop */
  *loop(): Co {
    this.loadGfxAndLayout();
    yield* this.delayFrame();
    this.e.hooks.palette?.(c('palette', 'PAL_PIKACHUS_BEACH')); // SET_PAL_SURFING_PIKACHU_TITLE
    for (;;) {
      if (this.routine & 0x80) return;
      const { held, pressed } = this.joypad();
      // SurfingPikachu_GetJoypad_3FrameBuffer
      // (hFrameCounter counts down at VBlank, so this samples every other frame)
      if (this.frameCounter) this.joy5 = 0;
      else {
        this.joy5 = held;
        this.frameCounter = 2;
      }
      if (this.e.env.getVar('wPikachuMapScriptFlags') & SURF_SELECT && pressed & PAD_SELECT) return;
      this.runRoutine(pressed);
      this.objs.oamOffset = 15 * 4;
      this.objs.run();
      this.moveClouds();
      yield* this.delayFrame();
    }
  }

  private runRoutine(pressed: number): void {
    switch (this.routine) {
      case 0: // SurfingMinigame_StartGame
        this.objs.spawn(2, 0xe0, 0x48);
        this.routine++;
        this.musicTempoEnabled = true;
        return;
      case 1:
        return this.runGame();
      case 2: // SurfingMinigame_WaitToShowResults
        if (!this.runDelayTimer()) {
          this.waveRandom = 0;
          this.updateLYOverrides();
          this.setPikachuHeight();
          this.readBGMapBuffer();
          this.coastAfterGoal();
          return;
        }
        this.routine++;
        this.scx = 0x90;
        this.waveFunction = 0x72;
        this.pikachuState = State.GameEnd;
        this.ppu.lyTarget = undefined;
        this.scxFraction = this.scx2 = this.scxHi = 0;
        return;
      case 3: // SurfingMinigame_ScrollToResultsScreen
        if (this.scx) {
          this.updateLYOverrides();
          this.setPikachuHeight();
          this.readBGMapBuffer();
          this.scx = (this.scx - 4) & 0xff;
          this.xOffset = 256 - 32;
          this.generateBGMap();
          return;
        }
        this.speed = 0;
        this.routine++;
        this.pikachuState = State.InitResults;
        return;
      case 4:
        this.drawResultsScreen();
        this.routineDelay = 32;
        this.routine++;
        return;
      case 5:
        if (!this.runDelayTimer()) return;
        this.placeTiles(2, 2, this.d.strings.hpLeft);
        this.bcdPrintHPLeft();
        this.routineDelay = 64;
        this.routine++;
        return;
      case 6:
        if (!this.runDelayTimer()) return;
        this.placeTiles(2, 4, this.d.strings.radness);
        this.bcdPrintRadness();
        this.routineDelay = 64;
        this.routine++;
        return;
      case 7:
        if (!this.runDelayTimer()) return;
        this.placeTiles(2, 6, this.d.strings.total);
        this.bcdPrintRadness();
        this.bcdPrintTotal();
        this.routineDelay = 64;
        this.routine++;
        return;
      case 8: {
        if (!this.runDelayTimer()) return;
        const done = this.addRemainingHPToTotal();
        this.bcdPrintTotal();
        if (!done) return;
        this.routineDelay = 64;
        this.routine++;
        return;
      }
      case 9: {
        if (!this.runDelayTimer()) return;
        const done = this.addRadnessToTotal();
        this.bcdPrintTotal();
        if (!done) return;
        this.routineDelay = 128;
        this.routine++;
        if (!this.didPlayerGetAHighScore()) return;
        this.placeTiles(6, 8, this.d.strings.hiScore);
        this.pikachuState = State.Results;
        return;
      }
      case 10:
        if (this.runDelayTimer()) this.routine++;
        return;
      case 11: // SurfingMinigame_ExitOnPressA
        this.updateLYOverrides();
        if (pressed & PAD_A) this.routine |= 0x80;
        return;
      case 12: // SurfingMinigame_GameOver
        this.updateLYOverrides();
        this.setPikachuHeight();
        this.readBGMapBuffer();
        this.scrollAndGenerateBGMap();
        if (this.gameOverDelay) {
          this.gameOverDelay--;
          return;
        }
        if (pressed & PAD_A) this.routine |= 0x80;
        return;
    }
  }

  /** SurfingMinigame_RunGame */
  private runGame(): void {
    if (this.distance[0] >= 0x18) {
      this.routine++;
      this.musicTempoEnabled = false;
      this.routineDelay = 192;
      return;
    }
    if (!this.hp[0] && !this.hp[1]) {
      this.gameOver = true;
      this.routine = 0x0c;
      this.gameOverDelay = 0x80;
      const o = this.objs.spawn(0x0b, CENTER_X, 0x88);
      if (o) {
        o[ANIM_OBJ_Y_OFFSET] = 0x80;
        o[ANIM_OBJ_FIELD_B] = 0x80;
        o[ANIM_OBJ_FIELD_C] = 0x30;
      }
      this.musicTempoEnabled = false;
      return;
    }
    this.waveRandom = this.e.random();
    this.updateLYOverrides();
    this.setPikachuHeight();
    this.readBGMapBuffer();
    this.scrollAndGenerateBGMap();
    this.updatePikachuDistance();
    this.deduct1HP();
    this.drawHP();
  }

  /** SurfingMinigame_RunDelayTimer: true (carry) once the delay has run out */
  private runDelayTimer(): boolean {
    if (!this.routineDelay) return true;
    this.routineDelay--;
    return false;
  }

  /** SurfingMinigame_UpdatePikachuDistance */
  private updatePikachuDistance(): void {
    const v = ((this.distance[1] << 8) | this.distance[2]) + this.speed;
    this.distance[1] = (v >> 8) & 0xff;
    this.distance[2] = v & 0xff;
    if (v < 0x10000) return;
    this.distance[0]++;
    this.shadowOam[4].x = (this.shadowOam[4].x - 2) & 0xff;
  }

  /** SurfingMinigame_UpdateLYOverrides: rotate the water rows' scroll values */
  private updateLYOverrides(): void {
    const ly = this.ppu.lyOverrides;
    const first = ly[16];
    for (let i = 16; i < 143; i++) ly[i] = ly[i + 1];
    ly[143] = first;
  }

  /** SurfingMinigame_ReadBGMapBuffer: the tiles nine columns in at Pikachu's height, read at VBlank */
  private readBGMapBuffer(): void {
    const col = ((this.scx + 9 * 8) & 0xff) >> 3;
    const row = this.objectHeight >> 3;
    this.copySource = (row * 32 + col) & 0x3ff;
  }

  /** SurfingMinigame_SetPikachuHeight */
  private setPikachuHeight(): void {
    const h = this.waveHeight[this.scx & 8 ? 8 : 7];
    const tile = this.readBuffer[0];
    const sub = this.scx & 7;
    if (tile === 0x06 || tile === 0x14) this.objectHeight = (h - sub) & 0xff;
    else if (tile === 0x07) this.objectHeight = (h + sub) & 0xff;
    else this.objectHeight = h;
  }

  /** SurfingMinigame_Deduct1HP */
  private deduct1HP(): void {
    if (this.hp[0]) {
      this.hp[0] = bcdDec(this.hp[0]);
      return;
    }
    this.hp[0] = 0x99;
    if (this.hp[1]) this.hp[1] = bcdDec(this.hp[1]);
    else this.hp[1] = 0x99;
  }

  /** SurfingMinigame_DrawHP */
  private drawHP(): void {
    const o = this.shadowOam;
    o[0].tile = 0xd0 + (this.hp[1] >> 4);
    o[1].tile = 0xd0 + (this.hp[1] & 0xf);
    o[2].tile = 0xd0 + (this.hp[0] >> 4);
    o[3].tile = 0xd0 + (this.hp[0] & 0xf);
  }

  /** SurfingMinigame_MoveClouds */
  private moveClouds(): void {
    const v = this.cloudFraction + this.speed;
    this.cloudFraction = v & 0xff;
    const d = (v >> 8) & 0xff;
    for (let i = 5; i < 14; i++) this.shadowOam[i].x = (this.shadowOam[i].x + d) & 0xff;
  }

  /** SurfingMinigame_CoastAfterGoal: 9 pixels per frame */
  private coastAfterGoal(): void {
    this.xOffset = 0xa0;
    this.scrollBy(0x0900);
    this.generateBGMap();
  }

  /** SurfingMinigame_ScrollAndGenerateBGMap: 1.5 pixels per frame */
  private scrollAndGenerateBGMap(): void {
    this.xOffset = 0xa0;
    this.scrollBy(0x0180);
    this.generateBGMap();
  }

  private scrollBy(step: number): void {
    const v = ((this.scx << 8) | this.scxFraction) + step;
    this.scxFraction = v & 0xff;
    this.scx = (v >> 8) & 0xff;
  }

  /** SurfingMinigame_GenerateBGMap: a new 2-tile column of the course every 16 pixels */
  private generateBGMap(): void {
    if (this.scx === this.scx2) return;
    this.scx2 = this.scx;
    const hi = this.scx & 0xf0;
    if (hi === this.scxHi) return;
    this.scxHi = hi;
    const { heights, pattern } = this.waveDataPointers();
    this.waveHeight.copyWithin(0, 2);
    this.waveHeight[18] = heights[0];
    this.waveHeight[19] = heights[1];
    pattern.forEach((m, i) => this.redrawSrc.set(this.d.metatiles.slice(m * 4, m * 4 + 4), i * 4));
    this.redrawDest = (((this.scx + this.xOffset) & 0xf0) >> 3) & 0x3ff;
  }

  /** SurfingMinigame_GetWaveDataPointers */
  private waveDataPointers(): { heights: [number, number]; pattern: number[] } {
    const flat = { heights: [FLAT_WATER_Y, FLAT_WATER_Y] as [number, number], pattern: this.flatPattern() };
    const fn = this.d.waveFunctions[this.waveFunction];
    if (!fn || fn.kind === 'choose') {
      // SurfingMinigame_ChooseNextWaveSequence
      const section = this.distance[0];
      if (section === 0x16) this.waveFunction = 0x6a; // the Big Kahuna
      else if (section < 0x16 && this.waveRandom) this.waveFunction = this.d.waveSequenceStarts[(this.waveRandom - 1) & 7];
      return flat;
    }
    if (fn.next === 'advance') this.waveFunction++;
    else if (fn.next === 'reset') this.waveFunction = 0;
    return { heights: fn.heights, pattern: fn.pattern };
  }

  private flatPattern(): number[] {
    const f = this.d.waveFunctions.find((w) => w.kind === 'pattern' && w.next === 'stay');
    return f && f.kind === 'pattern' ? f.pattern : [0, 0, 0, 1, 1, 1, 1, 1];
  }

  // ------------------------------------------------------------------ Pikachu
  /** SurfingMinigameAnimatedObjectFn_Pikachu */
  private pikachuFn(o: Uint8Array): void {
    switch (this.pikachuState) {
      case State.Riding:
        return this.updateRiding(o);
      case State.Jumping:
        return this.updateJumping(o);
      case State.Landing:
        return this.updateLanding(o);
      case State.Crashed:
        if (this.crashTimer) {
          this.crashTimer--;
          o[ANIM_OBJ_Y_COORD] = this.objectHeight;
          return;
        }
        this.pikachuState = State.Riding;
        AnimatedObjects.setFrameset(o, 4);
        return;
      case State.GameEnd:
        o[ANIM_OBJ_Y_COORD] = this.objectHeight;
        this.updateSurfingFrame(o);
        return;
      case State.InitResults:
        AnimatedObjects.setFrameset(o, 0x0f);
        o[ANIM_OBJ_FIELD_C] = 0;
        return;
      case State.Results: {
        const a = o[ANIM_OBJ_FIELD_C];
        o[ANIM_OBJ_FIELD_C] = (a + 2) & 0xff;
        o[ANIM_OBJ_Y_OFFSET] = (a & 0x3f) >= 0x20 ? this.sine(a, 0x10) : 0;
        return;
      }
    }
  }

  private updateRiding(o: Uint8Array): void {
    if (this.gameOver) {
      this.speed = 0;
      this.pikachuState = State.GameEnd;
      this.updateSurfingFrame(o);
      return;
    }
    this.spawnWaterSpray(o);
    o[ANIM_OBJ_Y_COORD] = this.objectHeight;
    if (!this.tryStartJump()) {
      this.updateSurfingFrame(o);
      this.speedUp();
      return;
    }
    this.updateSurfingFrame(o);
    this.pikachuState = State.Jumping;
    o[ANIM_OBJ_FIELD_C] = o[ANIM_OBJ_FIELD_D] = o[ANIM_OBJ_FIELD_E] = 0;
    this.radnessMeter = 0;
    this.trickFlags = 0;
    this.sound('surfing_jump');
  }

  private updateJumping(o: Uint8Array): void {
    this.dpadAction(o);
    if (!this.updatePikachuHeight(o)) return;
    if (this.tileInteraction(o)) {
      this.pikachuState = State.Crashed;
      this.crashTimer = 0x60;
      AnimatedObjects.setFrameset(o, 0x10);
      this.sound('surfing_crash');
      return;
    }
    this.calculateAndAddRadnessFromStunt(o);
    o[ANIM_OBJ_FIELD_C] = 0;
    this.pikachuState = State.Landing;
  }

  private updateLanding(o: Uint8Array): void {
    const cnt = o[ANIM_OBJ_FIELD_C];
    if (cnt >= 0x20) {
      o[ANIM_OBJ_Y_OFFSET] = 0;
      this.pikachuState = State.Riding;
      return;
    }
    o[ANIM_OBJ_FIELD_C] = cnt + 4;
    o[ANIM_OBJ_Y_OFFSET] = this.sine(cnt, 4); // a still holds the count from before the increments
    this.spawnWaterSpray(o);
    o[ANIM_OBJ_Y_COORD] = this.objectHeight;
  }

  /** SurfingMinigame_DPadAction: flips while in the air */
  private dpadAction(o: Uint8Array): void {
    if (this.joy5 & PAD_LEFT) {
      o[ANIM_OBJ_FIELD_E] = 0;
      const n = o[ANIM_OBJ_FIELD_D]++;
      if (n >= 0x0b) {
        this.startTrick(o);
        this.trickFlags |= 1;
      }
      const f = o[ANIM_OBJ_FRAME_SET];
      o[ANIM_OBJ_FRAME_SET] = f >= 0x0e ? 1 : f + 1;
    } else if (this.joy5 & PAD_RIGHT) {
      o[ANIM_OBJ_FIELD_D] = 0;
      const n = o[ANIM_OBJ_FIELD_E]++;
      if (n >= 0x0d) {
        this.startTrick(o);
        this.trickFlags |= 2;
      }
      const f = o[ANIM_OBJ_FRAME_SET];
      o[ANIM_OBJ_FRAME_SET] = f === 1 ? 0x0e : f - 1;
    }
  }

  private startTrick(o: Uint8Array): void {
    this.radnessMeter = Math.min(this.radnessMeter + 1, 3);
    o[ANIM_OBJ_FIELD_D] = o[ANIM_OBJ_FIELD_E] = 0;
    this.sound('surfing_flip');
  }

  /** SurfingMinigame_TileInteraction: true for a wipeout */
  private tileInteraction(o: Uint8Array): boolean {
    const angle = o[ANIM_OBJ_FRAME_SET];
    const tile = this.readBuffer[0];
    type Landing = 'clean' | 'rough' | 'hard' | 'wipe';
    const W: Landing = 'wipe';
    let table: Landing[]; // by frameset 1..7
    if (tile === 0x06) table = [W, W, W, 'hard', 'rough', 'clean', 'rough'];
    else if (tile === 0x14 || tile === 0x12) table = [W, 'hard', 'rough', 'clean', 'clean', 'rough', 'hard'];
    else if (tile === 0x07) table = ['rough', 'clean', 'rough', 'hard', W, W, W];
    else table = [W, 'hard', 'rough', 'clean', 'rough', 'hard', W];
    const r = table[angle - 1] ?? W;
    if (r === W) {
      this.speed = 0x40;
      return true;
    }
    if (r === 'hard') this.reduceSpeed(0x80);
    else if (r === 'rough') this.reduceSpeed(0x40);
    this.sound('surfing_land');
    return false;
  }

  private speedUp(): void {
    if (this.speed >> 8 >= 2) return;
    this.speed += 2; // 1/128
  }

  /** SurfingMinigame_ReduceSpeedBy64 / 128 (by 0.25 / 0.5 pixels) */
  private reduceSpeed(by: number): void {
    if (this.speed < by) {
      this.speed &= 0xff00; // only the fraction is cleared
      return;
    }
    this.speed -= by;
  }

  /** SurfingMinigame_TryStartJump */
  private tryStartJump(): boolean {
    const sub = this.scx & 7;
    if (sub < 3 || sub >= 5 || this.readBuffer[0] !== 0x14) return false;
    const v = ((this.speed << 3) >> 8) & 0xff; // GetSpeedDividedBy32
    if (v < 0x0a) return false;
    this.jumpMagnitude = v;
    this.jumpDescending = false;
    this.jumpFraction = 0;
    return true;
  }

  /** SurfingMinigame_UpdateSurfingFrame */
  private updateSurfingFrame(o: Uint8Array): void {
    const sub = this.scx & 7;
    if (sub < 3 || sub >= 5) return;
    const tile = this.readBuffer[0];
    let base: number;
    if (tile === 0x06 || tile === 0x14) base = 6;
    else if (tile === 0x07) base = 2;
    else {
      this.updateBoardAngle();
      o[ANIM_OBJ_FRAME_SET] = 4;
      return;
    }
    o[ANIM_OBJ_FRAME_SET] = (base + this.boardAngleOffset - 1) & 0xff;
  }

  private updateBoardAngle(): void {
    const t = this.boardAngleTimer;
    this.boardAngleTimer = (t + 1) & 0xff;
    if (t & 7) return;
    if (this.boardAngleDecreasing) {
      if (!this.boardAngleOffset) this.boardAngleDecreasing = false;
      else this.boardAngleOffset--;
    } else if (this.boardAngleOffset === 2) this.boardAngleDecreasing = true;
    else this.boardAngleOffset++;
  }

  /** SurfingMinigame_SpawnWaterSpray: every fourth frame */
  private spawnWaterSpray(o: Uint8Array): void {
    const n = this.waterSprayCounter;
    this.waterSprayCounter = (n + 1) & 0xff;
    if (n & 3) return;
    const h = this.waveHeight[this.scx & 8 ? 9 : 8];
    const tile = this.readBuffer[1];
    const sub = this.scx & 7;
    const y = tile === 0x06 || tile === 0x14 ? (h - sub) & 0xff : tile === 0x07 ? (h + sub) & 0xff : h;
    this.objs.spawn(0x0a, o[ANIM_OBJ_X_COORD], y);
  }

  /** SurfingMinigame_UpdatePikachuHeight: the jump arc; true (carry) on touching down */
  private updatePikachuHeight(o: Uint8Array): boolean {
    const yc = () => (o[ANIM_OBJ_Y_COORD] << 8) | o[ANIM_OBJ_FIELD_C];
    const setYc = (v: number) => {
      o[ANIM_OBJ_Y_COORD] = (v >> 8) & 0xff;
      o[ANIM_OBJ_FIELD_C] = v & 0xff;
    };
    if (!this.jumpDescending) {
      if (!this.jumpMagnitude && !this.jumpFraction) {
        this.jumpDescending = true;
        return false;
      }
      const v = (((this.jumpMagnitude << 8) | this.jumpFraction) - 0x80) & 0xffff;
      this.jumpFraction = v & 0xff;
      this.jumpMagnitude = v >> 8;
      const rise = (-(4 * this.jumpMagnitude * this.jumpMagnitude)) & 0xffff;
      setYc((yc() + rise) & 0xffff);
      return false;
    }
    const y = o[ANIM_OBJ_Y_COORD];
    if (y < 144 && y >= this.objectHeight) {
      o[ANIM_OBJ_Y_COORD] = this.objectHeight;
      o[ANIM_OBJ_FIELD_C] = 0;
      return true;
    }
    const v = (((this.jumpMagnitude << 8) | this.jumpFraction) + 0x80) & 0xffff;
    this.jumpFraction = v & 0xff;
    this.jumpMagnitude = v >> 8;
    setYc((yc() + 4 * this.jumpMagnitude * this.jumpMagnitude) & 0xffff);
    return false;
  }

  /** SurfingMinigame_CalculateAndAddRadnessFromStunt */
  private calculateAndAddRadnessFromStunt(o: Uint8Array): void {
    if (!this.radnessMeter) return;
    let type: number;
    if ((this.trickFlags & 3) === 3) {
      if (this.radnessMeter >= 3) {
        for (let i = 0; i < 10; i++) this.addRadness(0x50);
        type = 9;
      } else {
        this.addRadness(0x50);
        this.addRadness(0x50);
        this.addRadness(0x50);
        this.addRadness(0x30);
        type = 8;
      }
    } else {
      // 1, 3, 7 times +50 for one, two, three flips of the same kind
      let n = 0;
      for (let k = 0, e = 1; k < this.radnessMeter; k++, e <<= 1) n += e;
      for (let i = 0; i < n; i++) this.addRadness(0x50);
      type = this.radnessMeter + 3;
    }
    this.objs.spawn(type, o[ANIM_OBJ_X_COORD], (o[ANIM_OBJ_Y_COORD] - 0x10) & 0xff);
  }

  private addRadness(e: number): void {
    const [lo, c1] = bcdAdd(this.radness[0], e);
    const [hi, c2] = bcdAdd(this.radness[1], 0, c1);
    this.radness = c2 ? [0x99, 0x99] : [lo, hi];
  }

  /** SurfingPikachu_Sine: amplitude d times the 64-step sine at a (signed result byte) */
  sine(a: number, d: number): number {
    const i = a & 0x3f;
    const v = (((this.d.sine[i & 0x1f] * d) & 0xffff) >> 8) & 0xff;
    return i >= 0x20 ? -v & 0xff : v;
  }

  /** SurfingMinigame_MoveBannerToCenter */
  private moveBannerToCenter(o: Uint8Array): void {
    if (o[ANIM_OBJ_X_COORD] === CENTER_X) return;
    o[ANIM_OBJ_X_COORD] = (o[ANIM_OBJ_X_COORD] + 4) & 0xff;
  }

  /** SurfingMinigameAnimatedObjectFn_FlippingPika: the "Oh no.." Pikachu bouncing */
  private flippingPika(o: Uint8Array): void {
    const d = o[ANIM_OBJ_FIELD_B];
    if (!d) return;
    o[ANIM_OBJ_FIELD_B] = (d - 2) & 0xff;
    const a = o[ANIM_OBJ_FIELD_C]++;
    let v = this.sine(a, d);
    if (v < 0x80) v = -v & 0xff;
    o[ANIM_OBJ_Y_OFFSET] = v;
  }

  // ------------------------------------------------------------------ results
  private placeTiles(x: number, y: number, tiles: number[]): void {
    this.tileMap.set(tiles, y * 20 + x);
  }

  /** SurfingMinigame_DrawResultsScreen */
  private drawResultsScreen(): void {
    this.tileMap.fill(0);
    this.tileMap.set(this.d.beachOutro, 6 * 20);
    const row = (y: number, l: number, r: number, fill: number) => {
      this.tileMap[y * 20 + 1] = l;
      for (let x = 0; x < 16; x++) this.tileMap[y * 20 + 2 + x] = fill;
      this.tileMap[y * 20 + 18] = r;
    };
    row(1, 0x3b, 0x3c, 0x40);
    for (let y = 2; y <= 8; y++) row(y, 0x3f, 0x3f, 0xff);
    row(9, 0x3d, 0x3e, 0x40);
    for (let i = 5; i < 14; i++) Object.assign(this.shadowOam[i], { y: 0, x: 0, tile: 0, attr: 0 });
    this.autoBgTransfer = true;
  }

  private placeBCD(x: number, y: number, v: number): void {
    this.tileMap[y * 20 + x] = 0xd0 + (v >> 4);
    this.tileMap[y * 20 + x + 1] = 0xd0 + (v & 0xf);
  }

  private pts(x: number, y: number): void {
    this.tileMap.set([0x21, 0x25, 0x26], y * 20 + x); // "Pts"
  }

  private bcdPrintHPLeft(): void {
    this.placeBCD(10, 2, this.hp[1]);
    this.placeBCD(12, 2, this.hp[0]);
    this.pts(15, 2);
  }

  private bcdPrintRadness(): void {
    this.placeBCD(10, 4, this.radness[1]);
    this.placeBCD(12, 4, this.radness[0]);
    this.pts(15, 4);
  }

  private bcdPrintTotal(): void {
    this.placeBCD(10, 6, this.total[1]);
    this.placeBCD(12, 6, this.total[0]);
    this.pts(15, 6);
  }

  private addPointToTotal(): void {
    const [lo, c1] = bcdAdd(this.total[0], 1);
    const [hi, c2] = bcdAdd(this.total[1], 0, c1);
    this.total = c2 ? [0x99, 0x99] : [lo, hi];
  }

  /** SurfingMinigame_AddRemainingHPToTotal: 99 points a frame; true (carry) once HP is used up */
  private addRemainingHPToTotal(): boolean {
    for (let i = 0; i < 99; i++) {
      if (!this.hp[0] && !this.hp[1]) return true;
      this.deduct1HP();
      this.addPointToTotal();
    }
    this.sound('press_ab');
    return false;
  }

  private addRadnessToTotal(): boolean {
    for (let i = 0; i < 99; i++) {
      if (!this.radness[0] && !this.radness[1]) return true;
      const lo = this.radness[0];
      if (lo) this.radness[0] = bcdDec(lo);
      else {
        this.radness[0] = 0x99;
        this.radness[1] = bcdDec(this.radness[1]);
      }
      this.addPointToTotal();
    }
    this.sound('press_ab');
    return false;
  }

  /** DidPlayerGetAHighScore */
  private didPlayerGetAHighScore(): boolean {
    const total = (this.total[1] << 8) | this.total[0];
    const hi = this.e.env.getVar('wSurfingMinigameHiScore');
    const surfer = isSurfingPikachuInParty(this.e.state);
    if (total <= hi) {
      if (surfer) this.pendingCry = pikachuCry(28);
      return false;
    }
    this.e.env.setVar('wSurfingMinigameHiScore', total);
    if (surfer) this.pendingCry = pikachuCry(34);
    this.pendingSound = 'get_item2_4_2';
    return true;
  }
  pendingCry: number | undefined;
  pendingSound: string | undefined;
}

/** SurfingPikachuMinigame: the intro, the game, then back to the map. */
export function* surfingPikachuMinigame(e: Engine): Co {
  const savedCells = e.screen.cells.slice();
  const g = new Surfing(e);
  e.screen.setPpu(g.ppu);
  g.ppu.bgp = g.ppu.obp0 = g.ppu.obp1 = 0; // SurfingPikachuMinigame_BlankPals
  for (let i = 0; i < 3; i++) yield* g.delayFrame();
  yield* g.intro();
  const loop = g.loop();
  for (let r = loop.next(); !r.done; r = loop.next()) {
    // the high-score cries play between frames (they wait for the sound to finish)
    if (g.pendingCry !== undefined) {
      const cry = g.pendingCry;
      g.pendingCry = undefined;
      yield* playPikachuCry(e, cry);
    }
    if (g.pendingSound) {
      g.sound(g.pendingSound);
      g.pendingSound = undefined;
    }
    yield;
  }
  // back to the map
  e.screen.setPpu(undefined);
  e.screen.cells.set(savedCells);
  e.screen.markDirty();
  e.hooks.palette?.(undefined);
  e.playDefaultMusic();
}

/** Printer_PrepareSurfingMinigameHighScoreTileMap: the high-score card on the normal screen. */
export function drawSurfingHighScore(e: Engine): void {
  const s = e.screen;
  const d = e.bundle.surfing;
  s.clear();
  s.fill(0, 0, 20, 18, 0x7f);
  const g = d.highScoreGraphics;
  for (let i = 0; i < g.length / 64; i++) s.setGlyphOverride(i, g.slice(i * 64, i * 64 + 64));
  for (let x = 0; x < 20; x++) {
    s.put(x, 0, x & 1);
    s.put(x, 17, x & 1);
  }
  for (let y = 0; y < 18; y++) {
    s.put(0, y, 2 + (y & 1));
    s.put(19, y, 2 + (y & 1));
  }
  for (const [x, y] of [
    [0, 0],
    [0, 17],
    [19, 0],
    [19, 17],
  ])
    s.put(x, y, 4);
  const box = (map: number[], x: number, y: number, h: number, w: number) => {
    for (let r = 0; r < h; r++) for (let i = 0; i < w; i++) s.put(x + i, y + r, map[r * w + i]);
  };
  box(d.highScore.tilemap1, 10, 8, 3, 8);
  box(d.highScore.tilemap2, 2, 11, 6, 16);
  const put = (x: number, y: number, str: string) => encodePlain(str).forEach((code, i) => s.put(x + i, y, code));
  put(3, 2, d.highScore.pikachusBeach);
  put(9, 4, d.highScore.hiScore);
  put(12, 6, d.highScore.points);
  const name = e.state.player.name;
  put(2 + Math.max(0, 8 - (name.length + 1)), 4, name);
  // CopySurfingMinigameScore: BCD digits as font numbers
  const hi = e.env.getVar('wSurfingMinigameHiScore');
  [hi >> 12, (hi >> 8) & 0xf, (hi >> 4) & 0xf, hi & 0xf].forEach((dgt, i) => s.put(7 + i, 6, (0xf6 + dgt) & 0xff));
  e.hooks.palette?.(c('palette', 'PAL_MEWMON')); // SET_PAL_GENERIC
}

export { PAUSE_IGT, SURF_SELECT };
