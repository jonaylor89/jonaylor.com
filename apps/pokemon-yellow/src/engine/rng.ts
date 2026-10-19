/**
 * Port of Random_ (engine/math/random.asm):
 *   hRandomAdd += rDIV + carry;  hRandomSub -= rDIV + carry
 * rDIV is the Game Boy's free-running divider (16384 Hz). Its value at the
 * moment of each call depends on exact CPU cycle timing, which we cannot
 * reproduce. We emulate it deterministically: DIV advances by the true
 * per-frame amount (~274.3) plus a per-call offset drawn from a seeded
 * xorshift generator. The whole state lives in GameState.rng, so saves and
 * replays are fully deterministic. (See DEVIATIONS.md.)
 */
export interface RngState {
  /** xorshift32 state */
  seed: number;
  add: number;
  sub: number;
  /** Carry flag carried between Random_ calls (adc/sbc chain). */
  carry?: number;
  /** Emulated DIV accumulator (fractional, ×1000). */
  div?: number;
}

const DIV_PER_FRAME_MILLI = Math.round((16384 / 59.7275) * 1000);

function xorshift(s: number): number {
  s ^= s << 13;
  s >>>= 0;
  s ^= s >>> 17;
  s ^= s << 5;
  return s >>> 0;
}

export class GbRandom {
  constructor(readonly state: RngState) {
    if (!state.seed) state.seed = 0x9e3779b9;
    state.carry ??= 0;
    state.div ??= 0;
  }

  /** Advance the emulated divider by n frames. */
  frames(n: number): void {
    this.state.div = ((this.state.div ?? 0) + DIV_PER_FRAME_MILLI * n) % (256 * 1000);
  }

  private readDiv(): number {
    this.state.seed = xorshift(this.state.seed);
    // Calls within a frame happen at varying cycle offsets: up to ~1/2 frame of DIV ticks.
    const jitter = this.state.seed % 137;
    return (Math.floor((this.state.div ?? 0) / 1000) + jitter) & 0xff;
  }

  /** Random: returns hRandomAdd after updating both bytes. */
  random(): number {
    const s = this.state;
    const d1 = this.readDiv();
    let add = s.add + d1 + (s.carry ?? 0);
    const c1 = add > 0xff ? 1 : 0;
    add &= 0xff;
    const d2 = this.readDiv();
    let sub = s.sub - d2 - c1;
    const c2 = sub < 0 ? 1 : 0;
    sub &= 0xff;
    s.add = add;
    s.sub = sub;
    s.carry = c2;
    return add;
  }

  get hRandomAdd(): number {
    return this.state.add;
  }
  get hRandomSub(): number {
    return this.state.sub;
  }
  /** The CPU carry left by Random's final `sbc` (some callers `adc` with it). */
  get carry(): number {
    return this.state.carry ?? 0;
  }
}
