/**
 * The bits of the Game Boy's VBlank handling the full-screen sequences rely on
 * (home/vblank.asm): hSCX/hSCY/hWX/hWY copied to the PPU, wTileMap transferred
 * to a BG map a third per frame (AutoBgMapTransfer), shadow OAM DMA. The
 * sequences draw into `tileMap`/`shadowOam` and call vblank() once per frame.
 */
import type { Co, Engine } from '../engine/Engine';
import { Ppu, type OamEntry } from './ppu';

export class GbHardware {
  readonly ppu = new Ppu();
  readonly tileMap = new Uint8Array(20 * 18);
  readonly shadowOam: OamEntry[] = Array.from({ length: 40 }, () => ({ y: 0, x: 0, tile: 0, attr: 0 }));
  /** hAutoBGTransferEnabled / hAutoBGTransferDest (a tile-map address: $9800 + offset) */
  autoBgTransfer = false;
  autoBgDest = 0x9800;
  private autoBgPart = 0;
  scx = 0;
  scy = 0;
  wx = 7;
  wy = 0;

  constructor(readonly e: Engine) {}

  /** Write one BG-map byte at a VRAM address in $9800-$9FFF. */
  poke(addr: number, v: number): void {
    const a = (addr - 0x9800) & 0x7ff;
    this.ppu.bgMaps[a >> 10][a & 0x3ff] = v;
  }

  /** The whole of wTileMap to the transfer destination at once (TitleScreenCopyTileMapToVRAM + Delay3). */
  copyTileMapNow(dest = this.autoBgDest): void {
    for (let y = 0; y < 18; y++) for (let x = 0; x < 20; x++) this.poke(dest + y * 32 + x, this.tileMap[y * 20 + x]);
  }

  /** VBlank, then one frame. */
  *vblank(): Co {
    const p = this.ppu;
    p.scx = this.scx;
    p.scy = this.scy;
    p.wx = this.wx;
    p.wy = this.wy;
    if (this.autoBgTransfer) {
      for (let y = this.autoBgPart * 6; y < this.autoBgPart * 6 + 6; y++)
        for (let x = 0; x < 20; x++) this.poke(this.autoBgDest + y * 32 + x, this.tileMap[y * 20 + x]);
      this.autoBgPart = (this.autoBgPart + 1) % 3;
    }
    this.shadowOam.forEach((o, i) => Object.assign(p.oam[i], o));
    this.e.screen.ppuFrameReady();
    yield;
  }

  *delayFrames(n: number): Co {
    for (let i = 0; i < n; i++) yield* this.vblank();
  }

  clearOam(): void {
    for (const o of this.shadowOam) o.y = o.x = o.tile = o.attr = 0;
  }
}
