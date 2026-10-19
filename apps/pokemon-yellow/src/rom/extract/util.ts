import type { Rom } from '../Rom';

/** Read bytes until `terminator` (exclusive). */
export function readUntil(rom: Rom, off: number, terminator = 0xff, max = 4096): number[] {
  const out: number[] = [];
  for (let i = 0; i < max; i++) {
    const b = rom.u8(off + i);
    if (b === terminator) return out;
    out.push(b);
  }
  throw new Error(`no terminator $${terminator.toString(16)} within ${max} bytes of ${off}`);
}

/** Decode a big-endian packed BCD number of `len` bytes. */
export function bcd(rom: Rom, off: number, len: number): number {
  let v = 0;
  for (let i = 0; i < len; i++) {
    const b = rom.u8(off + i);
    v = v * 100 + (b >> 4) * 10 + (b & 0xf);
  }
  return v;
}

/** Decode 2bpp tile data into pixel indices (0-3), 64 per tile. */
export function decode2bpp(data: Uint8Array): number[] {
  const tiles = data.length >> 4;
  const out = new Array<number>(tiles * 64);
  for (let t = 0; t < tiles; t++) {
    for (let y = 0; y < 8; y++) {
      const lo = data[t * 16 + y * 2];
      const hi = data[t * 16 + y * 2 + 1];
      for (let x = 0; x < 8; x++) {
        const bit = 7 - x;
        out[t * 64 + y * 8 + x] = ((lo >> bit) & 1) | (((hi >> bit) & 1) << 1);
      }
    }
  }
  return out;
}

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`extraction assertion failed: ${msg}`);
}
