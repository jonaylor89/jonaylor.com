/**
 * The animated-object engine (engine/gfx/animated_objects.asm) used by the
 * Surfing Pikachu minigame and the Yellow intro: ten 16-byte structs, each with
 * a callback, a frameset script (OAM-set index + duration/flip per frame,
 * ending in $FC-$FF commands) and an OAM-set table, written into shadow OAM
 * every frame by RunObjectAnimations.
 */
import type { OamEntry } from './ppu';

/** Struct offsets (constants/sprite_anim_constants.asm) */
export const ANIM_OBJ_INDEX = 0;
export const ANIM_OBJ_FRAME_SET = 1;
export const ANIM_OBJ_CALLBACK = 2;
export const ANIM_OBJ_TILE = 3;
export const ANIM_OBJ_X_COORD = 4;
export const ANIM_OBJ_Y_COORD = 5;
export const ANIM_OBJ_X_OFFSET = 6;
export const ANIM_OBJ_Y_OFFSET = 7;
export const ANIM_OBJ_DURATION = 8;
export const ANIM_OBJ_DURATION_OFFSET = 9;
export const ANIM_OBJ_FRAME_IDX = 10;
export const ANIM_OBJ_FIELD_B = 11;
export const ANIM_OBJ_FIELD_C = 12;
export const ANIM_OBJ_FIELD_D = 13;
export const ANIM_OBJ_FIELD_E = 14;
export const ANIM_OBJ_FIELD_F = 15;

const NUM_OBJECTS = 10;

export interface AnimObjectData {
  /** Spawn data per object type: [frameset, callback, tile offset] */
  spawn: [number, number, number][];
  /** Frameset scripts as raw bytes from the frameset's pointer (2 bytes per frame, single-byte commands) */
  frames: number[][];
  /** OAM sets: a tile offset and [y, x, tile, attributes] per sprite */
  oam: { tile: number; sprites: [number, number, number, number][] }[];
}

export type AnimCallback = (obj: Uint8Array) => void;

export class AnimatedObjects {
  readonly structs = Array.from({ length: NUM_OBJECTS }, () => new Uint8Array(16));
  numLoaded = 0;
  /** wCurrentAnimatedObjectOAMBufferOffset, in bytes (4 per sprite) */
  oamOffset = 0;
  globalX = 0;
  globalY = 0;
  /** wYellowIntroCurrentScene == 7: keep the previous OAM attributes */
  keepAttributes = false;
  private curAttrs = 0;

  constructor(
    private readonly data: AnimObjectData,
    private readonly callbacks: AnimCallback[],
    private readonly shadowOam: OamEntry[],
  ) {}

  /** ClearObjectAnimationBuffers */
  clear(): void {
    for (const s of this.structs) s.fill(0);
    this.numLoaded = 0;
    this.oamOffset = 0;
    this.globalX = 0;
    this.globalY = 0;
  }

  /** SpawnAnimatedObject: returns the struct, or undefined when all ten are in use (carry). */
  spawn(type: number, x: number, y: number): Uint8Array | undefined {
    const s = this.structs.find((st) => st[ANIM_OBJ_INDEX] === 0);
    if (!s) return undefined;
    this.numLoaded = (this.numLoaded + 1) & 0xff;
    const [frameset, callback] = this.data.spawn[type];
    s.fill(0);
    s[ANIM_OBJ_INDEX] = this.numLoaded;
    s[ANIM_OBJ_FRAME_SET] = frameset;
    s[ANIM_OBJ_CALLBACK] = callback;
    s[ANIM_OBJ_X_COORD] = x;
    s[ANIM_OBJ_Y_COORD] = y;
    s[ANIM_OBJ_FRAME_IDX] = 0xff;
    return s;
  }

  /** SetCurrentAnimatedObjectCallbackAndResetFrameStateRegisters (it sets the frameset) */
  static setFrameset(s: Uint8Array, frameset: number): void {
    s[ANIM_OBJ_FRAME_SET] = frameset;
    s[ANIM_OBJ_DURATION] = 0;
    s[ANIM_OBJ_DURATION_OFFSET] = 0;
    s[ANIM_OBJ_FRAME_IDX] = 0xff;
  }

  /** RunObjectAnimations */
  run(): void {
    for (const s of this.structs) {
      if (!s[ANIM_OBJ_INDEX]) continue;
      this.callbacks[s[ANIM_OBJ_CALLBACK]]?.(s);
      if (this.updateFrame(s)) return; // OAM full
    }
    for (let i = this.oamOffset >> 2; i < this.shadowOam.length; i++) {
      const o = this.shadowOam[i];
      o.y = o.x = o.tile = o.attr = 0;
    }
  }

  private frameEntry(s: Uint8Array): [number, number] {
    const f = this.data.frames[s[ANIM_OBJ_FRAME_SET]] ?? [];
    const p = s[ANIM_OBJ_FRAME_IDX] * 2;
    return [f[p] ?? 0xff, f[p + 1] ?? 0];
  }

  /** UpdateDurationTimerAndFrameStateForCurrentAnimatedObject: the OAM-set index (or a $FC/$FD command). */
  private nextFrame(s: Uint8Array): number {
    for (;;) {
      if (s[ANIM_OBJ_DURATION]) {
        s[ANIM_OBJ_DURATION]--;
        const [a, b] = this.frameEntry(s);
        this.curAttrs = (b & 0xc0) >> 1;
        return a;
      }
      s[ANIM_OBJ_FRAME_IDX] = (s[ANIM_OBJ_FRAME_IDX] + 1) & 0xff;
      const [a, b] = this.frameEntry(s);
      if (a === 0xfe) {
        // dorestart
        s[ANIM_OBJ_DURATION] = 0;
        s[ANIM_OBJ_FRAME_IDX] = 0xff;
        continue;
      }
      if (a === 0xff) {
        // endanim: hold the last frame
        s[ANIM_OBJ_DURATION] = 0;
        s[ANIM_OBJ_FRAME_IDX] = (s[ANIM_OBJ_FRAME_IDX] - 2) & 0xff;
        continue;
      }
      s[ANIM_OBJ_DURATION] = ((b & 0x3f) + s[ANIM_OBJ_DURATION_OFFSET]) & 0xff;
      this.curAttrs = (b & 0xc0) >> 1;
      return a;
    }
  }

  /** UpdateCurrentAnimatedObjectFrame: true when shadow OAM filled up (carry). */
  private updateFrame(s: Uint8Array): boolean {
    this.curAttrs = 0;
    const a = this.nextFrame(s);
    if (a === 0xfd) return false;
    if (a === 0xfc) {
      s[ANIM_OBJ_INDEX] = 0; // MaskCurrentAnimatedObjectStruct
      return false;
    }
    const set = this.data.oam[a];
    if (!set) return false;
    const vtile = (s[ANIM_OBJ_TILE] + set.tile) & 0xff;
    for (const [ty, tx, tile, attr] of set.sprites) {
      const flipY = this.curAttrs & 0x40;
      const flipX = this.curAttrs & 0x20;
      const oy = flipY ? (-(ty + 8)) & 0xff : ty;
      const ox = flipX ? (-(tx + 8)) & 0xff : tx;
      const o = this.shadowOam[this.oamOffset >> 2];
      o.y = (s[ANIM_OBJ_Y_COORD] + s[ANIM_OBJ_Y_OFFSET] + this.globalY + oy) & 0xff;
      o.x = (s[ANIM_OBJ_X_COORD] + s[ANIM_OBJ_X_OFFSET] + this.globalX + ox) & 0xff;
      o.tile = (vtile + tile) & 0xff;
      // SetCurrentAnimatedObjectOAMAttributes (the CGB palette bits don't matter here)
      if (!this.keepAttributes) o.attr = ((attr ^ this.curAttrs) & 0xe0) | (attr & 0x10);
      this.oamOffset += 4;
      if (this.oamOffset >= this.shadowOam.length * 4) return true;
    }
    return false;
  }
}
