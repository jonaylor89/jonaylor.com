/**
 * The AudioWorklet side: an Apu fed with the sound engine's register writes.
 * Each game frame's writes land one frame (70224 cycles) after the previous
 * frame's, a couple of frames behind real time; timed writes (the Pikachu PCM)
 * carry their own cycle offsets. If the game falls behind or runs ahead the
 * schedule is re-anchored.
 */
import { Apu, FRAME_CYCLES } from './apu';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}

const LATENCY_FRAMES = 3;
const MAX_AHEAD_FRAMES = 10;

interface Pending {
  at: number;
  addr: number;
  value: number;
}

class ApuProcessor extends AudioWorkletProcessor {
  private readonly apu = new Apu(sampleRate);
  private cycle = 0;
  private nextFrameAt = -1;
  private pending: Pending[] = [];

  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent) => {
      const m = ev.data as { type: 'frame'; writes: [number, number][]; timed?: [number, number, number][] } | { type: 'mute'; channels: boolean[] };
      if ((m as { type: string }).type === 'stats') {
        const a = this.apu;
        this.port.postMessage({ cycle: this.cycle, pending: this.pending.length, nextFrameAt: this.nextFrameAt, nr50: a.nr50, nr51: a.nr51, power: a.power, ch: [a.ch1, a.ch2, a.ch3, a.ch4].map((c) => [c.enabled, c.dac]) });
        return;
      }
      if (m.type === 'mute') {
        this.apu.mute = m.channels;
        return;
      }
      if (this.nextFrameAt < this.cycle || this.nextFrameAt > this.cycle + MAX_AHEAD_FRAMES * FRAME_CYCLES)
        this.nextFrameAt = this.cycle + LATENCY_FRAMES * FRAME_CYCLES;
      const at = this.nextFrameAt;
      this.nextFrameAt += FRAME_CYCLES;
      for (const [addr, value] of m.writes) this.pending.push({ at, addr, value });
      if (m.timed) for (const [off, addr, value] of m.timed) this.pending.push({ at: at + off, addr, value });
      this.pending.sort((a, b) => a.at - b.at);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] ?? out[0];
    const n = left.length;
    const cps = this.apu.cyclesPerOutputSample;
    let i = 0;
    while (i < n) {
      while (this.pending.length && this.pending[0].at <= this.cycle) {
        const w = this.pending.shift()!;
        this.apu.write(w.addr, w.value);
      }
      // render up to the next pending write
      let run = n - i;
      if (this.pending.length) run = Math.max(1, Math.min(run, Math.ceil((this.pending[0].at - this.cycle) / cps)));
      this.apu.render(left, right, i, run);
      this.cycle += run * cps;
      i += run;
    }
    return true;
  }
}

registerProcessor('gb-apu', ApuProcessor);
