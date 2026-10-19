/** 7x7-tile pics as glyph overrides: front pics bottom-centred, back pics doubled. */
import type { Engine } from '../engine/Engine';
import type { Pic } from '../data/schema';
import { picPixels } from '../rom/extract/pics';

const PIC_BASE = 0x100;

/** The 56x56 pixels of a front pic, bottom-centered (LoadFrontSpriteByMonIndex). */
export function frontPixels(pic: Pic): number[] {
  const W = pic.width * 8;
  const src = picPixels(pic);
  const out = new Array<number>(56 * 56).fill(0);
  const ox = (7 - pic.width) >> 1;
  const oy = 7 - pic.width;
  for (let py = 0; py < W; py++) for (let px = 0; px < W; px++) out[(oy * 8 + py) * 56 + ox * 8 + px] = src[py * W + px];
  return out;
}

/** ScaleSpriteByTwo: the top-left 28x28 of a back pic doubled. */
export function backPixels(pic: Pic): number[] {
  const W = pic.width * 8;
  const src = picPixels(pic);
  const out = new Array<number>(56 * 56).fill(0);
  for (let y = 0; y < 56; y++) for (let x = 0; x < 56; x++) out[y * 56 + x] = src[(y >> 1) * W + (x >> 1)] ?? 0;
  return out;
}

export function placePixels(e: Engine, px: number[], x: number, y: number, base = PIC_BASE): void {
  for (let ty = 0; ty < 7; ty++)
    for (let tx = 0; tx < 7; tx++) {
      const tile = new Array<number>(64);
      for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) tile[yy * 8 + xx] = px[(ty * 8 + yy) * 56 + tx * 8 + xx];
      const code = base + ty * 7 + tx;
      e.screen.setGlyphOverride(code, tile);
      e.screen.put(x + tx, y + ty, code);
    }
}

