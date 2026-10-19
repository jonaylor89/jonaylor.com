/**
 * Animated-object tables (engine/gfx/animated_objects.asm) as used by the
 * Surfing Pikachu minigame and the Yellow intro: spawn data, frameset scripts
 * (pointer table, 2-byte frames, single-byte $FE/$FF terminators) and OAM sets
 * (dbw tile offset + pointer to a count and 4-byte sprites). Tables end where
 * their first pointee begins.
 */
import type { Rom } from '../Rom';
import { sym } from '../symbols';
import type { AnimObjectData } from '../../gb/animatedObjects';

export function extractAnimTables(rom: Rom, labels: { spawn: string; spawnEnd: string; frames: string; oam: string }): AnimObjectData {
  const bank = Math.floor(sym(labels.frames) / 0x4000);
  const ptr = (p: number) => bank * 0x4000 + (p - 0x4000);
  const spawn: [number, number, number][] = [];
  for (let p = sym(labels.spawn); p < sym(labels.spawnEnd); p += 3) spawn.push([rom.u8(p), rom.u8(p + 1), rom.u8(p + 2)]);
  const framePtrs: number[] = [];
  for (let p = sym(labels.frames); !framePtrs.length || p < Math.min(...framePtrs); p += 2) framePtrs.push(ptr(rom.u16(p)));
  const frames = framePtrs.map((start) => {
    const out: number[] = [];
    for (let p = start; ; p += 2) {
      const a = rom.u8(p);
      out.push(a);
      if (a >= 0xfe) break;
      out.push(rom.u8(p + 1));
    }
    return out;
  });
  const sets: { tile: number; at: number }[] = [];
  for (let p = sym(labels.oam); !sets.length || p < Math.min(...sets.map((o) => o.at)); p += 3) sets.push({ tile: rom.u8(p), at: ptr(rom.u16(p + 1)) });
  const oam = sets.map(({ tile, at }) => {
    const n = rom.u8(at);
    const sprites: [number, number, number, number][] = [];
    for (let i = 0; i < n; i++) sprites.push([rom.u8(at + 1 + i * 4), rom.u8(at + 2 + i * 4), rom.u8(at + 3 + i * 4), rom.u8(at + 4 + i * 4)]);
    return { tile, sprites };
  });
  return { spawn, frames, oam };
}
