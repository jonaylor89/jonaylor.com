import { sym, toOffset } from './symbols';

/** SHA-1 of the only supported image: Pokémon Yellow Version (USA, Europe) (CGB). */
export const SUPPORTED_ROMS: Record<string, string> = {
  cc7d03262ebfaf2f06772c1a480c7d9d5f4a38e1: 'Pokémon Yellow Version (USA, Europe)',
};

export async function sha1Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class RomError extends Error {}

/** Thin read-only view over the user's ROM image with bank-aware helpers. */
export class Rom {
  constructor(readonly bytes: Uint8Array) {
    if (bytes.length !== 0x100000) throw new RomError(`expected a 1 MiB ROM, got ${bytes.length} bytes`);
  }

  static async load(bytes: Uint8Array): Promise<{ rom: Rom; sha1: string; title: string }> {
    const sha1 = await sha1Hex(bytes);
    const title = SUPPORTED_ROMS[sha1];
    if (!title) {
      const header = String.fromCharCode(...bytes.subarray(0x134, 0x143)).replace(/\0.*$/, '');
      throw new RomError(
        `Unsupported ROM (header "${header}", sha1 ${sha1}). ` +
          'Please supply an unmodified Pokémon Yellow (USA/Europe) ROM dump.',
      );
    }
    return { rom: new Rom(bytes), sha1, title };
  }

  u8(off: number): number {
    if (off < 0 || off >= this.bytes.length) throw new RangeError(`ROM read out of range: ${off}`);
    return this.bytes[off];
  }
  s8(off: number): number {
    const v = this.u8(off);
    return v >= 0x80 ? v - 0x100 : v;
  }
  u16(off: number): number {
    return this.u8(off) | (this.u8(off + 1) << 8);
  }
  u16be(off: number): number {
    return (this.u8(off) << 8) | this.u8(off + 1);
  }
  slice(off: number, len: number): Uint8Array {
    return this.bytes.slice(off, off + len);
  }
  /** Resolve a 16-bit pointer read at `off`, assuming it points into `bank`. */
  ptr(off: number, bank: number): number {
    return toOffset(bank, this.u16(off));
  }
  /** Offset of a ROM label. */
  sym(name: string): number {
    return sym(name);
  }
  reader(off: number): Reader {
    return new Reader(this, off);
  }
}

/** Sequential cursor over ROM bytes. */
export class Reader {
  constructor(
    private readonly rom: Rom,
    public off: number,
  ) {}
  u8(): number {
    return this.rom.u8(this.off++);
  }
  s8(): number {
    return this.rom.s8(this.off++);
  }
  u16(): number {
    const v = this.rom.u16(this.off);
    this.off += 2;
    return v;
  }
  bytes(n: number): Uint8Array {
    const v = this.rom.slice(this.off, n);
    this.off += n;
    return v;
  }
  peek(): number {
    return this.rom.u8(this.off);
  }
}
