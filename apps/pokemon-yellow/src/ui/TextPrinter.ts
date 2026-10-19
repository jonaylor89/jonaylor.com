/**
 * Text engine: a port of PlaceString / TextCommandProcessor (home/text.asm)
 * written as a coroutine, so letter delays, button waits and scrolling
 * happen on emulated frames exactly like the original.
 */
import type { TextOp } from '../data/schema';
import type { Button, InputFrame } from '../input/Input';
import { TileScreen } from './TileScreen';

export type Wait = { frames: number } | { button: true; arrow: boolean } | { release: true };

export interface TextContext {
  playerName: string;
  rivalName: string;
  /** Letter delay in frames (fast 1, medium 3, slow 5). */
  letterDelay: number;
  /** Strings/numbers held in RAM buffers referenced by text_ram/text_decimal/text_bcd. */
  ram(label: string, addr?: number): string | number | undefined;
  /** Hook for `text_asm`: the ported script for `label` (may print more text). */
  asm?(label: string): Generator<Wait, void, InputFrame> | undefined;
  missingAsm?(label: string): void;
  /** TextCommand_SOUND: the text command byte ($0b, $0e-$16) */
  sound?(cmd: number): void;
  /** WaitForSoundToFinish's condition */
  soundBusy?(): boolean;
  /** User/move names in battle text. */
  target?: string;
  user?: string;
}

const SPECIAL: Record<string, number> = {
  "'d": 0xbb, "'l": 0xbc, "'s": 0xbd, "'t": 0xbe, "'v": 0xbf, "'r": 0xe4, "'m": 0xe5,
  '<PK>': 0xe1, '<MN>': 0xe2, '<LV>': 0x6e,
};
const CHAR: Record<string, number> = {
  ' ': 0x7f, '(': 0x9a, ')': 0x9b, ':': 0x9c, ';': 0x9d, '[': 0x9e, ']': 0x9f, 'é': 0xba,
  "'": 0xe0, '-': 0xe3, '?': 0xe6, '!': 0xe7, '.': 0xe8, '▷': 0xec, '▶': 0xed, '▼': 0xee,
  '♂': 0xef, '¥': 0xf0, '×': 0xf1, '/': 0xf3, ',': 0xf4, '♀': 0xf5, '‘': 0x70, '’': 0x71,
  '“': 0x72, '”': 0x73, '…': 0x75, '┌': 0x79, '─': 0x7a, '┐': 0x7b, '│': 0x7c, '└': 0x7d, '┘': 0x7e,
};
for (let i = 0; i < 26; i++) {
  CHAR[String.fromCharCode(65 + i)] = 0x80 + i;
  CHAR[String.fromCharCode(97 + i)] = 0xa0 + i;
}
for (let i = 0; i < 10; i++) CHAR[String(i)] = 0xf6 + i;

export type Token = { code: number } | { ctl: string };

/** Split a decoded text string into glyph codes and control tokens. */
export function tokenize(s: string): Token[] {
  const out: Token[] = [];
  const re = /\{(\w+)\}|<PK>|<MN>|<LV>|'[dlstvrm]|[\s\S]/gu;
  for (const m of s.matchAll(re)) {
    if (m[1]) {
      const name = m[1];
      if (/^x[0-9a-f]{2}$/.test(name)) out.push({ code: parseInt(name.slice(1), 16) });
      else out.push({ ctl: name });
    } else {
      const code = SPECIAL[m[0]] ?? CHAR[m[0]];
      if (code === undefined) throw new Error(`unprintable character ${JSON.stringify(m[0])}`);
      out.push({ code });
    }
  }
  return out;
}

/** Glyph codes of a string, with PlaceString's fixed-text tokens (`#` → POKé, …) expanded. */
export function encodePlain(s: string): number[] {
  return tokenize(s).flatMap((t) => ('code' in t ? [t.code] : t.ctl in FIXED ? encodePlain(FIXED[t.ctl]) : []));
}

const FIXED: Record<string, string> = {
  poke: 'POKé', pc: 'PC', tm: 'TM', trainer: 'TRAINER', rocket: 'ROCKET', sixdots: '……', pkmn: '<PK><MN>',
};

/** State of the text cursor in the standard bottom text box. */
export class TextPrinter {
  cx = 1;
  cy = 14;
  private lineStartX = 1;
  constructor(
    readonly screen: TileScreen,
    readonly ctx: TextContext,
  ) {}

  /** Draw the standard dialogue box (TextBoxBorder at 0,12 with 4x18 interior). */
  openBox(): void {
    this.screen.box(0, 12, 4, 18);
    this.cx = this.lineStartX = 1;
    this.cy = 14;
  }

  closeBox(): void {
    this.screen.fill(0, 12, 20, 6, -1);
  }

  /** Run text commands. Ends at text_end, <DONE> or <PROMPT>. */
  *run(ops: TextOp[]): Generator<Wait, 'done' | 'prompt' | 'end' | 'asm', InputFrame> {
    for (const op of ops) {
      switch (op.t) {
        case 'far':
          // TextCommand_FAR calls TextCommandProcessor, restores the bank,
          // then resumes NextTextCommand even after nested DONE/PROMPT/ASM.
          yield* this.run(op.ops);
          break;
        case 'text': {
          const r = yield* this.placeString(op.v);
          if (r !== 'end') return r;
          break;
        }
        case 'ram': {
          const v = this.ctx.ram(op.addr, op.a);
          yield* this.placeString(String(v ?? '?'));
          break;
        }
        case 'num': {
          const v = Number(this.ctx.ram(op.addr, op.a) ?? 0);
          yield* this.placeString(String(v).slice(-op.digits));
          break;
        }
        case 'bcd':
          yield* this.placeString(formatBCD(Number(this.ctx.ram(op.addr, op.a) ?? 0), op.flags));
          break;
        case 'move':
          this.cx = this.lineStartX = (op.coord - 0xc3a0) % 20;
          this.cy = Math.floor((op.coord - 0xc3a0) / 20);
          break;
        case 'box': {
          const x = (op.coord - 0xc3a0) % 20;
          const y = Math.floor((op.coord - 0xc3a0) / 20);
          this.screen.box(x, y, op.h, op.w);
          break;
        }
        case 'low':
          this.cx = this.lineStartX = 1;
          this.cy = 16;
          break;
        case 'promptbutton':
          yield* this.waitArrow();
          break;
        case 'scroll':
          yield* this.scrollUp();
          this.cx = this.lineStartX = 1;
          this.cy = 16;
          break;
        case 'pause':
          yield { frames: 30 };
          break;
        case 'waitbutton':
          yield { button: true, arrow: false };
          break;
        case 'dots':
          for (let i = 0; i < op.n; i++) {
            this.screen.put(this.cx++, this.cy, 0x75);
            yield { frames: 10 };
          }
          break;
        case 'sound':
          // PlaySound / PlayCry, then WaitForSoundToFinish
          this.ctx.sound?.(op.id);
          while (this.ctx.soundBusy?.()) yield { frames: 1 };
          break;
        case 'asm': {
          const g = this.ctx.asm?.(op.label);
          if (!g) {
            this.ctx.missingAsm?.(op.label);
            console.warn(`[text] script for ${op.label} is not ported yet (see TASKS.md)`);
            return 'asm';
          }
          yield* g;
          return 'asm';
        }
      }
    }
    return 'end';
  }

  private *placeString(s: string): Generator<Wait, 'done' | 'prompt' | 'end', InputFrame> {
    for (const tok of tokenize(s)) {
      if ('code' in tok) {
        this.screen.put(this.cx++, this.cy, tok.code);
        const input: InputFrame = yield { frames: 0 };
        const fast = input?.held.has('a') || input?.held.has('b');
        // BIT_NO_TEXT_DELAY (letterDelay 0) prints instantly; otherwise A/B speed it up to 1 frame
        yield { frames: this.ctx.letterDelay === 0 ? 0 : fast ? 1 : this.ctx.letterDelay };
        continue;
      }
      switch (tok.ctl) {
        case 'next':
          this.cy += 2;
          this.cx = this.lineStartX;
          break;
        case 'line':
          this.cx = this.lineStartX = 1;
          this.cy = 16;
          break;
        case 'para':
          yield* this.waitArrow(false);
          this.screen.fill(1, 13, 18, 4, 0x7f);
          yield { frames: 20 };
          this.cx = this.lineStartX = 1;
          this.cy = 14;
          break;
        case 'cont':
        case '_cont':
          yield* this.waitArrow();
          yield* this.scrollUp();
          this.cx = this.lineStartX = 1;
          this.cy = 16;
          break;
        case 'scroll':
          yield* this.scrollUp();
          this.cx = this.lineStartX = 1;
          this.cy = 16;
          break;
        case 'page':
          yield* this.waitArrow(false);
          this.screen.fill(1, 10, 18, 7, 0x7f);
          yield { frames: 20 };
          this.cx = this.lineStartX = 1;
          this.cy = 11;
          break;
        case 'done':
          return 'done';
        case 'prompt':
          yield* this.waitArrow();
          return 'prompt';
        case 'dexend':
          this.screen.put(this.cx++, this.cy, 0xe8);
          return 'done';
        case 'player':
          yield* this.placeString(this.ctx.playerName);
          break;
        case 'rival':
          yield* this.placeString(this.ctx.rivalName);
          break;
        case 'target':
          yield* this.placeString(this.ctx.target ?? '');
          break;
        case 'user':
          yield* this.placeString(this.ctx.user ?? '');
          break;
        case 'null':
          break;
        default: {
          const fixed = FIXED[tok.ctl];
          if (fixed === undefined) throw new Error(`unknown text control {${tok.ctl}}`);
          for (const code of encodePlain(fixed)) this.screen.put(this.cx++, this.cy, code);
        }
      }
    }
    return 'end';
  }

  /** ▼ at (18,16), wait for A/B, then clear it (ManualTextScroll). */
  *waitArrow(clear = true): Generator<Wait, void, InputFrame> {
    this.screen.put(18, 16, 0xee);
    yield { frames: 3 };
    yield { button: true, arrow: true };
    if (clear) this.screen.put(18, 16, 0x7f);
  }

  /** Two ScrollTextUpOneLine calls (5 frames each). */
  private *scrollUp(): Generator<Wait, void, InputFrame> {
    const s = this.screen;
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 13; y < 16; y++) for (let x = 0; x < 20; x++) s.put(x, y, s.get(x, y + 1));
      s.put(0, 13, 0x7c);
      s.put(19, 13, 0x7c);
      s.fill(1, 16, 18, 1, 0x7f);
      yield { frames: 5 };
    }
  }
}

/** Drives a text coroutine one emulated frame at a time. */
export class CoroutineRunner<R> {
  private wait: Wait | undefined;
  private framesLeft = 0;
  private blink = 0;
  done = false;
  result: R | undefined;

  constructor(
    private readonly gen: Generator<Wait, R, InputFrame>,
    private readonly screen?: TileScreen,
  ) {}

  update(input: InputFrame): void {
    if (this.done) return;
    for (let guard = 0; guard < 10_000; guard++) {
      if (this.wait) {
        if ('frames' in this.wait) {
          if (this.framesLeft > 0) {
            this.framesLeft--;
            if (this.framesLeft > 0) return;
          }
        } else if ('button' in this.wait) {
          if (this.wait.arrow && this.screen) {
            this.blink = (this.blink + 1) % 60;
            this.screen.put(18, 16, this.blink < 30 ? 0xee : 0x7f);
          }
          if (!(input.pressed.has('a') || input.pressed.has('b'))) return;
          if (this.wait.arrow && this.screen) this.screen.put(18, 16, 0xee);
          this.blink = 0;
        } else if ('release' in this.wait) {
          if (input.held.has('a')) return;
        }
      }
      const r = this.gen.next(input);
      if (r.done) {
        this.done = true;
        this.result = r.value;
        return;
      }
      this.wait = r.value;
      if ('frames' in r.value) {
        this.framesLeft = r.value.frames;
        if (this.framesLeft > 0) return;
      } else return;
    }
    throw new Error('text coroutine did not yield');
  }
}

export const LETTER_DELAY: Record<'fast' | 'medium' | 'slow', number> = { fast: 1, medium: 3, slow: 5 };
export type { Button };

/**
 * PrintBCDNumber (home/print_bcd.asm). flags: low 5 bits = byte count,
 * bit 5 = money sign, bit 6 = left align, bit 7 = suppress leading zeros.
 */
export function formatBCD(value: number, flags: number): string {
  const len = flags & 0x1f;
  const money = (flags & 0x20) !== 0;
  const left = (flags & 0x40) !== 0;
  const suppress = (flags & 0x80) !== 0;
  const digits = String(value).padStart(len * 2, '0').slice(-len * 2);
  if (!suppress) return (money ? '¥' : '') + digits;
  const firstNonZero = digits.search(/[1-9]/);
  if (firstNonZero < 0) {
    const pad = left ? '' : ' '.repeat(len * 2 - 1);
    return pad + (money ? '¥' : '') + '0';
  }
  const pad = left ? '' : ' '.repeat(firstNonZero);
  return pad + (money ? '¥' : '') + digits.slice(firstNonZero);
}
