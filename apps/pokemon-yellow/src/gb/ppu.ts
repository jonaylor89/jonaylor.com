/**
 * A small Game Boy picture processor for the screens that use the hardware
 * directly (the Surfing Pikachu minigame, the title screen): tile memory, two
 * 32x32 background maps, the window, scrolling with per-scanline overrides
 * (wLYOverrides written to a register at each HBlank), BGP/OBP0/OBP1 and 40
 * 8x8 objects. render() produces the final 160x144 shades (0 = white … 3 =
 * black); the SGB palette colours them per 8x8 screen cell (TileScreen).
 */

export const LCD_W = 160;
export const LCD_H = 144;

export interface OamEntry {
  y: number;
  x: number;
  tile: number;
  attr: number;
}

export class Ppu {
  /** 384 tiles of 64 colour indices: $00-$7F vChars0, $80-$FF vChars1, $100-$17F vChars2. */
  readonly tiles = new Uint8Array(0x180 * 64);
  /** vBGMap0 ($9800) and vBGMap1 ($9C00) */
  readonly bgMaps = [new Uint8Array(32 * 32), new Uint8Array(32 * 32)];
  readonly oam: OamEntry[] = Array.from({ length: 40 }, () => ({ y: 0, x: 0, tile: 0, attr: 0 }));
  lcdOn = true;
  bgOn = true;
  objOn = true;
  winOn = false;
  /** LCDC bit 3 / bit 6: which map the background / window use */
  bgMap = 0;
  winMap = 1;
  /** LCDC bit 4: tile data at $8000 (unsigned) instead of $8800 (signed, the Pokémon default) */
  tileData8000 = false;
  scx = 0;
  scy = 0;
  wx = 7;
  wy = 0;
  bgp = 0xe4;
  obp0 = 0xd0;
  obp1 = 0xe0;
  /** hLCDCPointer: the register wLYOverrides feeds ('scx' or 'scy'), or none */
  lyTarget: 'scx' | 'scy' | undefined;
  readonly lyOverrides = new Uint8Array(0x100);

  /** Load 2bpp-decoded tiles (64 indices each) at a tile index. */
  loadTiles(index: number, pixels: ArrayLike<number>, count = pixels.length / 64): void {
    for (let i = 0; i < count * 64 && (index * 64 + i) < this.tiles.length; i++) this.tiles[index * 64 + i] = pixels[i];
  }

  /** The tile index of a BG/window tile code under the current LCDC addressing. */
  private bgTile(code: number): number {
    return this.tileData8000 || code >= 0x80 ? code : 0x100 + code;
  }

  clearOam(): void {
    for (const o of this.oam) {
      o.y = 0;
      o.x = 0;
      o.tile = 0;
      o.attr = 0;
    }
  }

  /** Render one frame of shades into `out` (LCD_W * LCD_H). */
  render(out: Uint8Array): void {
    if (!this.lcdOn) {
      out.fill(0);
      return;
    }
    const bgIdx = new Uint8Array(LCD_W);
    let scx = this.scx;
    let scy = this.scy;
    let winLine = 0;
    for (let ly = 0; ly < LCD_H; ly++) {
      // the STAT handler wrote the override for the previous line during its HBlank
      if (ly > 0 && this.lyTarget) {
        if (this.lyTarget === 'scy') scy = this.lyOverrides[ly - 1];
        else scx = this.lyOverrides[ly - 1];
      }
      const row = out.subarray(ly * LCD_W, ly * LCD_W + LCD_W);
      const winVisible = this.winOn && ly >= this.wy && this.wx <= 166;
      for (let x = 0; x < LCD_W; x++) {
        let idx = 0;
        if (winVisible && x >= this.wx - 7) {
          const wxp = x - (this.wx - 7);
          const code = this.bgMaps[this.winMap][(winLine >> 3) * 32 + (wxp >> 3)];
          idx = this.tiles[this.bgTile(code) * 64 + (winLine & 7) * 8 + (wxp & 7)];
        } else if (this.bgOn) {
          const by = (ly + scy) & 0xff;
          const bx = (x + scx) & 0xff;
          const code = this.bgMaps[this.bgMap][(by >> 3) * 32 + (bx >> 3)];
          idx = this.tiles[this.bgTile(code) * 64 + (by & 7) * 8 + (bx & 7)];
        }
        bgIdx[x] = idx;
        row[x] = (this.bgp >> (idx * 2)) & 3;
      }
      if (winVisible) winLine++;
      if (!this.objOn) continue;
      // up to 10 objects per line; on DMG the lower X wins, then the lower OAM index
      const onLine: OamEntry[] = [];
      for (const o of this.oam) {
        const top = o.y - 16;
        if (ly >= top && ly < top + 8) {
          onLine.push(o);
          if (onLine.length === 10) break;
        }
      }
      onLine.sort((a, b) => a.x - b.x);
      for (let i = onLine.length - 1; i >= 0; i--) {
        const o = onLine[i];
        let ty = ly - (o.y - 16);
        if (o.attr & 0x40) ty = 7 - ty;
        const pal = o.attr & 0x10 ? this.obp1 : this.obp0;
        for (let px = 0; px < 8; px++) {
          const sx = o.x - 8 + px;
          if (sx < 0 || sx >= LCD_W) continue;
          const tx = o.attr & 0x20 ? 7 - px : px;
          const idx = this.tiles[o.tile * 64 + ty * 8 + tx];
          if (!idx) continue;
          if (o.attr & 0x80 && bgIdx[sx]) continue; // behind BG colours 1-3
          row[sx] = (pal >> (idx * 2)) & 3;
        }
      }
    }
  }
}
