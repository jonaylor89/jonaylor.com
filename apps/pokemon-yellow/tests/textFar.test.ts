import { describe, expect, it, vi } from 'vitest';
import { Rom } from '../src/rom/Rom';
import { decodeTextCommands, opsToPlain, walkTextOps, withoutTextAsm } from '../src/rom/text';
import { TextPrinter, CoroutineRunner, type TextContext } from '../src/ui/TextPrinter';
import { TileScreen } from '../src/ui/TileScreen';
import type { GameBundle, TextOp } from '../src/data/schema';

const ctx: TextContext = { playerName: 'RED', rivalName: 'BLUE', ram: () => '', letterDelay: 0 };
function print(ops: TextOp[], context: Partial<TextContext> = {}) {
  const screen = new TileScreen(null, {} as GameBundle);
  const runner = new CoroutineRunner(new TextPrinter(screen, { ...ctx, ...context }).run(ops), screen);
  for (let i = 0; i < 500 && !runner.done; i++) {
    const a = i % 4 === 0;
    runner.update({ held: new Set(a ? ['a'] : []), pressed: new Set(a ? ['a'] : []) });
  }
  expect(runner.done).toBe(true);
  return screen;
}

describe('TextCommand_FAR return scopes', () => {
  it('extracts FAR as a nested call, not a flattened whole-text terminator', () => {
    const bytes = new Uint8Array(0x100000).fill(0x50);
    bytes.set([0x17, 0x00, 0x40, 0x02, 0x0e, 0x50], 0x100);
    bytes.set([0x00, 0x80, 0x58], 0x8000); // far text A<PROMPT>
    const ops = decodeTextCommands(new Rom(bytes), 0x100);
    expect(ops).toEqual([{ t: 'far', ops: [{ t: 'text', v: 'A{prompt}' }] }, { t: 'sound', id: 0x0e }]);
    expect(opsToPlain(ops)).toBe('A{prompt}');
  });

  it('runs the script after a nested prompt (Rocket grunt’s Lift Key regression)', () => {
    let ran = false;
    print([{ t: 'far', ops: [{ t: 'text', v: 'NO!{prompt}' }] }, { t: 'promptbutton' }, { t: 'asm', label: 'drop-key' }], {
      *asm(label) { expect(label).toBe('drop-key'); ran = true; yield { frames: 1 }; },
    });
    expect(ran).toBe(true);
  });

  it('returns through multiple FAR levels but still stops at the outer DONE', () => {
    const sounds: number[] = [];
    const screen = print([
      { t: 'far', ops: [{ t: 'far', ops: [{ t: 'text', v: 'A{done}' }] }, { t: 'sound', id: 1 }] },
      { t: 'text', v: 'B{done}' }, { t: 'sound', id: 2 },
    ], { sound: (id) => sounds.push(id) });
    expect(sounds).toEqual([1]);
    expect(screen.get(1, 14)).toBe(0x80);
    expect(screen.get(2, 14)).toBe(0x81);
  });

  it('returns to the caller after nested ASM and reports missing nested handlers', () => {
    const sounds: number[] = [], missing: string[] = [];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      print([{ t: 'far', ops: [{ t: 'asm', label: 'missing' }] }, { t: 'sound', id: 7 }], {
        missingAsm: (label) => missing.push(label), sound: (id) => sounds.push(id),
      });
      expect(missing).toEqual(['missing']); expect(sounds).toEqual([7]);
    } finally { warn.mockRestore(); }
  });

  it('inspection and intentional ASM stripping recurse without flattening scopes', () => {
    const ops: TextOp[] = [{ t: 'far', ops: [{ t: 'text', v: 'A{done}' }, { t: 'asm', label: 'x' }] }, { t: 'asm', label: 'y' }];
    expect([...walkTextOps(ops)].filter((o) => o.t === 'asm')).toHaveLength(2);
    expect(withoutTextAsm(ops)).toEqual([{ t: 'far', ops: [{ t: 'text', v: 'A{done}' }] }]);
    expect(ops).toHaveLength(2);
  });
});
