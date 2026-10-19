/**
 * Pokémon Yellow (English) text encoding and text-command stream decoding.
 * Mirrors home/text.asm (PlaceString / TextCommandProcessor) in pokeyellow.
 */
import type { Rom } from './Rom';
import { fromOffset, labelsAt, ramLabelAt, toOffset } from './symbols';
import type { TextOp } from '../data/schema';

/** Printable characters ($60-$FF + space), keyed by byte. */
const CHARS: Record<number, string> = {
  0x69: '𝐕', 0x6a: '𝐒', 0x6d: ':', 0x6e: '<LV>', 0x6f: 'ぅ',
  0x70: '‘', 0x71: '’', 0x72: '“', 0x73: '”', 0x74: '·', 0x75: '…',
  0x79: '┌', 0x7a: '─', 0x7b: '┐', 0x7c: '│', 0x7d: '└', 0x7e: '┘', 0x7f: ' ',
  0x9a: '(', 0x9b: ')', 0x9c: ':', 0x9d: ';', 0x9e: '[', 0x9f: ']',
  0xba: 'é', 0xbb: "'d", 0xbc: "'l", 0xbd: "'s", 0xbe: "'t", 0xbf: "'v",
  0xe0: "'", 0xe1: '<PK>', 0xe2: '<MN>', 0xe3: '-', 0xe4: "'r", 0xe5: "'m",
  0xe6: '?', 0xe7: '!', 0xe8: '.', 0xec: '▷', 0xed: '▶', 0xee: '▼',
  0xef: '♂', 0xf0: '¥', 0xf1: '×', 0xf2: '.', 0xf3: '/', 0xf4: ',', 0xf5: '♀',
};
for (let i = 0; i < 26; i++) {
  CHARS[0x80 + i] = String.fromCharCode(65 + i);
  CHARS[0xa0 + i] = String.fromCharCode(97 + i);
}
for (let i = 0; i < 10; i++) CHARS[0xf6 + i] = String(i);

/**
 * Control characters, rendered as `{token}` inside decoded strings so the
 * dialogue engine can interpret them (see src/ui/dialogue.ts).
 */
const CONTROL: Record<number, string> = {
  0x00: '{null}', 0x49: '{page}', 0x4a: '{pkmn}', 0x4b: '{_cont}', 0x4c: '{scroll}',
  0x4e: '{next}', 0x4f: '{line}', 0x51: '{para}', 0x52: '{player}', 0x53: '{rival}',
  0x54: '{poke}', 0x55: '{cont}', 0x56: '{sixdots}', 0x57: '{done}', 0x58: '{prompt}',
  0x59: '{target}', 0x5a: '{user}', 0x5b: '{pc}', 0x5c: '{tm}', 0x5d: '{trainer}',
  0x5e: '{rocket}', 0x5f: '{dexend}',
};

export const TERMINATOR = 0x50;

/** Decode a plain "@"-terminated string (names, menu labels). */
export function decodeString(rom: Rom, off: number, maxLen = 64): string {
  let s = '';
  for (let i = 0; i < maxLen; i++) {
    const b = rom.u8(off + i);
    if (b === TERMINATOR) break;
    s += charFor(b);
  }
  return s;
}

/** Decode a fixed-length, "@"-padded name field. */
export function decodeFixed(rom: Rom, off: number, len: number): string {
  return decodeString(rom, off, len);
}

export function charFor(b: number): string {
  const ch = CHARS[b] ?? CONTROL[b];
  if (ch === undefined) return `{x${b.toString(16).padStart(2, '0')}}`;
  return ch;
}

/** Encode a JS string into Yellow's charset (for names entered by the player). */
export function encodeString(s: string): number[] {
  const rev = new Map<string, number>();
  for (const [k, v] of Object.entries(CHARS)) if (!rev.has(v)) rev.set(v, Number(k));
  const out: number[] = [];
  for (const ch of s) {
    const b = rev.get(ch);
    if (b === undefined) throw new Error(`character not encodable: ${ch}`);
    out.push(b);
  }
  return out;
}

export class TextDecodeError extends Error {}

/** Name of the label at a ROM offset (preferring the most specific one). */
export function labelFor(off: number): string {
  const names = labelsAt(off);
  if (names.length) return names[0];
  const [bank, addr] = fromOffset(off);
  return `rom_${bank.toString(16).padStart(2, '0')}_${addr.toString(16).padStart(4, '0')}`;
}

function ramName(addr: number): string {
  return ramLabelAt(addr) ?? `ram_${addr.toString(16)}`;
}

/**
 * Decode a text command stream starting at `off` (in `bank`).
 * - TX_FAR preserves its nested processor scope (DONE/PROMPT return to the caller).
 * - TX_START_ASM yields an `asm` op naming the code label; decoding stops
 *   there, since what follows is Game Boy code (ported by hand in src/script).
 */
export function decodeTextCommands(rom: Rom, off: number, depth = 0): TextOp[] {
  if (depth > 4) throw new TextDecodeError('text_far nesting too deep');
  const ops: TextOp[] = [];
  const [bank] = fromOffset(off);
  let p = off;
  const limit = off + 4096;
  for (;;) {
    if (p >= limit) throw new TextDecodeError('unterminated text');
    const cmd = rom.u8(p++);
    switch (cmd) {
      case 0x00: {
        // TX_START: characters until '@' (or <DONE>/<PROMPT>, which end the whole text)
        let s = '';
        let ended = false;
        for (;;) {
          if (p >= limit) throw new TextDecodeError('unterminated string');
          const b = rom.u8(p++);
          if (b === TERMINATOR) break;
          if (b < 0x49 && b !== 0x00) throw new TextDecodeError(`bad char $${b.toString(16)}`);
          if (b >= 0x60 && CHARS[b] === undefined) throw new TextDecodeError(`bad char $${b.toString(16)}`);
          s += charFor(b);
          // <DONE>, <PROMPT> and <DEXEND> end the whole text (see DoneText / PlaceDexEnd).
          if (b === 0x57 || b === 0x58 || b === 0x5f) {
            ended = true;
            break;
          }
        }
        ops.push({ t: 'text', v: s });
        if (ended) return ops;
        break;
      }
      case 0x01:
        ops.push({ t: 'ram', addr: ramName(rom.u16(p)), a: rom.u16(p) });
        p += 2;
        break;
      case 0x02:
        ops.push({ t: 'bcd', addr: ramName(rom.u16(p)), flags: rom.u8(p + 2), a: rom.u16(p) });
        p += 3;
        break;
      case 0x03:
        ops.push({ t: 'move', coord: rom.u16(p) });
        p += 2;
        break;
      case 0x04:
        ops.push({ t: 'box', coord: rom.u16(p), h: rom.u8(p + 2), w: rom.u8(p + 3) });
        p += 4;
        break;
      case 0x05:
        ops.push({ t: 'low' });
        break;
      case 0x06:
        ops.push({ t: 'promptbutton' });
        break;
      case 0x07:
        ops.push({ t: 'scroll' });
        break;
      case 0x08:
        // Key the code by the label of the text it belongs to (usually at the $08 byte itself).
        ops.push({ t: 'asm', label: labelsAt(p)[0] ?? labelsAt(p - 1)[0] ?? labelFor(off), at: p });
        return ops;
      case 0x09: {
        const nib = rom.u8(p + 2);
        ops.push({ t: 'num', addr: ramName(rom.u16(p)), bytes: nib >> 4, digits: nib & 0xf, a: rom.u16(p) });
        p += 3;
        break;
      }
      case 0x0a:
        ops.push({ t: 'pause' });
        break;
      case 0x0c:
        ops.push({ t: 'dots', n: rom.u8(p) });
        p += 1;
        break;
      case 0x0d:
        ops.push({ t: 'waitbutton' });
        break;
      case 0x0b: case 0x0e: case 0x0f: case 0x10: case 0x11:
      case 0x12: case 0x13: case 0x14: case 0x15: case 0x16:
        ops.push({ t: 'sound', id: cmd });
        break;
      case 0x17: {
        const addr = rom.u16(p);
        const b = rom.u8(p + 2);
        p += 3;
        ops.push({ t: 'far', ops: decodeTextCommands(rom, toOffset(b, addr), depth + 1) });
        break;
      }
      case 0x50:
        return ops;
      default:
        throw new TextDecodeError(`unknown text command $${cmd.toString(16)} at ${bank.toString(16)}:${(p - 1).toString(16)}`);
    }
  }
}

/** Inspect every command without losing FAR scopes in the executable stream. */
export function* walkTextOps(ops: TextOp[]): Generator<TextOp> {
  for (const op of ops) {
    yield op;
    if (op.t === 'far') yield* walkTextOps(op.ops);
  }
}
/** Battle/item text chains intentionally omit script hand-offs, including nested ones. */
export function withoutTextAsm(ops: TextOp[]): TextOp[] {
  return ops.filter((op) => op.t !== 'asm').map((op) => op.t === 'far' ? { ...op, ops: withoutTextAsm(op.ops) } : op);
}

/** Convenience for tests/debugging: flatten ops into readable text. */
export function opsToPlain(ops: TextOp[]): string {
  return ops
    .map((o) => {
      switch (o.t) {
        case 'far':
          return opsToPlain(o.ops);
        case 'text':
          return o.v;
        case 'ram':
          return `{ram:${o.addr}}`;
        case 'num':
          return `{num:${o.addr}}`;
        case 'bcd':
          return `{bcd:${o.addr}}`;
        case 'asm':
          return `{asm:${o.label}}`;
        default:
          return '';
      }
    })
    .join('');
}
