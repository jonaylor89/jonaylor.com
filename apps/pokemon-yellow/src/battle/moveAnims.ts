/**
 * Battle animations (engine/battle/animations.asm): PlayAnimation's command
 * streams of subanimations (frame blocks of OAM tiles from the move animation
 * tilesets, with the SUBANIMTYPE_* transforms and FRAMEBLOCKMODE_* timing) and
 * special effects (pic slides, blinks, squishes, palette flashes, falling
 * leaves, water droplets, the wavy screen, ...), the per-animation effects of
 * AnimationIdSpecialEffects, GetMoveSound, and TossBallAnimation.
 *
 * The BG is the battle's tile grid: tile IDs are handled as in VRAM (enemy pic
 * $00-$30, player pic $31-$61, column-major) and mapped to the UI's pic glyph
 * codes; OAM is a 40-entry shadow copy committed as screen objects.
 */
import type { Co, Engine } from '../engine/Engine';
import type { GameBundle, Pic } from '../data/schema';
import type { GbHardware } from '../gb/hardware';
import { c } from '../rom/constants';
import { ENEMY_PIC_BASE, PLAYER_PIC_BASE } from './BattleUI';
import type { ScreenObject } from '../ui/TileScreen';

const FIRST_SE_ID = 0xc0;
const NO_SOUND = 0xff;
const BLANK = 0x7f;
/** Glyph codes of OBJ tiles ($00-$FF in vSprites) */
const OBJ_BASE = 0x400;
const OAM_XFLIP = 0x20;
const OAM_YFLIP = 0x40;
const OFFSCREEN_Y = 160;

const T = { NORMAL: 0, HVFLIP: 1, HFLIP: 2, COORDFLIP: 3, REVERSE: 4, ENEMY: 5 };

interface OamEntry {
  y: number;
  x: number;
  tile: number;
  attr: number;
  /** a glyph code drawn instead of OBJ tile `tile` (the back pic copy of AnimationShakeEnemyHUD) */
  code?: number;
}

const bgpMap = (v: number) => [v & 3, (v >> 2) & 3, (v >> 4) & 3, (v >> 6) & 3];
const s8 = (v: number) => ((v & 0xff) ^ 0x80) - 0x80;

/** What the animations need from the battle (or the trade sequence) */
export interface AnimHost {
  e: Engine;
  bundle: GameBundle;
  whoseTurn: number;
  isTrainerBattle(): boolean;
  setBattlePalette?(): void;
  player: { mon: { species: number } };
  enemy: { mon: { species: number } };
  ui: {
    shakeScreenHorizontally(n: number): Co;
    shakeScreenVertically(n: number): Co;
    setEnemyPic(pic: Pic | undefined): void;
    setPlayerBackPic(pic: Pic | undefined): void;
    save(): Int16Array;
    restore(buf: Int16Array): void;
  };
}

export class MoveAnimator {
  /**
   * When set, the animation drives this hardware instead of the battle's tile
   * screen objects (the trade sequence): OAM, OBJ tiles, palettes and SCX go
   * to the PPU, and each frame is `frame()`.
   */
  hw?: GbHardware;
  frame?: () => Co;
  oam: OamEntry[] = Array.from({ length: 40 }, () => ({ y: 0, x: 0, tile: 0, attr: 0 }));
  bgp = 0xe4;
  obp0 = 0xe4;
  obp1 = 0x6c;
  /** wAnimPalette ($F0 on the Super Game Boy) */
  animPalette = 0xf0;
  animationId = 0;
  animSoundId = NO_SOUND;
  // subanimation state
  private transform = 0;
  private counter = 0;
  private entryIndex = 0;
  private entries: [number, number, number][] = [];
  private frameDelay = 0;
  private fbMode = 0;
  private fbDest = 0;
  private baseY = 0;
  private baseX = 0;
  /** wNumShakes */
  numShakes = 0;
  /** wPokeBallAnimData, wCurItem for the ball toss */
  pokeBallAnimData = 0;
  curItem = 0;

  constructor(readonly b: AnimHost) {}

  private get e() {
    return this.b.e;
  }
  private get d() {
    return this.b.bundle.battleAnims;
  }
  private get screen() {
    return this.b.e.screen;
  }
  private get turn() {
    return this.b.whoseTurn;
  }

  // ------------------------------------------------------------------ hardware
  /** Show the shadow OAM (OAM DMA at V-blank). */
  private commit(): void {
    if (this.hw) {
      this.oam.forEach((o, i) => Object.assign(this.hw!.shadowOam[i], { y: o.y, x: o.x, tile: o.tile, attr: o.attr }));
      this.hw.ppu.obp0 = this.obp0;
      this.hw.ppu.obp1 = this.obp1;
      return;
    }
    const objs: ScreenObject[] = [];
    for (const o of this.oam) {
      if (o.y <= 0 || o.y >= OFFSCREEN_Y || o.x <= 0 || o.x >= 168) continue;
      objs.push({ x: o.x - 8, y: o.y - 16, code: o.code ?? OBJ_BASE + o.tile, flags: o.attr, obp: o.attr & 0x10 ? this.obp1 : this.obp0 });
    }
    this.screen.setObjects(objs);
  }
  private *delay(n: number): Co {
    this.commit();
    for (let i = 0; i < n; i++) {
      if (this.frame) yield* this.frame();
      else yield;
    }
  }
  /** ClearSprites */
  private clearSprites(): void {
    for (const o of this.oam) Object.assign(o, { y: 0, x: 0, tile: 0, attr: 0, code: undefined });
    this.commit();
  }
  /** AnimationCleanOAM */
  private *cleanOam(): Co {
    yield* this.delay(1);
    this.clearSprites();
  }
  private setBgp(v: number): void {
    this.bgp = v;
    if (this.hw) this.hw.ppu.bgp = v;
    else this.screen.setShadeMap(v === 0xe4 ? undefined : bgpMap(v));
  }

  /** LoadMoveAnimationTiles: tileset 0-2 at OBJ tile $31 */
  private loadTileset(n: number): void {
    const px = this.d.tilesets[n];
    if (this.hw) return this.hw.ppu.loadTiles(0x31, px);
    for (let t = 0; t < px.length / 64; t++) this.screen.setGlyphOverride(OBJ_BASE + 0x31 + t, px.slice(t * 64, t * 64 + 64));
  }

  // BG tile IDs as in VRAM ↔ the UI's glyph codes
  private idToCode(id: number): number {
    id &= 0xff;
    if (id < 0x31) return ENEMY_PIC_BASE + (id % 7) * 7 + Math.floor(id / 7);
    if (id < 0x62) return PLAYER_PIC_BASE + ((id - 0x31) % 7) * 7 + Math.floor((id - 0x31) / 7);
    return id;
  }
  private codeToId(code: number): number {
    if (code >= ENEMY_PIC_BASE && code < ENEMY_PIC_BASE + 49) {
      const i = code - ENEMY_PIC_BASE;
      return (i % 7) * 7 + Math.floor(i / 7);
    }
    if (code >= PLAYER_PIC_BASE && code < PLAYER_PIC_BASE + 49) {
      const i = code - PLAYER_PIC_BASE;
      return 0x31 + (i % 7) * 7 + Math.floor(i / 7);
    }
    return code & 0xff;
  }
  private getId(x: number, y: number): number {
    return this.codeToId(this.screen.get(x, y));
  }
  private putId(x: number, y: number, id: number): void {
    if (x < 0 || x >= 20 || y < 0 || y >= 18) return;
    this.screen.put(x, y, this.idToCode(id));
  }
  /** CopyTileIDs: rows x cols IDs from a list plus hBaseTileID at (x, y) */
  private copyTileIds(list: number[], rows: number, cols: number, x: number, y: number, base: number): void {
    for (let r = 0; r < rows; r++) for (let col = 0; col < cols; col++) this.putId(x + col, y + r, list[r * cols + col] + base);
  }
  /** ClearScreenArea (rows h, columns w) */
  private clearArea(x: number, y: number, h: number, w: number): void {
    for (let r = y; r < y + h; r++) for (let col = x; col < x + w; col++) if (col >= 0 && col < 20 && r >= 0 && r < 18) this.screen.put(col, r, BLANK);
  }

  // ------------------------------------------------------------------ MoveAnimation
  /** SetAnimationPalette (the SGB values) */
  setAnimationPalette(): void {
    this.animPalette = 0xf0;
    const trade = this.animationId >= c('move', 'TRADE_BALL_DROP_ANIM') && this.animationId <= c('move', 'TRADE_BALL_POOF_ANIM');
    this.obp0 = trade ? 0xf0 : 0xe4;
    this.obp1 = 0x6c;
  }

  /** ShareMoveAnimations: Amnesia and Rest on the enemy's turn use the status animations */
  shareMoveAnimations(): void {
    if (!this.turn) return;
    if (this.animationId === c('move', 'AMNESIA')) this.animationId = c('move', 'CONF_ANIM');
    else if (this.animationId === c('move', 'REST')) this.animationId = c('move', 'SLP_ANIM');
  }

  /** PlayAnimation */
  *playAnimation(id = this.animationId): Co {
    this.animationId = id;
    this.transform = 0;
    const cmds = this.d.attacks[id - 1] ?? [];
    for (let i = 0; i < cmds.length; ) {
      const a = cmds[i];
      if (a >= FIRST_SE_ID) {
        const sound = cmds[i + 1];
        i += 2;
        if (sound !== NO_SOUND) this.playMoveSound(sound);
        yield* this.specialEffect(a);
        continue;
      }
      this.frameDelay = a & 0x3f;
      const tileset = a >> 6;
      this.animSoundId = cmds[i + 1];
      const sub = cmds[i + 2];
      i += 3;
      const savedObp0 = this.obp0;
      this.obp0 = this.animPalette;
      this.loadTileset(tileset);
      this.loadSubanimation(sub);
      yield* this.playSubanimation();
      this.obp0 = savedObp0;
    }
  }

  /** LoadSubanimation */
  private loadSubanimation(id: number): void {
    const sa = this.d.subanims[id];
    this.entries = sa.entries;
    this.counter = sa.entries.length;
    if (sa.type === T.ENEMY) this.transform = this.turn ? T.NORMAL : T.HFLIP; // GetSubanimationTransform2
    else this.transform = this.turn ? sa.type : T.NORMAL; // GetSubanimationTransform1
    this.entryIndex = this.transform === T.REVERSE ? this.counter - 1 : 0;
  }

  /** PlaySubanimation */
  private *playSubanimation(): Co {
    if (this.animSoundId !== NO_SOUND) this.playMoveSound(this.animSoundId);
    this.fbDest = 0;
    for (;;) {
      const [block, coord, mode] = this.entries[this.entryIndex];
      [this.baseY, this.baseX] = this.d.baseCoords[coord];
      this.fbMode = mode;
      yield* this.drawFrameBlock(this.d.frameBlocks[block]);
      yield* this.specialEffectByAnimationId();
      this.counter = (this.counter - 1) & 0xff;
      if (!this.counter) return;
      this.entryIndex += this.transform === T.REVERSE ? -1 : 1;
    }
  }

  /** DrawFrameBlock */
  private *drawFrameBlock(tiles: [number, number, number, number][]): Co {
    const start = this.fbDest;
    let dest = this.fbDest;
    for (const [dy, dx, tile, flags] of tiles) {
      let y: number;
      let x: number;
      let f = flags;
      switch (this.transform) {
        case T.HVFLIP:
          y = 136 - (this.baseY + dy);
          x = 168 - (this.baseX + dx);
          f = flags === 0 ? OAM_YFLIP | OAM_XFLIP : flags === OAM_XFLIP ? OAM_YFLIP : flags === OAM_YFLIP ? OAM_XFLIP : 0;
          break;
        case T.HFLIP:
          y = this.baseY + dy + 40;
          x = 168 - (this.baseX + dx);
          f = flags ^ OAM_XFLIP;
          break;
        case T.COORDFLIP:
          y = 136 - this.baseY + dy;
          x = 168 - this.baseX + dx;
          break;
        default:
          y = this.baseY + dy;
          x = this.baseX + dx;
      }
      if (dest < 40) Object.assign(this.oam[dest], { y: y & 0xff, x: x & 0xff, tile: (tile + 0x31) & 0xff, attr: f, code: undefined });
      dest++;
    }
    if (this.fbMode === 2) {
      this.fbDest = dest; // no delay, the OAM kept
      return;
    }
    yield* this.delay(this.frameDelay);
    if (this.fbMode === 3) {
      this.fbDest = dest;
      return;
    }
    if (this.fbMode === 4) {
      this.fbDest = start;
      return;
    }
    if (this.animationId !== c('move', 'GROWL')) yield* this.cleanOam();
    this.fbDest = 0;
  }

  // ------------------------------------------------------------------ sounds
  /** GetMoveSound + PlaySound for a sound byte (move id - 1) */
  private playMoveSound(a: number): void {
    const t = this.e.bundle.audio.moveSounds;
    let sound = t[a * 3];
    let freq = t[a * 3 + 1];
    let tempo = t[a * 3 + 2];
    if (this.animationId === c('move', 'GROWL') || this.animationId === c('move', 'ROAR')) {
      // IsCryMove: the user's own cry, pitch and length modified
      const species = this.turn ? this.b.enemy.mon.species : this.b.player.mon.species;
      const [base, pitch, length] = this.e.bundle.audio.cryData[species - 1] ?? [0, 0, 0x80];
      sound = c('music', 'SFX_CRY_00') + base * 3;
      freq = (pitch + freq) & 0xff;
      tempo = (length + tempo) & 0xff;
    }
    this.e.sound.setModifiers(freq, tempo);
    this.e.sound.playSound(sound & 0xff);
  }

  // ------------------------------------------------------------------ per-animation effects
  private *specialEffectByAnimationId(): Co {
    const hit = this.d.specialEffectsById.find(([id]) => id === this.animationId);
    if (!hit) return;
    const fn = this.idEffects[hit[1]];
    if (fn) yield* fn();
  }

  private readonly idEffects: Record<string, () => Co> = {
    AnimationFlashScreen: () => this.flashScreen(),
    TailWhipAnimationUnused: function* (this: MoveAnimator) {
      this.counter = 1;
      yield* this.delay(20);
    }.bind(this),
    DoGrowlSpecialEffects: function* (this: MoveAnimator) {
      // a second musical note: OAM 0-3 copied to 4-7
      for (let i = 0; i < 4; i++) Object.assign(this.oam[4 + i], this.oam[i]);
      if (this.counter === 1) yield* this.cleanOam();
    }.bind(this),
    DoBlizzardSpecialEffects: function* (this: MoveAnimator) {
      if ([13, 9, 5, 1].includes(this.counter)) yield* this.flashScreen();
    }.bind(this),
    FlashScreenEveryFourFrameBlocks: () => this.flashEvery(3),
    FlashScreenEveryEightFrameBlocks: () => this.flashEvery(7),
    DoExplodeSpecialEffects: function* (this: MoveAnimator) {
      if (this.counter !== 1) return yield* this.flashEvery(3);
      // the attacker disappears (hlcoord 1, 5 for either side, as in the original)
      this.clearArea(1, 5, 7, 7);
    }.bind(this),
    DoRockSlideSpecialEffects: function* (this: MoveAnimator) {
      const n = this.counter;
      if (n >= 12) return;
      if (n >= 8) {
        yield* this.b.ui.shakeScreenHorizontally(1);
        yield* this.b.ui.shakeScreenVertically(1);
        return;
      }
      if (n === 1) yield* this.flashScreen();
    }.bind(this),
    TradeHidePokemon: function* (this: MoveAnimator) {
      if (this.counter === 6) this.clearArea(7, 2, 7, 7);
    }.bind(this),
    TradeShakePokeball: function* (this: MoveAnimator) {
      if (this.counter !== 1) return;
      for (const dy of this.d.ballMoveDistances1) {
        for (let i = 0; i < 4; i++) this.oam[i].y = (this.oam[i].y + s8(dy)) & 0xff;
        yield* this.delay(3);
      }
      yield* this.cleanOam();
      this.e.hooks.playSound?.('SFX_TRADE_MACHINE');
    }.bind(this),
    TradeJumpPokeball: function* (this: MoveAnimator) {
      const dist = this.d.ballMoveDistances2;
      let scx = 0;
      for (let k = 0; k < dist.length; k++) {
        for (let i = 0; i < 4; i++) this.oam[i].y = (this.oam[i].y + s8(dist[k])) & 0xff;
        const next = dist[k + 1];
        if (next === 12 || next === undefined) this.e.hooks.playSound?.('SFX_SWAP');
        yield* this.delay(5);
        scx = (scx - 8) & 0xff;
        if (this.hw) this.hw.scx = (this.hw.scx - 8) & 0xff;
        else this.screen.setScroll(-s8(scx), 0);
      }
      this.screen.clear();
      yield* this.delay(3); // ClearScreen ends in Delay3
    }.bind(this),
    DoBallTossSpecialEffects: function* (this: MoveAnimator) {
      if (this.curItem <= c('item', 'ULTRA_BALL')) {
        this.obp0 ^= 0x3c; // Master and Ultra Balls flash
      }
      if (this.counter === 11) this.e.hooks.playSound?.('SFX_BALL_TOSS');
      if (this.b.isTrainerBattle()) {
        if (this.counter === 3) this.counter = 2; // one frame shorter
        return;
      }
      if (this.pokeBallAnimData !== 0x10) return;
      // the Ghost Marowak dodges during the last three frames
      if (this.counter > 3) return;
      for (let r = 0; r < 7; r++) this.animCopyRowRight(17, r, 7);
      this.e.sound.writeReg(0xff10, 0x08);
    }.bind(this),
    DoBallShakeSpecialEffects: function* (this: MoveAnimator) {
      if (this.counter === 4) {
        this.e.hooks.playSound?.('SFX_TINK');
        yield* this.delay(40);
      }
      if (this.counter !== 1) return;
      this.numShakes = (this.numShakes - 1) & 0xff;
      if (!this.numShakes) return;
      // another shake: back four subentries, and a counter of 5 (decremented right after)
      this.entryIndex -= 4;
      this.counter = 5;
    }.bind(this),
    DoPoofSpecialEffects: function* (this: MoveAnimator) {
      if (this.counter === 5) this.e.hooks.playSound?.('SFX_BALL_POOF');
    }.bind(this),
  };

  private *flashEvery(mask: number): Co {
    if (!(this.counter & mask)) yield* this.flashScreen();
  }

  // ------------------------------------------------------------------ special effects
  /** SpecialEffectPointers */
  private *specialEffect(id: number): Co {
    seById ??= new Map(Object.entries(SE_NAMES).map(([routine, se]) => [c('move_animation', se), routine]));
    const fn = this.seTable[seById.get(id) ?? ''];
    if (fn) yield* fn();
  }

  private readonly seTable: Record<string, () => Co> = {
    AnimationFlashScreen: () => this.flashScreen(),
    AnimationDarkScreenPalette: () => this.bgPalette(0x6f),
    AnimationResetScreenPalette: () => this.bgPalette(0xe4),
    AnimationShakeScreen: () => this.b.ui.shakeScreenHorizontally(8),
    AnimationWaterDropletsEverywhere: () => this.waterDroplets(),
    AnimationDarkenMonPalette: () => this.bgPalette(0xf4),
    AnimationFlashScreenLong: () => this.flashScreenLong(),
    AnimationSlideMonUp: () => this.slideMonUp(),
    AnimationSlideMonDown: () => this.slideMonDown(),
    AnimationFlashMonPic: () => this.flashMonPic(),
    AnimationSlideMonOff: () => this.slideMonOff(8, 3),
    AnimationBlinkMon: () => this.blinkMon(),
    AnimationMoveMonHorizontally: () => this.moveMonHorizontally(),
    AnimationResetMonPosition: () => this.resetMonPosition(),
    AnimationLightScreenPalette: () => this.bgPalette(0x90),
    AnimationHideMonPic: () => this.hideMonPicCo(),
    AnimationSquishMonPic: () => this.squishMonPic(),
    AnimationShootBallsUpward: () => this.shootBallsUpward(),
    AnimationShootManyBallsUpward: () => this.shootManyBallsUpward(),
    AnimationBoundUpAndDown: () => this.boundUpAndDown(),
    AnimationMinimizeMon: () => this.minimizeMon(),
    AnimationSlideMonDownAndHide: () => this.slideMonDownAndHide(),
    AnimationTransformMon: () => this.transformMon(),
    AnimationLeavesFalling: () => this.leavesFalling(),
    AnimationPetalsFalling: () => this.petalsFalling(),
    AnimationSlideMonHalfOff: () => this.slideMonHalfOff(),
    AnimationShakeEnemyHUD: () => this.shakeEnemyHud(),
    AnimationShakeEnemyHUD2: () => this.shakeEnemyHud(),
    AnimationSpiralBallsInward: () => this.spiralBallsInward(),
    AnimationDelay10: () => this.delay(10),
    AnimationFlashEnemyMonPic: () => this.withTurnFlipped(() => this.flashMonPic()),
    AnimationHideEnemyMonPic: () => this.hideEnemyMonPic(),
    AnimationBlinkEnemyMon: () => this.withTurnFlipped(() => this.blinkMon()),
    AnimationShowMonPic: () => this.showMonPic(),
    AnimationShowEnemyMonPic: () => this.withTurnFlipped(() => this.showMonPic()),
    AnimationSlideEnemyMonOff: () => this.withTurnFlipped(() => this.slideMonOff(8, 3)),
    AnimationShakeBackAndForth: () => this.shakeBackAndForth(),
    AnimationSubstitute: () => this.substitute(),
    AnimationWavyScreen: () => this.wavyScreen(),
  };

  /** CallWithTurnFlipped */
  private *withTurnFlipped(fn: () => Co): Co {
    const t = this.b.whoseTurn;
    this.b.whoseTurn = t ^ 1;
    try {
      yield* fn();
    } finally {
      this.b.whoseTurn = t;
    }
  }

  /** SetAnimationBGPalette (the SGB value) */
  private *bgPalette(v: number): Co {
    this.setBgp(v);
  }

  /** AnimationFlashScreen */
  *flashScreen(): Co {
    const saved = this.bgp;
    this.setBgp(0x1b);
    yield* this.delay(2);
    this.setBgp(0x00);
    yield* this.delay(2);
    this.setBgp(saved);
  }

  /** AnimationFlashScreenLong: the palette list three times (2 frames each, then 1) */
  private *flashScreenLong(): Co {
    for (let n = 3; n > 0; n--)
      for (const v of this.d.flashScreenLong) {
        this.setBgp(v);
        yield* this.delay(n === 3 ? 2 : 1);
      }
  }

  // pics ------------------------------------------------------------
  private get picX() {
    return this.turn ? 12 : 1;
  }
  private get picY() {
    return this.turn ? 0 : 5;
  }
  private get picBase() {
    return this.turn ? 0 : 0x31;
  }
  /** AnimationHideMonPic */
  private hideMonPic(): void {
    this.clearArea(this.picX, this.picY, 7, 7);
  }
  private *hideMonPicCo(): Co {
    this.hideMonPic();
  }
  /** CopyPicTiles of the first `rows` rows of a list, at the pic's place offset by (7 - rows) rows */
  private copyPic(list: number[], rows = 7, cols = 7, x = this.picX, y = this.picY + (7 - rows)): void {
    this.copyTileIds(list, rows, cols, x, y, this.picBase);
  }
  /** AnimationShowMonPic */
  private *showMonPic(): Co {
    this.copyPic(this.d.tilemaps.mon);
    yield* this.delay(3);
  }
  private *hideEnemyMonPic(): Co {
    yield* this.withTurnFlipped(() => this.hideMonPicCo());
    yield* this.delay(3);
  }

  /** AnimationSlideMonDown */
  private *slideMonDown(): Co {
    for (let rows = 7; rows > 0; rows--) {
      this.copyPic(this.d.tilemaps.mon, rows);
      yield* this.delay(3);
      this.hideMonPic();
    }
  }

  /** AnimationSlideMonUp / _AnimationSlideMonUp */
  private *slideMonUp(): Co {
    const x = this.picX;
    const top = this.picY;
    let bottomLeft = this.turn ? 0xff : 0x30;
    for (let k = 0; k < 7; k++) {
      for (let r = 0; r < 6; r++) for (let col = 0; col < 7; col++) this.screen.put(x + col, top + r, this.screen.get(x + col, top + r + 1));
      bottomLeft = (bottomLeft + 1) & 0xff;
      for (let col = 0; col < 7; col++) this.putId(x + col, top + 6, bottomLeft + col * 7);
      yield* this.delay(2);
    }
  }

  /** _AnimationSlideMonOff: the pic slides `e` tiles off its side, `wait` frames per tile */
  private *slideMonOff(e: number, wait: number): Co {
    const x0 = this.turn ? 12 : 0;
    const y0 = this.turn ? 0 : 5;
    for (let step = 0; step < e; step++) {
      for (let r = 0; r < 7; r++)
        for (let col = 0; col < 8; col++) {
          const id = this.getId(x0 + col, y0 + r);
          let next: number;
          if (this.turn) {
            next = (id - 7) & 0xff; // .EnemyNextTile
            if (next >= 0x30) next = BLANK;
          } else {
            next = (id + 7) & 0xff; // .PlayerNextTile
            if (next >= 0x62) next = BLANK;
          }
          this.putId(x0 + col, y0 + r, next);
        }
      yield* this.delay(wait);
    }
  }
  private *slideMonHalfOff(): Co {
    yield* this.slideMonOff(4, 4);
    yield* this.delay(3);
  }

  /** AnimationBlinkMon */
  private *blinkMon(): Co {
    for (let i = 0; i < 6; i++) {
      this.hideMonPic();
      yield* this.delay(5);
      yield* this.showMonPic();
      yield* this.delay(5);
    }
  }

  /** AnimationMoveMonHorizontally: the pic one tile toward the opponent */
  private *moveMonHorizontally(): Co {
    this.hideMonPic();
    this.copyPic(this.d.tilemaps.mon, 7, 7, this.turn ? 11 : 2, this.picY);
    yield* this.delay(3);
  }

  /** AnimationResetMonPosition */
  private *resetMonPosition(): Co {
    this.clearArea(this.turn ? 11 : 2, this.picY, 7, 7);
    yield* this.showMonPic();
  }

  /** AnimationShakeBackAndForth (Double Team): the pic ends hidden */
  private *shakeBackAndForth(): Co {
    const [hx, dx] = this.turn ? [11, 13] : [0, 2];
    const y = this.picY;
    for (let i = 0; i < 0x10; i++) {
      this.copyPic(this.d.tilemaps.mon, 7, 7, hx, y);
      yield* this.delay(3);
      this.clearArea(hx, y, 7, 9);
      this.copyPic(this.d.tilemaps.mon, 7, 7, dx, y);
      yield* this.delay(3);
      this.clearArea(hx, y, 7, 9);
    }
  }

  // AnimCopyRowLeft/Right on the tile map
  private animCopyRowLeft(x: number, y: number, n: number): number {
    for (let i = 0; i < n; i++, x++) this.screen.put(x - 1, y, this.screen.get(x, y));
    return x;
  }
  private animCopyRowRight(x: number, y: number, n: number): number {
    for (let i = 0; i < n; i++, x--) this.screen.put(x + 1, y, this.screen.get(x, y));
    return x;
  }

  /** AnimationSquishMonPic (Teleport, Sky Attack) */
  private *squishMonPic(): Co {
    for (let k = 0; k < 4; k++) {
      const [hx, dx, y] = this.turn ? [16, 14, 0] : [5, 3, 5];
      for (const [x0, left] of [
        [hx, true],
        [dx, false],
      ] as const) {
        for (let r = 0; r < 7; r++) {
          // three tiles copied, then the one beyond them blanked
          const end = left ? this.animCopyRowLeft(x0, y + r, 3) - 1 : this.animCopyRowRight(x0, y + r, 3) + 1;
          if (end >= 0 && end < 20) this.screen.put(end, y + r, BLANK);
        }
        yield* this.delay(3);
      }
    }
    this.hideMonPic();
    yield* this.delay(1);
  }

  /** BattleAnimWriteOAMEntry: y = e + 8 (returned), x = baseX, tile d */
  private writeOamEntry(i: number, e: number, tile: number): number {
    e = (e + 8) & 0xff;
    let attr = 1;
    if (e >= 40) attr++;
    if (this.baseX >= 88) attr += 2;
    if (i < 40) Object.assign(this.oam[i], { y: e, x: this.baseX & 0xff, tile, attr, code: undefined });
    return e;
  }

  /** _AnimationShootBallsUpward: `count` balls stacked from baseY, rising 4 px every `wait` frames */
  private *shootBallsUpwardCommon(count: number, wait: number): Co {
    this.loadTileset(0);
    let e = this.baseY;
    for (let i = 0; i < count; i++) e = this.writeOamEntry(i, e, 0x7a);
    yield* this.delay(1);
    let left = count;
    while (left) {
      for (let i = 0; i < count; i++) {
        const o = this.oam[i];
        if (o.y === ((this.baseY + 8) & 0xff)) {
          o.y = 0;
          left--;
        } else o.y = (o.y - 4) & 0xff;
      }
      yield* this.delay(wait);
    }
  }
  private *shootBallsUpward(): Co {
    [this.baseY, this.baseX] = this.turn ? [0, 16 * 8] : [6 * 8, 5 * 8];
    yield* this.shootBallsUpwardCommon(5, 1);
    yield* this.cleanOam();
  }
  private *shootManyBallsUpward(): Co {
    const xs = this.turn ? [0x60, 0x90, 0x78, 0x68, 0x88, 0x80] : [0x10, 0x40, 0x28, 0x18, 0x38, 0x30];
    for (const x of xs) {
      this.baseY = this.turn ? 0x28 : 0x50;
      this.baseX = x;
      yield* this.shootBallsUpwardCommon(4, 1);
    }
    yield* this.cleanOam();
  }

  /** AnimationBoundUpAndDown (Splash) */
  private *boundUpAndDown(): Co {
    for (let i = 0; i < 5; i++) yield* this.slideMonDown();
    yield* this.showMonPic();
  }

  /** Write 56x56 pixels (row-major) into the mon pic's tiles (CopyTempPicToMonPic) */
  private setPicPixels(px: number[]): void {
    const base = this.turn ? ENEMY_PIC_BASE : PLAYER_PIC_BASE;
    for (let ty = 0; ty < 7; ty++)
      for (let tx = 0; tx < 7; tx++) {
        const tile = new Array<number>(64);
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) tile[y * 8 + x] = px[(ty * 8 + y) * 56 + tx * 8 + x];
        this.screen.setGlyphOverride(base + ty * 7 + tx, tile);
      }
  }

  /** The minimized mon: MinimizedMonSprite at tile (3, 4), two rows down */
  private minimizedPixels(): number[] {
    const px = new Array<number>(56 * 56).fill(0);
    this.d.minimized.forEach((row, k) => {
      for (let b = 0; b < 8; b++) if (row & (0x80 >> b)) px[(4 * 8 + 2 + k) * 56 + 3 * 8 + b] = 3;
    });
    return px;
  }

  /** AnimationMinimizeMon */
  private *minimizeMon(): Co {
    this.setPicPixels(this.minimizedPixels());
    yield* this.delay(3);
    yield* this.showMonPic();
  }

  /** AnimationSlideMonDownAndHide (Acid Armor): the pic tiles end blank */
  private *slideMonDownAndHide(): Co {
    for (const list of [this.d.tilemaps.slideDown7x5, this.d.tilemaps.slideDown7x3]) {
      this.hideMonPic();
      const rows = list.length / 7;
      this.copyPic(list, rows);
      yield* this.delay(8);
    }
    this.hideMonPic();
    this.setPicPixels(new Array<number>(56 * 56).fill(0));
  }

  /** ChangeMonPic: this side's pic redrawn as `species` */
  private changeMonPic(species: number): void {
    const pics = this.b.bundle.pics;
    if (this.turn) this.b.ui.setEnemyPic(pics.front[species]);
    else this.b.ui.setPlayerBackPic(pics.back[species]);
    this.b.setBattlePalette?.(); // ChangeMonPic ends in SET_PAL_BATTLE
  }
  /** AnimationFlashMonPic: the pic reloaded (undoing a substitute or minimize) */
  private *flashMonPic(): Co {
    this.changeMonPic(this.turn ? this.b.enemy.mon.species : this.b.player.mon.species);
  }
  /** AnimationTransformMon */
  private *transformMon(): Co {
    this.changeMonPic(this.turn ? this.b.player.mon.species : this.b.enemy.mon.species);
  }

  /** AnimationSubstitute: the doll from MonsterSprite (front facing for the enemy, back for the player) */
  private *substitute(): Co {
    const px = new Array<number>(56 * 56).fill(0);
    const tiles = this.b.bundle.battle.substituteTiles;
    const place = (t: number, tx: number, ty: number) => {
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px[(ty * 8 + y) * 56 + tx * 8 + x] = tiles[t * 64 + y * 8 + x];
    };
    if (this.turn) {
      place(0, 2, 4);
      place(1, 3, 4);
      place(2, 2, 5);
      place(3, 3, 5);
    } else {
      place(4, 3, 4);
      place(5, 4, 4);
      place(6, 3, 5);
      place(7, 4, 5);
    }
    this.setPicPixels(px);
    yield* this.showMonPic();
  }

  // OAM effects ------------------------------------------------------
  /** InitMultipleObjectsOAM: `count` entries of tile d down from y 8 at x 0, tileset a */
  private initMultipleObjects(tile: number, count: number, tileset: number): void {
    this.loadTileset(tileset);
    this.baseX = 0;
    let e = 0;
    for (let i = 0; i < count; i++) e = this.writeOamEntry(i, e, tile);
  }

  /** AnimationSpiralBallsInward */
  private *spiralBallsInward(): Co {
    const [by, bx] = this.turn ? [-40, 80] : [0, 0];
    this.initMultipleObjects(0x7a, 3, 0);
    const coords = this.d.spiralBalls;
    for (let k = 0; ; k += 2) {
      let done = false;
      for (let i = 0; i < 3; i++) {
        const p = k + i * 2;
        if (p >= coords.length) {
          done = true;
          break;
        }
        const o = this.oam[i];
        o.y = (by + coords[p]) & 0xff;
        o.x = (bx + coords[p + 1]) & 0xff;
        o.attr = (o.attr & 0xf0) | (o.x >= 88 ? 3 : 2);
      }
      if (done) break;
      yield* this.delay(5);
    }
    yield* this.cleanOam();
    yield* this.flashScreen();
  }

  /** AnimationWaterDropletsEverywhere */
  private *waterDroplets(): Co {
    this.loadTileset(0);
    this.baseX = -16 & 0xff;
    for (let n = 0; n < 32; n++) {
      for (const y of [16, 24]) {
        this.baseY = y;
        let i = 0;
        for (;;) {
          let attr = 1;
          if (this.baseY >= 40) attr++;
          this.baseX = (this.baseX + 27) & 0xff;
          if (this.baseX >= 88) attr = (attr + 2) & 3;
          if (i < 40) Object.assign(this.oam[i], { y: this.baseY, x: this.baseX, tile: 0x71, attr, code: undefined });
          i++;
          if (this.baseX < 144) continue;
          this.baseX = (this.baseX - 168) & 0xff;
          this.baseY += 16;
          if (this.baseY >= 112) break;
        }
        yield* this.cleanOam();
        yield* this.delay(1);
      }
    }
  }

  /** AnimationLeavesFalling / AnimationPetalsFalling */
  private *fallingObjects(tile: number, count: number): Co {
    this.initMultipleObjects(tile, count, 1);
    for (let i = 0; i < count; i++) this.oam[i].x = this.d.fallingXs[i];
    const movement = this.d.fallingMovement.slice(0, count);
    this.oam[0].y = 0;
    for (;;) {
      for (let i = 0; i < count; i++) {
        // FallingObjects_UpdateMovementByte
        let m = (movement[i] + 1) & 0xff;
        if ((m & 0x7f) === 9) m = (m & 0x80) ^ 0x80;
        movement[i] = m;
        // FallingObjects_UpdateOAMEntry
        const o = this.oam[i];
        let y = (o.y + 2) & 0xff;
        if (y >= 112) y = OFFSCREEN_Y;
        o.y = y;
        let attr = y >= 40 ? 2 : 1;
        const dx = this.d.fallingDeltaXs[m & 0x7f] ?? 0;
        o.x = m & 0x80 ? (o.x - dx) & 0xff : (o.x + dx) & 0xff;
        if (o.x >= 88) attr = (attr + 2) & 3;
        o.attr = attr | (m & 0x80 ? OAM_XFLIP : 0);
      }
      yield* this.delay(3);
      if (this.oam[0].y === 104) return;
    }
  }
  private *leavesFalling(): Co {
    this.obp0 = this.animPalette;
    yield* this.fallingObjects(0x37, 3);
  }
  private *petalsFalling(): Co {
    yield* this.fallingObjects(0x71, 20);
    this.clearSprites();
  }

  /**
   * AnimationShakeEnemyHUD: the top seven rows (enemy HUD and pic) shake with
   * SCX while the rest stays; the back pic's top rows, which share those lines,
   * are held still as an OAM copy.
   */
  private *shakeEnemyHud(): Co {
    // ShakeEnemyHUD_WritePlayerMonPicOAM: 7 columns x 5 rows of the back pic
    for (let col = 0, i = 0; col < 7; col++)
      for (let r = 0; r < 5; r++, i++)
        Object.assign(this.oam[i], { y: 0x38 + r * 8, x: 0x10 + col * 8, tile: 0, attr: 0, code: PLAYER_PIC_BASE + r * 7 + col });
    const savedObp0 = this.obp0;
    this.obp0 = 0xe4;
    this.hideMonPic();
    yield* this.delay(3);
    const lines = new Int8Array(144);
    for (let k = 0; k < 8; k++) {
      lines.fill(-2, 0, 56);
      this.screen.setLineScroll(lines);
      yield* this.delay(2);
      lines.fill(2, 0, 56);
      this.screen.setLineScroll(lines);
      yield* this.delay(2);
    }
    this.screen.setLineScroll(undefined);
    yield* this.showMonPic();
    this.clearSprites();
    this.obp0 = savedObp0;
  }

  /** AnimationWavyScreen (Psychic, Psywave, Night Shade) */
  private *wavyScreen(): Co {
    yield* this.delay(3);
    const table = this.d.wavyScreen.map(s8);
    const lines = new Int8Array(144);
    for (let f = 0; f < 255; f++) {
      for (let y = 0; y < 144; y++) lines[y] = -table[(f + y) % table.length];
      this.screen.setLineScroll(lines);
      yield* this.delay(1);
    }
    this.screen.setLineScroll(undefined);
    // the window comes back blank for a moment before the tile map is copied to it again
    const saved = this.b.ui.save();
    this.screen.fill(0, 0, 20, 18, BLANK);
    yield* this.delay(3);
    this.b.ui.restore(saved);
    yield* this.delay(3);
  }

  // ------------------------------------------------------------------ the Poké Ball
  /** TossBallAnimation (wPokeBallAnimData: high nybble the number of animations, low the shakes) */
  *tossBall(data: number, item: number): Co {
    this.pokeBallAnimData = data;
    this.curItem = item;
    this.setAnimationPalette();
    if (this.b.isTrainerBattle()) {
      yield* this.playAnimation(c('move', 'TOSS_ANIM'));
      this.e.hooks.playSound?.('SFX_FAINT_THUD');
      yield* this.playAnimation(c('move', 'BLOCKBALL_ANIM'));
      return;
    }
    let count = data >> 4;
    this.numShakes = data & 0xf;
    const toss = item === c('item', 'POKE_BALL') ? 'TOSS_ANIM' : item === c('item', 'GREAT_BALL') ? 'GREATTOSS_ANIM' : 'ULTRATOSS_ANIM';
    const sequence = ['POOF_ANIM', 'HIDEPIC_ANIM', 'SHAKE_ANIM', 'POOF_ANIM', 'SHOWPIC_ANIM'];
    let next = toss;
    for (let k = 0; count > 0; k++, count--) {
      yield* this.playAnimation(c('move', next));
      next = sequence[k];
    }
  }
}

let seById: Map<number, string> | undefined;

/** SpecialEffectPointers: routine → SE_* id */
const SE_NAMES: Record<string, string> = {
  AnimationFlashScreen: 'SE_DARK_SCREEN_FLASH',
  AnimationDarkScreenPalette: 'SE_DARK_SCREEN_PALETTE',
  AnimationResetScreenPalette: 'SE_RESET_SCREEN_PALETTE',
  AnimationShakeScreen: 'SE_SHAKE_SCREEN',
  AnimationWaterDropletsEverywhere: 'SE_WATER_DROPLETS_EVERYWHERE',
  AnimationDarkenMonPalette: 'SE_DARKEN_MON_PALETTE',
  AnimationFlashScreenLong: 'SE_FLASH_SCREEN_LONG',
  AnimationSlideMonUp: 'SE_SLIDE_MON_UP',
  AnimationSlideMonDown: 'SE_SLIDE_MON_DOWN',
  AnimationFlashMonPic: 'SE_FLASH_MON_PIC',
  AnimationSlideMonOff: 'SE_SLIDE_MON_OFF',
  AnimationBlinkMon: 'SE_BLINK_MON',
  AnimationMoveMonHorizontally: 'SE_MOVE_MON_HORIZONTALLY',
  AnimationResetMonPosition: 'SE_RESET_MON_POSITION',
  AnimationLightScreenPalette: 'SE_LIGHT_SCREEN_PALETTE',
  AnimationHideMonPic: 'SE_HIDE_MON_PIC',
  AnimationSquishMonPic: 'SE_SQUISH_MON_PIC',
  AnimationShootBallsUpward: 'SE_SHOOT_BALLS_UPWARD',
  AnimationShootManyBallsUpward: 'SE_SHOOT_MANY_BALLS_UPWARD',
  AnimationBoundUpAndDown: 'SE_BOUNCE_UP_AND_DOWN',
  AnimationMinimizeMon: 'SE_MINIMIZE_MON',
  AnimationSlideMonDownAndHide: 'SE_SLIDE_MON_DOWN_AND_HIDE',
  AnimationTransformMon: 'SE_TRANSFORM_MON',
  AnimationLeavesFalling: 'SE_LEAVES_FALLING',
  AnimationPetalsFalling: 'SE_PETALS_FALLING',
  AnimationSlideMonHalfOff: 'SE_SLIDE_MON_HALF_OFF',
  AnimationShakeEnemyHUD: 'SE_SHAKE_ENEMY_HUD',
  AnimationShakeEnemyHUD2: 'SE_SHAKE_ENEMY_HUD_2',
  AnimationSpiralBallsInward: 'SE_SPIRAL_BALLS_INWARD',
  AnimationDelay10: 'SE_DELAY_ANIMATION_10',
  AnimationFlashEnemyMonPic: 'SE_FLASH_ENEMY_MON_PIC',
  AnimationHideEnemyMonPic: 'SE_HIDE_ENEMY_MON_PIC',
  AnimationBlinkEnemyMon: 'SE_BLINK_ENEMY_MON',
  AnimationShowMonPic: 'SE_SHOW_MON_PIC',
  AnimationShowEnemyMonPic: 'SE_SHOW_ENEMY_MON_PIC',
  AnimationSlideEnemyMonOff: 'SE_SLIDE_ENEMY_MON_OFF',
  AnimationShakeBackAndForth: 'SE_SHAKE_BACK_AND_FORTH',
  AnimationSubstitute: 'SE_SUBSTITUTE_MON',
  AnimationWavyScreen: 'SE_WAVY_SCREEN',
};
