/**
 * Talking to Pikachu: the emotion scripts (data/pikachu/pikachu_emotions.asm),
 * the mood/happiness lookup of GetPikaPicAnimationScriptIndex, and the
 * Pikachu picture animations (engine/pikachu/pikachu_pic_animation.asm with
 * data/pikachu/pikachu_pic_*.asm): scripts, BG frame sets, tilemaps and the
 * graphics they load into VRAM.
 */
import type { Rom } from '../Rom';
import type { GameBundle } from '../../data/schema';
import type { TextCollector } from './texts';
import { labelsAt, sym, symBank, toOffset } from '../symbols';
import { labelFor } from '../text';
import { uncompressPic } from './pics';
import { assert } from './util';

type Out = GameBundle['pikachuEmotions'];

/** Parameter bytes of each PIKAEMOTION_* command. */
const EMOTION_ARGS = [0, 2, 1, 1, 2, 1, 1, 1, 0, 0, 0];
/** Parameter bytes of each pikapic_* command. */
const PIKAPIC_ARGS = [0, 1, 1, 5, 0, 0, 1, 0, 0, 2, 2, 1, 0, 0, 0];
const PIC_TILES = 7 * 7;

const b64 = (bytes: number[] | Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

/** Count consecutive table entries labelled `<name>_id`. */
function countIds(rom: Rom, table: number, stride: number): number {
  let n = 0;
  while (labelsAt(table + n * stride).some((l) => l.endsWith('_id'))) n++;
  return n;
}

/** A Pikachu movement script (ApplyPikachuMovementData_), using the database for parameter counts. */
function readMovement(rom: Rom, at: number, db: number[]): number[] {
  const out: number[] = [];
  let p = at;
  for (;;) {
    const cmd = rom.u8(p++);
    out.push(cmd);
    if (cmd === 0x3f) return out;
    assert(cmd < 0x3f, `Pikachu movement command $${cmd.toString(16)} at ${at}`);
    if (db[cmd * 4 + 1] === 0x80) out.push(rom.u8(p++));
    if (db[cmd * 4 + 3] === 0x80) out.push(rom.u8(p++));
  }
}

export function extractPikachuEmotions(rom: Rom, texts: TextCollector, movementDb: number[]): Out {
  const bank = symBank('PikachuEmotionTable');
  // ---- emotion scripts
  const table = sym('PikachuEmotionTable');
  const count = countIds(rom, table, 2);
  assert(count >= 34, `PikachuEmotionTable has ${count} entries`);
  const emotions: Out['emotions'] = [];
  for (let i = 0; i < count; i++) {
    const ops: Out['emotions'][number] = [];
    for (let p = toOffset(bank, rom.u16(table + i * 2)); ; ) {
      const op = rom.u8(p++);
      if (op === 0xff) break;
      assert(op < EMOTION_ARGS.length, `Pikachu emotion ${i} command ${op}`);
      if (op === 1) {
        const t = toOffset(bank, rom.u16(p));
        const label = labelFor(t);
        texts.add(label, t);
        ops.push({ op, text: label });
      } else if (op === 4) ops.push({ op, movement: readMovement(rom, toOffset(bank, rom.u16(p)), movementDb) });
      else ops.push({ op, arg: EMOTION_ARGS[op] ? rom.u8(p) : 0 });
      p += EMOTION_ARGS[op];
    }
    emotions.push(ops);
  }

  // ---- GetPikaPicAnimationScriptIndex tables
  const moods: [number, number][] = [];
  for (let p = sym('PikachuMoodLookupTable'); ; p += 2) {
    moods.push([rom.u8(p), rom.u8(p + 1)]);
    if (rom.u8(p) === 0xff) break;
  }
  const happiness: number[][] = [];
  for (let p = sym('PikaPicAnimationScriptPointerLookupTable'); ; p += 6) {
    happiness.push([...rom.slice(p, 6)]);
    if (rom.u8(p) === 0xff) break;
  }

  // ---- pikapic scripts: decode every reachable command; jumps become command indices
  const scriptsTable = sym('PikaPicAnimPointers');
  const nScripts = countIds(rom, scriptsTable, 2);
  const scripts: Out['pikapic']['scripts'] = [];
  for (let i = 0; i < nScripts; i++) {
    const start = toOffset(bank, rom.u16(scriptsTable + i * 2));
    const at = new Map<number, number>();
    const cmds: { op: number; args: number[]; addr: number }[] = [];
    const todo = [start];
    while (todo.length) {
      let p = todo.pop()!;
      while (!at.has(p)) {
        const op = rom.u8(p);
        assert(op < PIKAPIC_ARGS.length, `pikapic script ${i} command ${op}`);
        const args = [...rom.slice(p + 1, PIKAPIC_ARGS[op])];
        at.set(p, -1);
        cmds.push({ op, args, addr: p });
        p += 1 + PIKAPIC_ARGS[op];
        if (op === 9) {
          todo.push(toOffset(bank, args[0] | (args[1] << 8)));
          break;
        }
        if (op === 0x0e) break;
      }
    }
    cmds.sort((a, b) => a.addr - b.addr);
    cmds.forEach((cmd, k) => at.set(cmd.addr, k));
    scripts.push({
      entry: at.get(start)!,
      cmds: cmds.map((cmd) =>
        cmd.op === 9
          ? { op: 9, args: [at.get(toOffset(bank, cmd.args[0] | (cmd.args[1] << 8)))!], next: -1 }
          : { op: cmd.op, args: cmd.args, next: at.get(cmd.addr + 1 + PIKAPIC_ARGS[cmd.op]) ?? -1 },
      ),
    });
  }

  // ---- BG frame sets: (tilemap, duration) until $e0
  const framesTable = sym('PikaPicAnimBGFramesPointers');
  const nFrames = countIds(rom, framesTable, 2);
  const frames: number[][] = [];
  for (let i = 0; i < nFrames; i++) {
    const list: number[] = [];
    for (let p = toOffset(bank, rom.u16(framesTable + i * 2)); rom.u8(p) !== 0xe0; p += 2) list.push(rom.u8(p), rom.u8(p + 1));
    frames.push(list);
  }

  // ---- tilemaps: rows, cols, tile ids ($ff = leave the tile)
  const tmTable = sym('PikaPicTilemapPointers');
  const nTm = countIds(rom, tmTable, 2);
  const tilemaps: { rows: number; cols: number; tiles: number[] }[] = [];
  for (let i = 0; i < nTm; i++) {
    const p = toOffset(bank, rom.u16(tmTable + i * 2));
    const rows = rom.u8(p);
    const cols = rom.u8(p + 1);
    tilemaps.push({ rows, cols, tiles: [...rom.slice(p + 2, rows * cols)] });
  }

  // ---- graphics: raw 2bpp tiles, or a compressed pic merged into a 7x7 tile buffer (column-major)
  const gfxTable = sym('PikaPicAnimGFXHeaders');
  // entry 0 (1 tile at $39:NULL) is written without a label, so count from entry 1
  const nGfx = 1 + countIds(rom, gfxTable + 4, 4);
  const gfx: { size: number; data: string }[] = [];
  for (let i = 0; i < nGfx; i++) {
    const p = gfxTable + i * 4;
    const size = rom.u8(p);
    const ptr = toOffset(rom.u8(p + 1), rom.u16(p + 2));
    if (size !== 0xff) {
      gfx.push({ size, data: b64(rom.slice(ptr, size * 16)) });
      continue;
    }
    const pic = uncompressPic(rom, ptr);
    const w = pic.width;
    const out = new Uint8Array(PIC_TILES * 16);
    for (let t = 0; t < w * w; t++) {
      const rowMajor = (t % w) * w + Math.floor(t / w);
      out.set(pic.data.subarray(rowMajor * 16, rowMajor * 16 + 16), t * 16);
    }
    gfx.push({ size: 0xff, data: b64(out) });
  }

  const pals: [number, number][] = [];
  for (let p = sym('PikaPicAnimThunderboltPals'); rom.u8(p) !== 0xff; p += 2) pals.push([rom.u8(p), rom.u8(p + 1)]);

  // PikachuCriesPointerTable: dba to (dw sample byte count, 1-bit samples, MSB first)
  const criesTable = sym('PikachuCriesPointerTable');
  const nCries = countIds(rom, criesTable, 3);
  const cries: Out['cries'] = [];
  for (let i = 0; i < nCries; i++) {
    const p = criesTable + i * 3;
    const at = toOffset(rom.u8(p), rom.u16(p + 1));
    const length = rom.u16(at);
    cries.push({ length, data: b64(rom.slice(at + 2, length)) });
  }

  return { emotions, moods, happiness, pikapic: { scripts, frames, tilemaps, gfx, thunderboltPals: pals }, cries };
}
