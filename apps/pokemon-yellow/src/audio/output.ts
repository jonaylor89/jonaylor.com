/**
 * The browser end of the sound: an AudioContext running the APU worklet. Each
 * game frame's register writes are posted to it; the context starts on the
 * first user gesture (autoplay rules), and nothing is sent before then.
 */
import workletUrl from './apuWorklet.ts?worker&url';

export class AudioOutput {
  private ctx?: AudioContext;
  private node?: AudioWorkletNode;
  private gain?: GainNode;
  private ready = false;
  private volume = 1;
  private suspended = false;

  constructor() {
    const start = () => {
      void this.start();
      window.removeEventListener('keydown', start);
      window.removeEventListener('pointerdown', start);
    };
    window.addEventListener('keydown', start);
    window.addEventListener('pointerdown', start);
  }

  private async start(): Promise<void> {
    if (this.ctx) return;
    try {
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      await this.ctx.audioWorklet.addModule(workletUrl);
      this.node = new AudioWorkletNode(this.ctx, 'gb-apu', { numberOfInputs: 0, outputChannelCount: [2] });
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.node.connect(this.gain).connect(this.ctx.destination);
      if (this.suspended) await this.ctx.suspend();
      else await this.ctx.resume();
      this.ready = true;
      // bring the APU up to date with the registers written so far
      if (this.pendingState) this.node.port.postMessage({ type: 'frame', writes: this.pendingState });
      this.pendingState = undefined;
    } catch (err) {
      console.warn('audio unavailable', err);
    }
  }

  /** The latest value of each register, replayed when the context starts */
  private pendingState?: [number, number][];
  private regState = new Map<number, number>();

  frame(writes: [number, number][], timed?: [number, number, number][]): void {
    if (!this.ready) {
      for (const [a, v] of writes) this.regState.set(a, v);
      // trigger bits are left out: the replay restarts nothing mid-note
      this.pendingState = [...this.regState].map(([a, v]) => [a, a === 0xff14 || a === 0xff19 || a === 0xff1e || a === 0xff23 ? v & 0x7f : v]);
      return;
    }
    if (!writes.length && !timed) {
      this.node!.port.postMessage({ type: 'frame', writes });
      return;
    }
    this.node!.port.postMessage({ type: 'frame', writes, timed });
  }

  setVolume(v: number): void {
    this.volume = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 1;
    if (this.gain) this.gain.gain.value = this.volume;
  }

  /** Pause output while the tab is hidden (the game loop stops then too). */
  suspend(hidden: boolean): void {
    this.suspended = hidden;
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend();
    else void this.ctx.resume();
  }

  setMutes(channels: boolean[]): void {
    this.node?.port.postMessage({ type: 'mute', channels });
  }
}
