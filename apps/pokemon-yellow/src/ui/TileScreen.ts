/**
 * A 20x18 grid of character/tile codes rendered with the ROM font, laid over
 * the 3D view — the equivalent of the Game Boy's wTileMap for UI (text boxes,
 * menus, battle HUD). Cells set to EMPTY are transparent.
 */
import type { GameBundle } from '../data/schema';
import type { RGB } from '../render/palette';
import { LCD_H, LCD_W, type Ppu } from '../gb/ppu';

export const SCREEN_W = 20;
export const SCREEN_H = 18;
/** An OAM-like object: top-left pixel position, glyph code, OAM attribute flips, rOBP */
export interface ScreenObject {
  x: number;
  y: number;
  code: number;
  flags?: number;
  obp?: number;
}

export const EMPTY = -1;

export class TileScreen {
  readonly canvas?: HTMLCanvasElement;
  private readonly ctx?: CanvasRenderingContext2D;
  readonly cells = new Int16Array(SCREEN_W * SCREEN_H).fill(EMPTY);
  private glyphs = new Map<number, ImageData>();
  private colors: RGB[] = [
    [248, 248, 248],
    [168, 168, 168],
    [96, 96, 96],
    [16, 16, 16],
  ];
  private dirty = true;

  constructor(
    parent: HTMLElement | null,
    private readonly bundle: GameBundle,
  ) {
    if (!parent || typeof document === 'undefined') return; // headless (tests, tools)
    this.canvas = document.createElement('canvas');
    this.canvas.width = SCREEN_W * 8;
    this.canvas.height = SCREEN_H * 8;
    this.canvas.className = 'gb-screen';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  setPalette(colors: RGB[]): void {
    this.colors = colors;
    this.extraPalettes = [];
    this.attrs.fill(0);
    this.glyphs.clear();
    this.objCanvases.clear();
    this.dirty = true;
  }

  /**
   * SGB palette layout (PAL_SET + ATTR_BLK): up to four palettes, palette 0 being the
   * one passed to setPalette, assigned per cell by rectangles applied in order.
   */
  private extraPalettes: RGB[][] = [];
  private readonly attrs = new Uint8Array(SCREEN_W * SCREEN_H);
  setPaletteLayout(palettes: RGB[][], blocks: { pal: number; x0: number; y0: number; x1: number; y1: number }[]): void {
    this.colors = palettes[0];
    this.extraPalettes = palettes;
    this.attrs.fill(0);
    for (const b of blocks)
      for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (x < SCREEN_W && y < SCREEN_H) this.attrs[y * SCREEN_W + x] = b.pal;
    this.glyphs.clear();
    this.objCanvases.clear();
    this.dirty = true;
  }
  /** Colour of a pixel in a screen cell, including SGB attributes and fades.
   * Objects use OBP, not the background's BGP remap.
   */
  colorAt(x: number, y: number, index: number, background = true): RGB {
    const pal = x >= 0 && y >= 0 && x < SCREEN_W && y < SCREEN_H ? this.attrs[y * SCREEN_W + x] : 0;
    const colors = pal ? (this.extraPalettes[pal] ?? this.colors) : this.colors;
    return colors[this.faded(background && this.shadeMap ? this.shadeMap[index] : index)];
  }

  /** rBGP xor $40: color 3 drawn with shade 2 (the slot machine's win flash). */
  setShadeSwap(on: boolean): void {
    this.setShadeMap(on ? [0, 1, 2, 2] : undefined);
  }
  /**
   * A whole-screen rBGP: shadeMap[color] is the palette entry drawn for each color index.
   * With `shiftFont` the font and text-box tiles draw their color 3 as color 1
   * (ShiftFontColorIndex, so the credits text can fade in).
   */
  private shadeMap: number[] | undefined;
  private shiftFont = false;
  setShadeMap(map: number[] | undefined, shiftFont = this.shiftFont): void {
    if (String(map) === String(this.shadeMap) && shiftFont === this.shiftFont) return;
    this.shadeMap = map;
    this.shiftFont = map ? shiftFont : false;
    this.glyphs.clear();
    this.dirty = true;
  }
  /**
   * The FadePal rBGP of a palette fade (GBFadeOutToBlack etc.), applied over
   * everything drawn, the PPU's shades included; undefined when normal.
   */
  private fadeMap: number[] | undefined;
  setFadeMap(map: number[] | undefined): void {
    if (String(map) === String(this.fadeMap)) return;
    this.fadeMap = map;
    this.glyphs.clear();
    this.objCanvases.clear();
    this.dirty = true;
  }
  private faded(shade: number): number {
    return this.fadeMap ? this.fadeMap[shade] : shade;
  }

  /** Palette index of a cell (for tests). */
  paletteAt(x: number, y: number): number {
    return this.attrs[y * SCREEN_W + x];
  }

  private overrides = new Map<number, ArrayLike<number>>();
  /** The pixels a glyph override put on a code (undefined: the font's own). */
  glyphOverride(code: number): ArrayLike<number> | undefined {
    return this.overrides.get(code);
  }
  /** Temporarily replace a glyph (the naming screen loads HP-bar tiles over $62-$7F and ED at $F0). */
  setGlyphOverride(code: number, pixels: ArrayLike<number> | undefined): void {
    if (pixels) this.overrides.set(code, pixels);
    else this.overrides.delete(code);
    for (let p = 0; p < 4; p++) this.glyphs.delete(code + p * 0x10000);
    this.dropObjCanvases(code);
    this.dirty = true;
  }
  clearGlyphOverrides(): void {
    for (const k of this.overrides.keys()) {
      for (let p = 0; p < 4; p++) this.glyphs.delete(k + p * 0x10000);
      this.dropObjCanvases(k);
    }
    this.overrides.clear();
    this.dirty = true;
  }

  /** Raw colour indices, before BGP/fades (also used by full-screen PPU sequences). */
  glyphIndices(code: number): ArrayLike<number> {
    const override = this.overrides.get(code);
    if (override) return override;
    for (const font of [this.bundle.ui.font, this.bundle.ui.fontExtra]) {
      const i = code - font.firstChar!;
      if (i >= 0 && i < font.count) return font.pixels.slice(i * 64, i * 64 + 64);
    }
    return new Uint8Array(64);
  }

  private glyph(code: number, pal = 0): ImageData {
    const key = pal ? code + pal * 0x10000 : code;
    let g = this.glyphs.get(key);
    if (g) return g;
    const colors = pal ? (this.extraPalettes[pal] ?? this.colors) : this.colors;
    const shifted = this.shiftFont && ((code >= 0x80 && code <= 0xff) || (code >= 0x60 && code < 0x80 && !this.overrides.has(code)));
    g = new ImageData(8, 8);
    const px = this.glyphIndices(code);
    for (let p = 0; p < 64; p++) {
      let idx = px ? px[p] : 0;
      if (shifted && idx === 3) idx = 1;
      const col = colors[this.faded(this.shadeMap ? this.shadeMap[idx] : idx)];
      g.data[p * 4] = col[0];
      g.data[p * 4 + 1] = col[1];
      g.data[p * 4 + 2] = col[2];
      g.data[p * 4 + 3] = 255;
    }
    this.glyphs.set(key, g);
    return g;
  }

  put(x: number, y: number, code: number): void {
    if (x < 0 || y < 0 || x >= SCREEN_W || y >= SCREEN_H) return;
    this.cells[y * SCREEN_W + x] = code;
    this.dirty = true;
  }

  get(x: number, y: number): number {
    return this.cells[y * SCREEN_W + x];
  }

  fill(x: number, y: number, w: number, h: number, code: number): void {
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) this.put(x + i, y + j, code);
  }

  markDirty(): void {
    this.dirty = true;
  }

  clear(): void {
    this.cells.fill(EMPTY);
    this.dirty = true;
  }

  /** TextBoxBorder: border at (x,y) around an interior of w x h (home/text.asm). */
  box(x: number, y: number, h: number, w: number): void {
    this.put(x, y, 0x79);
    this.fill(x + 1, y, w, 1, 0x7a);
    this.put(x + w + 1, y, 0x7b);
    for (let j = 1; j <= h; j++) {
      this.put(x, y + j, 0x7c);
      this.fill(x + 1, y + j, w, 1, 0x7f);
      this.put(x + w + 1, y + j, 0x7c);
    }
    this.put(x, y + h + 1, 0x7d);
    this.fill(x + 1, y + h + 1, w, 1, 0x7a);
    this.put(x + w + 1, y + h + 1, 0x7e);
  }

  /** Text currently on screen, row by row (for tests and accessibility). */
  textRows(decode: (code: number) => string): string[] {
    const rows: string[] = [];
    for (let y = 0; y < SCREEN_H; y++) {
      let r = '';
      for (let x = 0; x < SCREEN_W; x++) {
        const code = this.cells[y * SCREEN_W + x];
        r += code === EMPTY ? ' ' : decode(code);
      }
      rows.push(r);
    }
    return rows;
  }

  /** Background scroll in pixels (screen shakes move the whole layer, like rWX/rWY). */
  private ox = 0;
  private oy = 0;
  setScroll(x: number, y: number): void {
    if (x === this.ox && y === this.oy) return;
    this.ox = x;
    this.oy = y;
    this.dirty = true;
  }
  get scroll(): [number, number] {
    return [this.ox, this.oy];
  }

  /**
   * OAM-like objects drawn over the tiles at pixel positions; color 0 is transparent.
   * `flags` holds OAM attribute flips (bit 5 X, bit 6 Y); `obp` an rOBP value
   * (color → shade), else the colors are drawn as they are.
   */
  private objs: ScreenObject[] = [];
  setObjects(objs: ScreenObject[]): void {
    this.objs = objs;
    this.dirty = true;
  }
  get objects(): readonly ScreenObject[] {
    return this.objs;
  }
  private objCanvases = new Map<string, HTMLCanvasElement>();
  private dropObjCanvases(code: number): void {
    for (const k of [...this.objCanvases.keys()]) if (k.startsWith(`${code}:`)) this.objCanvases.delete(k);
  }
  private objectGlyph(code: number, flags = 0, obp?: number, ox = 0, oy = 0): HTMLCanvasElement {
    const palettes = [0, 7].flatMap((y) => [0, 7].map((x) => this.paletteAt(Math.floor((ox + x) / 8), Math.floor((oy + y) / 8)) ?? 0));
    const key = `${code}:${flags & 0x60}:${obp ?? ''}:${palettes}:${ox & 7}:${oy & 7}`;
    let cv = this.objCanvases.get(key);
    if (cv) return cv;
    const px = this.overrides.get(code);
    const data = new ImageData(8, 8);
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
      const sx = flags & 0x20 ? 7 - x : x;
      const sy = flags & 0x40 ? 7 - y : y;
      const v = px ? px[sy * 8 + sx] : 0;
      const shade = obp === undefined ? v : (obp >> (v * 2)) & 3;
      const col = this.colorAt(Math.floor((ox + x) / 8), Math.floor((oy + y) / 8), shade, obp === undefined);
      const i = (y * 8 + x) * 4;
      data.data[i] = col[0]; data.data[i + 1] = col[1]; data.data[i + 2] = col[2];
      data.data[i + 3] = v ? 255 : 0;
    }
    cv = document.createElement('canvas');
    cv.width = cv.height = 8;
    cv.getContext('2d')!.putImageData(data, 0, 0);
    this.objCanvases.set(key, cv);
    return cv;
  }

  /**
   * Per-scanline BG x offsets (rSCX changed in H-blank: the wavy screen, the
   * enemy HUD shake): line y of the tile layer is drawn shifted by lineScroll[y]
   * pixels, under the objects. Undefined when off.
   */
  private lineScroll: Int8Array | undefined;
  setLineScroll(offsets: Int8Array | undefined): void {
    this.lineScroll = offsets;
    this.dirty = true;
  }

  /**
   * While set, the screen shows this PPU instead of the tile grid (the minigame and
   * title screens drive the hardware directly). Call ppuFrameReady() once per frame.
   */
  ppu: Ppu | undefined;
  /** Fill the whole screen with colour 0 behind the tiles (full-screen sequences like Oak's speech). */
  backdrop = false;
  private ppuShades = new Uint8Array(LCD_W * LCD_H);
  private ppuImage?: ImageData;
  setPpu(ppu: Ppu | undefined): void {
    this.ppu = ppu;
    this.dirty = true;
  }
  ppuFrameReady(): void {
    this.dirty = true;
  }
  private drawPpu(): void {
    const ppu = this.ppu!;
    ppu.render(this.ppuShades);
    this.ppuImage ??= new ImageData(LCD_W, LCD_H);
    const d = this.ppuImage.data;
    for (let y = 0; y < LCD_H; y++)
      for (let x = 0; x < LCD_W; x++) {
        const pal = this.attrs[(y >> 3) * SCREEN_W + (x >> 3)];
        const colors = pal ? (this.extraPalettes[pal] ?? this.colors) : this.colors;
        const col = colors[this.faded(this.ppuShades[y * LCD_W + x])];
        const i = (y * LCD_W + x) * 4;
        d[i] = col[0];
        d[i + 1] = col[1];
        d[i + 2] = col[2];
        d[i + 3] = 255;
      }
    this.ctx!.putImageData(this.ppuImage, 0, 0);
  }

  draw(): void {
    if (!this.dirty || !this.ctx || !this.canvas) return;
    this.dirty = false;
    if (this.ppu) return this.drawPpu();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (this.backdrop) {
      const c0 = this.colors[this.faded(0)];
      this.ctx.fillStyle = `rgb(${c0[0]},${c0[1]},${c0[2]})`;
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    for (let y = 0; y < SCREEN_H; y++)
      for (let x = 0; x < SCREEN_W; x++) {
        const code = this.cells[y * SCREEN_W + x];
        if (code !== EMPTY) this.ctx.putImageData(this.glyph(code, this.attrs[y * SCREEN_W + x]), x * 8 + this.ox, y * 8 + this.oy);
      }
    if (this.lineScroll) {
      const w = this.canvas.width;
      const img = this.ctx.getImageData(0, 0, w, Math.min(this.canvas.height, this.lineScroll.length));
      const src = new Uint8ClampedArray(img.data);
      const c0 = this.colors[this.faded(0)];
      for (let y = 0; y < img.height; y++) {
        const dx = this.lineScroll[y];
        if (!dx) continue;
        for (let x = 0; x < w; x++) {
          const sx = x - dx;
          const i = (y * w + x) * 4;
          if (sx < 0 || sx >= w) {
            img.data[i] = c0[0];
            img.data[i + 1] = c0[1];
            img.data[i + 2] = c0[2];
            img.data[i + 3] = 255;
          } else for (let k = 0; k < 4; k++) img.data[i + k] = src[(y * w + sx) * 4 + k];
        }
      }
      this.ctx.putImageData(img, 0, 0);
    }
    for (const o of this.objs) this.ctx.drawImage(this.objectGlyph(o.code, o.flags, o.obp, o.x, o.y), o.x, o.y);
  }
}
