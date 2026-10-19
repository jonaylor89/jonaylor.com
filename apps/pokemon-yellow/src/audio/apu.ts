/**
 * A Game Boy APU (DMG): two pulse channels (the first with frequency sweep), the
 * wave channel, the noise channel, the 512 Hz frame sequencer (length, sweep,
 * envelope), DACs, NR51 panning and NR50 volume, and the output high-pass
 * filter. Registers are written with write(); render() produces stereo samples.
 */

export const CPU_HZ = 4194304;
export const FRAME_CYCLES = 70224;

const DUTY = [
  [0, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 0, 0, 1],
  [1, 0, 0, 0, 0, 1, 1, 1],
  [0, 1, 1, 1, 1, 1, 1, 0],
];
const NOISE_DIVISORS = [8, 16, 32, 48, 64, 80, 96, 112];

class Envelope {
  volume = 0;
  initial = 0;
  up = false;
  period = 0;
  timer = 0;
  load(nrx2: number): void {
    this.initial = nrx2 >> 4;
    this.up = (nrx2 & 8) !== 0;
    this.period = nrx2 & 7;
  }
  trigger(): void {
    this.volume = this.initial;
    this.timer = this.period || 8;
  }
  clock(): void {
    if (!this.period) return;
    if (--this.timer > 0) return;
    this.timer = this.period || 8;
    if (this.up && this.volume < 15) this.volume++;
    else if (!this.up && this.volume > 0) this.volume--;
  }
}

class Pulse {
  enabled = false;
  dac = false;
  duty = 0;
  dutyPos = 0;
  freq = 0;
  timer = 0;
  length = 0;
  lengthEnabled = false;
  env = new Envelope();
  // sweep (channel 1 only)
  sweepPeriod = 0;
  sweepNegate = false;
  sweepShift = 0;
  sweepTimer = 0;
  sweepEnabled = false;
  shadowFreq = 0;

  constructor(readonly hasSweep: boolean) {}

  period(): number {
    return (2048 - this.freq) * 4;
  }
  sweepCalc(): number {
    const delta = this.shadowFreq >> this.sweepShift;
    const f = this.sweepNegate ? this.shadowFreq - delta : this.shadowFreq + delta;
    if (f > 2047) this.enabled = false;
    return f;
  }
  trigger(): void {
    this.enabled = this.dac;
    if (!this.length) this.length = 64;
    this.timer = this.period();
    this.env.trigger();
    if (this.hasSweep) {
      this.shadowFreq = this.freq;
      this.sweepTimer = this.sweepPeriod || 8;
      this.sweepEnabled = this.sweepPeriod > 0 || this.sweepShift > 0;
      if (this.sweepShift) this.sweepCalc();
    }
  }
  clockSweep(): void {
    if (--this.sweepTimer > 0) return;
    this.sweepTimer = this.sweepPeriod || 8;
    if (!this.sweepEnabled || !this.sweepPeriod) return;
    const f = this.sweepCalc();
    if (f <= 2047 && this.sweepShift) {
      this.shadowFreq = f;
      this.freq = f;
      this.sweepCalc();
    }
  }
  clockLength(): void {
    if (this.lengthEnabled && this.length > 0 && --this.length === 0) this.enabled = false;
  }
  step(cycles: number): void {
    this.timer -= cycles;
    while (this.timer <= 0) {
      this.timer += this.period();
      this.dutyPos = (this.dutyPos + 1) & 7;
    }
  }
  sample(): number {
    if (!this.dac) return 0;
    const d = this.enabled ? DUTY[this.duty][this.dutyPos] * this.env.volume : 0;
    return d / 7.5 - 1;
  }
}

class Wave {
  enabled = false;
  dac = false;
  freq = 0;
  timer = 0;
  pos = 0;
  length = 0;
  lengthEnabled = false;
  volumeCode = 0;
  readonly ram = new Uint8Array(16);
  period(): number {
    return (2048 - this.freq) * 2;
  }
  trigger(): void {
    this.enabled = this.dac;
    if (!this.length) this.length = 256;
    this.timer = this.period() + 6;
    this.pos = 0;
  }
  clockLength(): void {
    if (this.lengthEnabled && this.length > 0 && --this.length === 0) this.enabled = false;
  }
  step(cycles: number): void {
    this.timer -= cycles;
    while (this.timer <= 0) {
      this.timer += this.period();
      this.pos = (this.pos + 1) & 31;
    }
  }
  sample(): number {
    if (!this.dac) return 0;
    let s = 0;
    if (this.enabled && this.volumeCode) {
      const byte = this.ram[this.pos >> 1];
      s = (this.pos & 1 ? byte & 0xf : byte >> 4) >> (this.volumeCode - 1);
    }
    return s / 7.5 - 1;
  }
}

class Noise {
  enabled = false;
  dac = false;
  length = 0;
  lengthEnabled = false;
  env = new Envelope();
  shift = 0;
  narrow = false;
  divisor = 0;
  timer = 0;
  lfsr = 0x7fff;
  period(): number {
    return NOISE_DIVISORS[this.divisor] << this.shift;
  }
  trigger(): void {
    this.enabled = this.dac;
    if (!this.length) this.length = 64;
    this.timer = this.period();
    this.env.trigger();
    this.lfsr = 0x7fff;
  }
  clockLength(): void {
    if (this.lengthEnabled && this.length > 0 && --this.length === 0) this.enabled = false;
  }
  step(cycles: number): void {
    this.timer -= cycles;
    while (this.timer <= 0) {
      this.timer += this.period();
      const bit = (this.lfsr ^ (this.lfsr >> 1)) & 1;
      this.lfsr = (this.lfsr >> 1) | (bit << 14);
      if (this.narrow) this.lfsr = (this.lfsr & ~0x40) | (bit << 6);
    }
  }
  sample(): number {
    if (!this.dac) return 0;
    const d = this.enabled && !(this.lfsr & 1) ? this.env.volume : 0;
    return d / 7.5 - 1;
  }
}

export class Apu {
  readonly ch1 = new Pulse(true);
  readonly ch2 = new Pulse(false);
  readonly ch3 = new Wave();
  readonly ch4 = new Noise();
  power = true;
  nr50 = 0x77;
  nr51 = 0xf3;
  private seqTimer = 8192;
  private seqStep = 0;
  private cycleFrac = 0;
  private hpL = 0;
  private hpR = 0;
  private readonly cyclesPerSample: number;
  private readonly hpCharge: number;
  /** Channel mutes for debugging */
  mute = [false, false, false, false];

  constructor(readonly sampleRate: number) {
    this.cyclesPerSample = CPU_HZ / sampleRate;
    this.hpCharge = Math.pow(0.999958, this.cyclesPerSample);
  }

  write(addr: number, v: number): void {
    if (addr >= 0xff30 && addr <= 0xff3f) {
      this.ch3.ram[addr - 0xff30] = v;
      return;
    }
    if (addr === 0xff26) {
      this.power = (v & 0x80) !== 0;
      return;
    }
    if (!this.power) return;
    const p1 = this.ch1;
    const p2 = this.ch2;
    const w = this.ch3;
    const n = this.ch4;
    switch (addr) {
      case 0xff10:
        p1.sweepPeriod = (v >> 4) & 7;
        p1.sweepNegate = (v & 8) !== 0;
        p1.sweepShift = v & 7;
        break;
      case 0xff11:
        p1.duty = v >> 6;
        p1.length = 64 - (v & 0x3f);
        break;
      case 0xff12:
        p1.env.load(v);
        p1.dac = (v & 0xf8) !== 0;
        if (!p1.dac) p1.enabled = false;
        break;
      case 0xff13:
        p1.freq = (p1.freq & 0x700) | v;
        break;
      case 0xff14:
        p1.freq = (p1.freq & 0xff) | ((v & 7) << 8);
        p1.lengthEnabled = (v & 0x40) !== 0;
        if (v & 0x80) p1.trigger();
        break;
      case 0xff16:
        p2.duty = v >> 6;
        p2.length = 64 - (v & 0x3f);
        break;
      case 0xff17:
        p2.env.load(v);
        p2.dac = (v & 0xf8) !== 0;
        if (!p2.dac) p2.enabled = false;
        break;
      case 0xff18:
        p2.freq = (p2.freq & 0x700) | v;
        break;
      case 0xff19:
        p2.freq = (p2.freq & 0xff) | ((v & 7) << 8);
        p2.lengthEnabled = (v & 0x40) !== 0;
        if (v & 0x80) p2.trigger();
        break;
      case 0xff1a:
        w.dac = (v & 0x80) !== 0;
        if (!w.dac) w.enabled = false;
        break;
      case 0xff1b:
        w.length = 256 - v;
        break;
      case 0xff1c:
        w.volumeCode = (v >> 5) & 3;
        break;
      case 0xff1d:
        w.freq = (w.freq & 0x700) | v;
        break;
      case 0xff1e:
        w.freq = (w.freq & 0xff) | ((v & 7) << 8);
        w.lengthEnabled = (v & 0x40) !== 0;
        if (v & 0x80) w.trigger();
        break;
      case 0xff20:
        n.length = 64 - (v & 0x3f);
        break;
      case 0xff21:
        n.env.load(v);
        n.dac = (v & 0xf8) !== 0;
        if (!n.dac) n.enabled = false;
        break;
      case 0xff22:
        n.shift = v >> 4;
        n.narrow = (v & 8) !== 0;
        n.divisor = v & 7;
        break;
      case 0xff23:
        n.lengthEnabled = (v & 0x40) !== 0;
        if (v & 0x80) n.trigger();
        break;
      case 0xff24:
        this.nr50 = v;
        break;
      case 0xff25:
        this.nr51 = v;
        break;
    }
  }

  /** Advance by `cycles` CPU cycles (frame sequencer and channel timers). */
  private advance(cycles: number): void {
    this.seqTimer -= cycles;
    while (this.seqTimer <= 0) {
      this.seqTimer += 8192;
      const s = this.seqStep;
      this.seqStep = (s + 1) & 7;
      if (!(s & 1)) {
        this.ch1.clockLength();
        this.ch2.clockLength();
        this.ch3.clockLength();
        this.ch4.clockLength();
      }
      if (s === 2 || s === 6) this.ch1.clockSweep();
      if (s === 7) {
        this.ch1.env.clock();
        this.ch2.env.clock();
        this.ch4.env.clock();
      }
    }
    this.ch1.step(cycles);
    this.ch2.step(cycles);
    this.ch3.step(cycles);
    this.ch4.step(cycles);
  }

  /** Render n stereo samples into the output arrays starting at offset. */
  render(left: Float32Array, right: Float32Array, offset: number, n: number): void {
    for (let i = 0; i < n; i++) {
      this.cycleFrac += this.cyclesPerSample;
      const cycles = Math.floor(this.cycleFrac);
      this.cycleFrac -= cycles;
      this.advance(cycles);
      let l = 0;
      let r = 0;
      if (this.power) {
        const s = [this.ch1.sample(), this.ch2.sample(), this.ch3.sample(), this.ch4.sample()];
        for (let k = 0; k < 4; k++) {
          if (this.mute[k]) continue;
          if (this.nr51 & (0x10 << k)) l += s[k];
          if (this.nr51 & (1 << k)) r += s[k];
        }
        l *= (((this.nr50 >> 4) & 7) + 1) / 8;
        r *= ((this.nr50 & 7) + 1) / 8;
      }
      // the output capacitor
      const ol = l - this.hpL;
      this.hpL = l - ol * this.hpCharge;
      const or = r - this.hpR;
      this.hpR = r - or * this.hpCharge;
      left[offset + i] = ol * 0.15;
      right[offset + i] = or * 0.15;
    }
  }

  /** Cycles until the next sample boundary is not tracked; frames are applied between samples. */
  get cyclesPerOutputSample(): number {
    return this.cyclesPerSample;
  }
}
