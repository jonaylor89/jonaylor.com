/**
 * Battle animation data (engine/battle/animations.asm, data/moves/animations.asm,
 * data/battle_anims/*): the attack animation command streams, subanimations,
 * frame blocks, base coordinates, the two move animation tilesets, the pic
 * tilemaps (front, slide-down 7x5/7x3) and the small coordinate/palette tables
 * the special effects read.
 */
import type { Rom } from '../Rom';
import { CONSTANTS, labelsAt, sym } from '../symbols';
import { decode2bpp } from './util';
import type { BattleAnimData } from '../../data/schema';

export function extractBattleAnims(rom: Rom): BattleAnimData {
  const C = CONSTANTS.move_animation as Record<string, number>;
  const M = CONSTANTS.move as Record<string, number>;
  const bankOf = (label: string) => Math.floor(sym(label) / 0x4000);
  const ptrIn = (b: number, p: number) => b * 0x4000 + (p - 0x4000);
  const bytes = (label: string, n: number) => [...rom.slice(sym(label), n)];
  const firstSe = C.FIRST_SE_ID + 0x18; // SE_WAVY_SCREEN: below it a byte starts a subanimation

  // AttackAnimationPointers: commands up to -1
  const ab = bankOf('AttackAnimationPointers');
  const attacks: number[][] = [];
  for (let i = 0; i < M.NUM_ATTACK_ANIMS; i++) {
    let p = ptrIn(ab, rom.u16(sym('AttackAnimationPointers') + i * 2));
    const out: number[] = [];
    for (;;) {
      const b = rom.u8(p);
      if (b === 0xff) break;
      const n = b >= firstSe ? 2 : 3;
      for (let k = 0; k < n; k++) out.push(rom.u8(p + k));
      p += n;
    }
    attacks.push(out);
  }

  // SubanimationPointers: a header (type << 5 | count), then count (frame block, base coord, mode)
  const sb = bankOf('SubanimationPointers');
  const subanims: { type: number; entries: [number, number, number][] }[] = [];
  for (let i = 0; i < C.NUM_SUBANIMS; i++) {
    const p = ptrIn(sb, rom.u16(sym('SubanimationPointers') + i * 2));
    const head = rom.u8(p);
    const entries: [number, number, number][] = [];
    for (let k = 0; k < (head & 0x1f); k++) entries.push([rom.u8(p + 1 + k * 3), rom.u8(p + 2 + k * 3), rom.u8(p + 3 + k * 3)]);
    subanims.push({ type: head >> 5, entries });
  }

  // FrameBlockPointers: a count, then (y, x, tile, attributes) per tile
  const fb = bankOf('FrameBlockPointers');
  const frameBlocks: [number, number, number, number][][] = [];
  for (let i = 0; i < C.NUM_FRAMEBLOCKS; i++) {
    const p = ptrIn(fb, rom.u16(sym('FrameBlockPointers') + i * 2));
    const n = rom.u8(p);
    const tiles: [number, number, number, number][] = [];
    for (let k = 0; k < n; k++) tiles.push([rom.u8(p + 1 + k * 4), rom.u8(p + 2 + k * 4), rom.u8(p + 3 + k * 4), rom.u8(p + 4 + k * 4)]);
    frameBlocks.push(tiles);
  }

  const baseCoords: [number, number][] = [];
  for (let i = 0; i < C.NUM_BASECOORDS; i++) baseCoords.push([rom.u8(sym('FrameBlockBaseCoords') + i * 2), rom.u8(sym('FrameBlockBaseCoords') + i * 2 + 1)]);

  // MoveAnimationTilesPointers: (tile count, pointer) per tileset
  const tilesets: number[][] = [0, 1, 2].map((i) => {
    const p = sym('MoveAnimationTilesPointers') + i * 4;
    const at = ptrIn(bankOf('MoveAnimationTilesPointers'), rom.u16(p + 1));
    return decode2bpp(rom.slice(at, rom.u8(p) * 16));
  });

  const untilFF = (label: string) => {
    const out: number[] = [];
    for (let p = sym(label); rom.u8(p) !== 0xff; p++) out.push(rom.u8(p));
    return out;
  };
  return {
    attacks,
    subanims,
    frameBlocks,
    baseCoords,
    tilesets,
    tilemaps: {
      mon: bytes('MonTiles', 49),
      slideDown7x5: bytes('SlideDownMonTiles_7x5', 35),
      slideDown7x3: bytes('SlideDownMonTiles_7x3', 21),
    },
    // the SGB variants (this port runs as on a Super Game Boy)
    flashScreenLong: (() => {
      const out: number[] = [];
      for (let p = sym('FlashScreenLongSGB'); rom.u8(p) !== 1; p++) out.push(rom.u8(p));
      return out;
    })(),
    spiralBalls: untilFF('SpiralBallAnimationCoordinates'),
    wavyScreen: bytes('WavyScreenLineOffsets', 32),
    fallingDeltaXs: bytes('FallingObjects_DeltaXs', 9),
    fallingXs: bytes('FallingObjects_InitialXCoords', 20),
    fallingMovement: bytes('FallingObjects_InitialMovementData', 20),
    minimized: bytes('MinimizedMonSprite', 5),
    ballMoveDistances1: untilFF('BallMoveDistances1'),
    ballMoveDistances2: untilFF('BallMoveDistances2'),
    specialEffectsById: (() => {
      // AnimationIdSpecialEffects: animation id → routine label
      const b = bankOf('AnimationIdSpecialEffects');
      const out: [number, string][] = [];
      for (let p = sym('AnimationIdSpecialEffects'); rom.u8(p) !== 0xff; p += 3) {
        const name = labelsAt(ptrIn(b, rom.u16(p + 1))).find((l) => !l.includes('.'));
        if (!name) throw new Error(`no label for animation special effect ${rom.u8(p)}`);
        out.push([rom.u8(p), name]);
      }
      return out;
    })(),
  };
}
