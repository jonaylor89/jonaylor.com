/** InternalClockTradeAnim and its Trade_* routines (engine/movie/trade.asm).
 * TileScreen is wTileMap; the PPU keeps the separate BG/window maps so the
 * text boxes, Game Boys and cable scroll independently of the OAM Pokémon.
 */
import type { Co, Engine } from '../engine/Engine';
import { GbHardware } from '../gb/hardware';
import { MoveAnimator } from '../battle/moveAnims';
import { c } from '../rom/constants';
import { encodePlain } from '../ui/TextPrinter';
import { frontPixels, placePixels } from '../ui/picTiles';
import { EMPTY } from '../ui/TileScreen';

export interface TradeMon {
  species: number;
  otName: string;
  otId: number;
}

export class TradeAnimation {
  readonly hw: GbHardware;
  readonly anim: MoveAnimator;
  private get s() { return this.e.screen; }
  private name(mon: TradeMon): string { return this.e.bundle.species[mon.species].name; }

  constructor(readonly e: Engine, readonly given: TradeMon, readonly received: TradeMon) {
    this.hw = new GbHardware(e);
    this.anim = new MoveAnimator({
      e, bundle: e.bundle, whoseTurn: 0, isTrainerBattle: () => false,
      player: { mon: given }, enemy: { mon: received },
      ui: {
        *shakeScreenHorizontally() {}, *shakeScreenVertically() {},
        setEnemyPic() {}, setPlayerBackPic() {},
        save: () => this.s.cells.slice(), restore: (buf) => { this.s.cells.set(buf); },
      },
    });
    this.anim.hw = this.hw;
    this.anim.frame = () => this.frame();
  }

  /** wTileMap's pic glyphs → the column-major vFrontPic tile IDs. */
  syncBg(): void {
    this.s.cells.forEach((code, i) => {
      let id = code === EMPTY ? 0x7f : code;
      if (code >= 0x100 && code < 0x131) {
        const n = code - 0x100;
        id = (n % 7) * 7 + Math.floor(n / 7);
        this.hw.ppu.loadTiles(0x100 + id, this.s.glyphIndices(code), 1);
      }
      this.hw.tileMap[i] = id;
    });
  }
  private *frame(): Co {
    this.syncBg();
    yield* this.hw.vblank();
  }
  private *delay(n: number): Co { for (let i = 0; i < n; i++) yield* this.frame(); }
  private clear(): void { this.s.fill(0, 0, 20, 18, 0x7f); }
  private *clearScreen(): Co { this.clear(); yield* this.delay(3); }
  private text(x: number, y: number, str: string): void {
    encodePlain(str).forEach((code, i) => this.s.put(x + i, y, code));
  }
  /** CopyScreenTileBufferToVRAM: six rows at each of three VBlanks. */
  private *copyScreen(dest = 0x9800): Co {
    for (let part = 0; part < 3; part++) {
      this.syncBg();
      for (let y = part * 6; y < part * 6 + 6; y++)
        for (let x = 0; x < 20; x++) this.hw.poke(dest + y * 32 + x, this.hw.tileMap[y * 20 + x]);
      yield* this.frame();
    }
  }
  private *copyMap(): Co {
    this.hw.autoBgTransfer = true;
    yield* this.delay(3);
    this.hw.autoBgTransfer = false;
  }
  private tradeLcdc(winOn: boolean): void {
    Object.assign(this.hw.ppu, { bgMap: 1, winMap: 0, winOn, tileData8000: false });
  }
  private genericPalette(): void { this.e.hooks.palette?.(c('palette', 'PAL_MEWMON')); }

  /** LoadTradingGFXAndMonNames. */
  private load(): void {
    const { hw, s } = this;
    const p = hw.ppu;
    this.clear();
    for (let code = 0x60; code < 0x100; code++) p.loadTiles(code < 0x80 ? 0x100 + code : code, s.glyphIndices(code), 1);
    // InGameTrade_DoTrade loads these before entering the movie (ID/No. glyphs too).
    p.loadTiles(0x162, this.e.bundle.ui.hpBarAndStatus.pixels);
    p.loadTiles(0x131, this.e.bundle.trades.anim.gfx);
    p.loadTiles(0x7c, this.e.bundle.trades.anim.gfx2);
    p.bgMaps.forEach((m) => m.fill(0x7f));
    hw.clearOam();
    p.obp0 = 0xf0; // SGB
    hw.autoBgDest = 0x9c00;
  }
  private *print(label: string): Co {
    const co = this.e.printText(label, {
      letterDelay: 0,
      ram: (label, addr) => {
        if (addr === 0xcf4a || label === 'wStringBuffer') return this.name(this.given);
        if (addr === 0xcd6d || label === 'wNameBuffer') return this.name(this.received);
        if (addr === 0xd886 || label === 'wLinkEnemyTrainerName') return this.received.otName;
        return this.e.ramValue(label, addr);
      },
    });
    try { while (!co.next().done) yield* this.frame(); }
    finally { co.return(); }
  }
  /** Trade_PrintPlayerMonInfoText / Trade_PrintEnemyMonInfoText. */
  private monInfo(mon: TradeMon, y: number): void {
    this.text(5, y, '──{x74}{xf2}');
    this.text(9, y, String(this.e.bundle.dexOrder[mon.species]).padStart(3, '0'));
    this.text(5, y + 2, this.name(mon));
    this.text(5, y + 4, 'OT/');
    this.text(5, y + 6, '{x73}{x74}{xf2}');
    this.text(8, y + 4, mon.otName);
    this.text(8, y + 6, String(mon.otId).padStart(5, '0'));
  }
  /** Trade_LoadMonSprite: LoadFlippedFrontSpriteByMonIndex. */
  private *loadMon(mon: TradeMon): Co {
    this.e.hooks.palette?.(this.e.bundle.palettes.monsterPalettes[this.e.bundle.dexOrder[mon.species]]);
    this.hw.autoBgTransfer = !this.hw.autoBgTransfer;
    const px = frontPixels(this.e.bundle.pics.front[mon.species]);
    const flipped = px.map((_, i) => px[Math.floor(i / 56) * 56 + 55 - i % 56]);
    placePixels(this.e, flipped, 7, 2);
    yield* this.delay(10);
  }
  private *waitSound(): Co { while (this.e.sound.sfxPlaying) yield* this.frame(); }
  private *cry(mon: TradeMon): Co {
    this.e.hooks.playCry?.(mon.species);
    yield* this.waitSound();
  }
  private *showAnimation(name: string): Co {
    yield* this.waitSound();
    this.anim.animationId = c('move', name);
    this.anim.setAnimationPalette();
    yield* this.anim.playAnimation();
    yield* this.waitSound();
  }
  private *showPlayer(): Co {
    this.tradeLcdc(true);
    this.hw.wy = 0x50;
    this.hw.wx = this.hw.scx = 0x86;
    this.hw.autoBgTransfer = false;
    this.s.box(4, 0, 6, 10);
    this.monInfo(this.given, 0);
    yield* this.copyScreen();
    yield* this.clearScreen();
    yield* this.loadMon(this.given);
    for (let a = 0x7e; a !== 0; a -= 2) {
      yield* this.frame();
      this.hw.wx = this.hw.scx = a;
    }
    yield* this.delay(80);
    yield* this.showAnimation('TRADE_BALL_POOF_ANIM');
    yield* this.showAnimation('TRADE_BALL_DROP_ANIM');
    yield* this.cry(this.given);
    this.hw.autoBgTransfer = false;
  }
  /** Trade_DrawOpenEndOfLinkCable. The SCX loop has no DelayFrame. */
  private *openCable(): Co {
    this.clear();
    yield* this.copyScreen();
    this.genericPalette();
    yield* this.copyCableOffscreen(0x9c8c);
    this.hw.scx = 0xa0;
    yield* this.frame();
    this.tradeLcdc(false);
    this.tilemap(this.e.bundle.trades.anim.linkCable, 6, 2, 12, 3);
    yield* this.copyMap();
    this.e.hooks.playSound?.('SFX_HEAL_HP');
    this.hw.scx = (this.hw.scx + 4 * 20) & 0xff;
  }
  /** WriteOAMBlock (four tiles, row-major). */
  private block(index: number, x: number, y: number, tiles: number[], attr: number): void {
    for (let i = 0; i < 4; i++) Object.assign(this.hw.shadowOam[index * 4 + i], {
      x: x + (i % 2) * 8, y: y + Math.floor(i / 2) * 8, tile: tiles[i], attr,
    });
  }
  private *enterCable(): Co {
    yield* this.showAnimation('TRADE_BALL_SHAKE_ANIM');
    yield* this.delay(10);
    this.hw.ppu.obp0 = 0xe4;
    let toggle = 0;
    for (let x = 0x60; x < 0xa0; x += 4) {
      toggle ^= 1;
      this.block(0, x, 0x20, Array(4).fill(0x7e + toggle), 0);
      [0, 0x20, 0x40, 0x60].forEach((attr, i) => { this.hw.shadowOam[i].attr = attr; });
      yield* this.delay(3);
      if (x + 4 < 0xa0) this.e.hooks.playSound?.('SFX_TINK');
    }
    this.hw.clearOam();
    this.hw.autoBgTransfer = true;
    yield* this.clearScreen();
    yield* this.copyScreen();
    yield* this.delay(3);
    this.hw.autoBgTransfer = false;
  }
  private tilemap(tiles: number[], x: number, y: number, w: number, h: number): void {
    for (let r = 0; r < h; r++) for (let col = 0; col < w; col++) this.s.put(x + col, y + r, tiles[r * w + col]);
  }
  private *initTransfer(): Co {
    this.hw.autoBgTransfer = true;
    yield* this.clearScreen();
    this.genericPalette();
    this.hw.autoBgTransfer = false;
    this.hw.ppu.obp1 = 0xd0;
    this.hw.ppu.loadTiles(0, this.e.bundle.ui.partyIcons.tiles, 0x7c);
    yield* this.frame();
    this.tradeLcdc(true);
    this.hw.scx = 0;
    this.hw.wy = 0x90;
  }
  private *drawGameboy(right: boolean): Co {
    this.clear();
    if (right) {
      this.s.fill(0, 4, 14, 1, 0x5e);
      this.s.put(14, 4, 0x5f);
      this.s.fill(14, 5, 1, 4, 0x61);
      this.s.put(14, 9, 0x60);
      this.s.put(13, 9, 0x5d);
      this.tilemap(this.e.bundle.trades.anim.gameBoy, 7, 8, 6, 8);
      this.s.box(6, 0, 2, 7);
      this.text(7, 2, this.received.otName);
    } else {
      this.s.put(11, 4, 0x5d);
      this.s.fill(12, 4, 8, 1, 0x5e);
      this.tilemap(this.e.bundle.trades.anim.gameBoy, 5, 3, 6, 8);
      this.s.box(4, 12, 2, 7);
      this.text(5, 14, this.e.state.player.name);
    }
    yield* this.frame();
  }
  private acrossCable(): void { this.clear(); this.s.fill(0, 4, 20, 1, 0x5e); }
  /** Trade_CopyCableTilesOffScreen / RedrawRowOrColumn: wrap within each row. */
  private *copyCableOffscreen(dest: number): Co {
    this.syncBg();
    for (let y = 0; y < 2; y++) for (let x = 0; x < 20; x++) {
      const addr = dest + y * 32;
      this.hw.poke((addr & ~31) + ((addr + x) & 31), this.hw.tileMap[(4 + y) * 20 + x]);
    }
    yield* this.delay(10);
  }
  /** WriteMonPartySpriteOAMBySpecies, Trade_WriteCircleOAMBlock. */
  private circledMon(mon: TradeMon, x: number, y: number): void {
    const icon = this.e.bundle.ui.partyIcons.byDex[this.e.bundle.dexOrder[mon.species] - 1];
    const base = icon << 2;
    this.block(0, 16, 16, icon === 2 ? [base, base + 1, base + 2, base + 3] : [base, base, base + 2, base + 2], 0);
    if (icon !== 2) { this.hw.shadowOam[1].attr = 0x20; this.hw.shadowOam[3].attr = 0x20; }
    this.block(1, 8, 8, [56, 57, 58, 59], 0x10);
    this.block(2, 24, 8, [57, 56, 59, 58], 0x30);
    this.block(3, 8, 24, [58, 59, 56, 57], 0x50);
    this.block(4, 24, 24, [59, 58, 57, 56], 0x70);
    this.offsetOam(x, y);
  }
  private offsetOam(x: number, y: number): void {
    for (const o of this.hw.shadowOam.slice(0, 20)) { o.x = (o.x + x) & 0xff; o.y = (o.y + y) & 0xff; }
  }
  private cycle(): void {
    this.hw.ppu.bgp ^= 0x3c;
    for (const o of this.hw.shadowOam.slice(0, 20)) o.tile ^= 0x40;
  }
  private *horizontal(right: boolean, n: number): Co {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < 8; j++) { this.hw.scx = (this.hw.scx + (right ? 2 : -2)) & 0xff; yield* this.frame(); }
      this.cycle();
    }
  }
  private *vertical(right: boolean): Co {
    for (const [x, y] of right ? [[4, 0], [0, 10]] : [[0, -10], [-4, 0]])
      for (let i = 0; i < 4; i++) { this.offsetOam(x, y); this.cycle(); yield* this.delay(8); }
  }
  /** Trade_AnimLeftToRight / Trade_AnimRightToLeft. */
  private *transfer(right: boolean): Co {
    yield* this.initTransfer();
    if (right) this.hw.ppu.obp0 = 0xe4;
    this.circledMon(right ? this.given : this.received, right ? 0x54 : 0x64, right ? 0x1c : 0x44);
    yield* this.drawGameboy(!right);
    yield* this.copyMap();
    this.acrossCable();
    yield* this.copyCableOffscreen(right ? 0x9c8c : 0x9c94);
    if (!right) yield* this.vertical(false);
    yield* this.horizontal(right, 6);
    this.hw.autoBgTransfer = true;
    this.acrossCable();
    yield* this.horizontal(right, 4);
    yield* this.drawGameboy(right);
    yield* this.horizontal(right, 6);
    this.hw.autoBgTransfer = false;
    if (right) yield* this.vertical(true);
    this.hw.clearOam();
  }
  private *clearedWindow(): Co {
    this.hw.autoBgTransfer = true;
    yield* this.clearScreen();
    Object.assign(this.hw.ppu, { bgMap: 0, winMap: 1, winOn: true });
    this.hw.wx = 7;
    this.hw.wy = 0;
    this.hw.scx = 0x90;
  }
  private *slideText(): Co {
    yield* this.delay(50);
    do { yield* this.frame(); this.hw.wx += 2; } while (this.hw.wx !== 0xa1);
    this.clear();
    yield* this.delay(10);
    this.hw.wx = 7;
  }
  private *showEnemy(): Co {
    yield* this.showAnimation('TRADE_BALL_TILT_ANIM');
    yield* this.clearedWindow();
    this.s.box(4, 10, 6, 10);
    this.monInfo(this.received, 10);
    yield* this.copyMap();
    this.hw.autoBgTransfer = true;
    yield* this.loadMon(this.received);
    yield* this.showAnimation('TRADE_BALL_POOF_ANIM');
    this.hw.autoBgTransfer = true;
    yield* this.cry(this.received);
    yield* this.delay(100);
    this.s.fill(4, 10, 12, 8, 0x7f);
    yield* this.print('TradeTakeCareText');
    yield* this.delay(80);
  }
  /** InternalClockTradeFuncSequence. */
  *run(): Co {
    const noDelay = this.e.ram.noTextDelay;
    const oldPpu = this.s.ppu;
    this.e.ram.noTextDelay = true;
    this.s.setObjects([]);
    this.s.clearGlyphOverrides();
    this.s.setPpu(this.hw.ppu);
    try {
      this.load();
      yield* this.showPlayer();
      yield* this.openCable();
      yield* this.enterCable();
      yield* this.transfer(true);
      yield* this.delay(100);
      yield* this.clearedWindow();
      yield* this.print('TradeWentToText');
      yield* this.delay(200);
      yield* this.slideText();
      for (const label of ['TradeForText', 'TradeSendsText', 'TradeWavesFarewellText', 'TradeTransferredText']) {
        yield* this.print(label);
        yield* this.delay(80);
      }
      yield* this.slideText();
      yield* this.transfer(false);
      yield* this.clearedWindow();
      yield* this.openCable();
      yield* this.showEnemy();
      yield* this.delay(100);
    } finally {
      // Trade_Cleanup / TradeAnimCommon: restore the caller's text and screen state.
      this.e.ram.noTextDelay = noDelay;
      this.s.setPpu(oldPpu);
      this.s.clearGlyphOverrides();
      this.s.setObjects([]);
      this.s.clear();
      this.e.hooks.palette?.(undefined);
    }
  }
}

export function* internalClockTradeAnim(e: Engine, given: TradeMon, received: TradeMon): Co {
  yield* new TradeAnimation(e, given, received).run();
}
