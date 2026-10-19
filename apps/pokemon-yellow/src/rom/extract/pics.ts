/**
 * Pokémon and trainer pics: a port of the Gen 1 sprite decompressor
 * (home/uncompress.asm; same algorithm as pret's tools/pkmncompress.c).
 * Output is 2bpp tile data, row-major, width×width tiles.
 */
import type { Rom } from '../Rom';
import type { GameBundle, Pic } from '../../data/schema';
import { c, sym, symBank, toOffset } from '../symbols';

export function uncompressPic(rom: Rom, offset: number): { width: number; data: Uint8Array } {
  let byte = offset;
  let bit = 7;
  const readBit = () => {
    if (bit === -1) {
      byte++;
      bit = 7;
    }
    return (rom.u8(byte) >> bit--) & 1;
  };
  const readInt = (n: number) => {
    let v = 0;
    while (n--) v = (v << 1) | readBit();
    return v;
  };
  const width = readInt(4);
  if (readInt(4) !== width) throw new Error(`pic at ${offset} is not square`);
  const size = width * width * 8;
  const TABLE = [0x1, 0x3, 0x7, 0xf, 0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff, 0xffff];

  const fillPlane = (): Uint8Array => {
    let mode = readBit();
    const psize = width * width * 0x20;
    const plane = new Uint8Array(psize);
    let len = 0;
    while (len < psize) {
      if (mode) {
        while (len < psize) {
          const g = readInt(2);
          if (!g) break;
          plane[len++] = g;
        }
      } else {
        let w = 0;
        while (readBit()) w++;
        if (w >= TABLE.length) throw new Error('invalid compressed pic');
        let n = TABLE[w] + readInt(w + 1);
        while (len < psize && n--) plane[len++] = 0;
      }
      mode ^= 1;
    }
    const ram = new Uint8Array(psize);
    let k = 0;
    for (let y = 0; y < width; y++)
      for (let x = 0; x < width * 8; x++) for (let i = 0; i < 4; i++) ram[k++] = plane[(y * 4 + i) * width * 8 + x];
    const out = new Uint8Array(size);
    for (let i = 0; i < psize - 3; i += 4) out[i / 4] = (ram[i] << 6) | (ram[i + 1] << 4) | (ram[i + 2] << 2) | ram[i + 3];
    return out;
  };

  const CODES = [
    [0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5, 0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa],
    [0xf, 0xe, 0xc, 0xd, 0x8, 0x9, 0xb, 0xa, 0x0, 0x1, 0x3, 0x2, 0x7, 0x6, 0x4, 0x5],
  ];
  const uncompressPlane = (p: Uint8Array) => {
    for (let x = 0; x < width * 8; x++) {
      let b = 0;
      for (let y = 0; y < width; y++) {
        const i = y * width * 8 + x;
        const hi = CODES[b][(p[i] >> 4) & 0xf];
        b = hi & 1;
        const lo = CODES[b][p[i] & 0xf];
        b = lo & 1;
        p[i] = (hi << 4) | lo;
      }
    }
  };

  const rams: Uint8Array[] = [];
  const order = readBit();
  rams[order] = fillPlane();
  let mode = readBit();
  if (mode) mode += readBit();
  rams[order ^ 1] = fillPlane();
  uncompressPlane(rams[order]);
  if (mode !== 1) uncompressPlane(rams[order ^ 1]);
  if (mode !== 0) for (let i = 0; i < size; i++) rams[order ^ 1][i] ^= rams[order][i];
  const out = new Uint8Array(size * 2);
  for (let i = 0; i < size; i++) {
    out[i * 2] = rams[0][i];
    out[i * 2 + 1] = rams[1][i];
  }
  // transpose_tiles: column-major → row-major
  const n = width * width;
  for (let i = 0; i < n; i++) {
    const j = (i * width + Math.floor(i / width)) % n;
    if (i < j) {
      const tmp = out.slice(i * 16, i * 16 + 16);
      out.copyWithin(i * 16, j * 16, j * 16 + 16);
      out.set(tmp, j * 16);
    }
  }
  return { width, data: out };
}

function toPic(rom: Rom, offset: number): Pic {
  const { width, data } = uncompressPic(rom, offset);
  let bin = '';
  for (const b of data) bin += String.fromCharCode(b);
  return { width, data: btoa(bin) };
}

/** Bank selection from UncompressMonSprite (home/pics.asm). */
function picBank(index: number): number {
  if (index === c('pokemon', 'FOSSIL_KABUTOPS')) return symBank('FossilKabutopsPic');
  if (index < c('pokemon', 'TANGELA') + 1) return 0x9;
  if (index < c('pokemon', 'MOLTRES') + 1) return 0xa;
  if (index < c('pokemon', 'BEEDRILL') + 2) return 0xb;
  if (index < c('pokemon', 'STARMIE') + 1) return 0xc;
  return 0xd;
}

export function extractPics(rom: Rom, bundle: Pick<GameBundle, 'species' | 'trainers'>): GameBundle['pics'] {
  const front: Record<number, Pic> = {};
  const back: Record<number, Pic> = {};
  const size = c('pokemon_data', 'BASE_DATA_SIZE');
  const base = rom.sym('BaseStats');
  for (const sp of Object.values(bundle.species)) {
    const p = base + (sp.dex - 1) * size;
    const bank = picBank(sp.index);
    front[sp.index] = toPic(rom, toOffset(bank, rom.u16(p + 11)));
    back[sp.index] = toPic(rom, toOffset(bank, rom.u16(p + 13)));
  }
  const trainers: Record<number, Pic> = {};
  const table = rom.sym('TrainerPicAndMoneyPointers');
  const tbank = symBank('YoungsterPic');
  for (const t of bundle.trainers) trainers[t.id] = toPic(rom, toOffset(tbank, rom.u16(table + (t.id - 1) * 5)));
  const special: Record<string, Pic> = {};
  for (const l of ['RedPicFront', 'RedPicBack', 'OldManPicBack', 'ProfOakPicBack', 'GhostPic', 'FossilKabutopsPic', 'FossilAerodactylPic', 'ProfOakPic', 'Rival1Pic', 'ShrinkPic1', 'ShrinkPic2', 'JessieJamesPic']) {
    special[l] = toPic(rom, sym(l));
  }
  return { front, back, trainers, special };
}

/** Decode a stored pic into pixel indices (0-3), row-major width*8 square. */
export function picPixels(p: Pic): number[] {
  const bin = atob(p.data);
  const W = p.width * 8;
  const px = new Array<number>(W * W);
  for (let t = 0; t < p.width * p.width; t++) {
    const tx = (t % p.width) * 8;
    const ty = Math.floor(t / p.width) * 8;
    for (let y = 0; y < 8; y++) {
      const lo = bin.charCodeAt(t * 16 + y * 2);
      const hi = bin.charCodeAt(t * 16 + y * 2 + 1);
      for (let x = 0; x < 8; x++) px[(ty + y) * W + tx + x] = ((lo >> (7 - x)) & 1) | (((hi >> (7 - x)) & 1) << 1);
    }
  }
  return px;
}
