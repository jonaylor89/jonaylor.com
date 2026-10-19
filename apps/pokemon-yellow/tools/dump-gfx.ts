/**
 * Dev aid: dump tilesets / sprites from an extracted bundle to PNG files in
 * ./extracted/gfx (git-ignored) so the tile manifest can be authored visually.
 *   npx tsx tools/dump-gfx.ts [extracted/bundle.json]
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import type { GameBundle } from '../src/data/schema';

const bundle: GameBundle = JSON.parse(readFileSync(process.argv[2] ?? 'extracted/bundle.json', 'utf8'));
const out = 'extracted/gfx';
mkdirSync(out, { recursive: true });
const shades = [255, 170, 85, 0];

function png(w: number, h: number, rgb: Uint8Array): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Tilesets: 16 tiles per row, scaled 4x, with a 1px grid so ids can be read off.
const S = 4;
for (const ts of bundle.tilesets) {
  const cols = 16;
  const rows = Math.ceil(ts.tileCount / cols);
  const cw = 8 * S + 1;
  const w = cols * cw;
  const h = rows * cw;
  const rgb = new Uint8Array(w * h * 3).fill(200);
  for (let t = 0; t < ts.tileCount; t++) {
    const ox = (t % cols) * cw;
    const oy = Math.floor(t / cols) * cw;
    for (let y = 0; y < 8 * S; y++)
      for (let x = 0; x < 8 * S; x++) {
        const v = shades[ts.tilePixels[t * 64 + Math.floor(y / S) * 8 + Math.floor(x / S)]];
        const i = ((oy + y) * w + ox + x) * 3;
        rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
      }
  }
  writeFileSync(`${out}/tileset_${ts.id}_${ts.name}.png`, png(w, h, rgb));
}

// Map render (tiles) for a quick sanity check of block decoding.
for (const id of [0, 37, 40, 12]) {
  const m = bundle.maps[id];
  const ts = bundle.tilesets[m.tileset];
  const w = m.width * 32;
  const h = m.height * 32;
  const rgb = new Uint8Array(w * h * 3);
  for (let by = 0; by < m.height; by++)
    for (let bx = 0; bx < m.width; bx++) {
      const block = ts.blocks[m.blocks[by * m.width + bx]];
      for (let t = 0; t < 16; t++) {
        const tile = block[t];
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++) {
            const v = shades[ts.tilePixels[tile * 64 + y * 8 + x]];
            const px = bx * 32 + (t % 4) * 8 + x;
            const py = by * 32 + Math.floor(t / 4) * 8 + y;
            const i = (py * w + px) * 3;
            rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
          }
      }
    }
  writeFileSync(`${out}/map_${m.constName}.png`, png(w, h, rgb));
}

// Sprites: all frames in a row.
for (const sp of bundle.sprites.slice(0, 4)) {
  const w = sp.frames * 16;
  const rgb = new Uint8Array(w * 16 * 3);
  for (let f = 0; f < sp.frames; f++)
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const v = shades[sp.pixels[f * 256 + y * 16 + x]];
        const i = (y * w + f * 16 + x) * 3;
        rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
      }
  writeFileSync(`${out}/sprite_${sp.name}.png`, png(w, 16, rgb));
}
console.log('wrote', out);

// Pics: a strip of a few decompressed Pokémon / trainer pics (front 7x7 tiles, back 4x4).
import { picPixels } from '../src/rom/extract/pics';
{
  const pics = [
    bundle.pics.front[84],
    bundle.pics.back[84],
    bundle.pics.front[153],
    bundle.pics.front[21],
    bundle.pics.trainers[34],
    bundle.pics.special.RedPicBack,
    bundle.pics.special.GhostPic,
  ].filter(Boolean);
  const S2 = 2;
  const w = pics.length * 56 * S2;
  const h = 56 * S2;
  const rgb = new Uint8Array(w * h * 3).fill(255);
  pics.forEach((p, k) => {
    const W = p.width * 8;
    const px = picPixels(p);
    for (let y = 0; y < W * S2; y++)
      for (let x = 0; x < W * S2; x++) {
        const v = shades[px[Math.floor(y / S2) * W + Math.floor(x / S2)]];
        const i = (y * w + k * 56 * S2 + x) * 3;
        rgb[i] = rgb[i + 1] = rgb[i + 2] = v;
      }
  });
  writeFileSync(`${out}/pics.png`, png(w, h, rgb));
}
