/** Explicit mobile fill-rate/view-margin budget. Props are already merged
 * into the map mesh, not one draw call per tree/grass tuft.
 */
export const RENDER_BUDGET = { drawCalls: 80, triangles: 180000, geometries: 100, textures: 100 };
export function renderQuality(coarse: boolean, devicePixelRatio: number) {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return { pixelRatio: Math.min(dpr, coarse ? 1.5 : 2), margin: coarse ? 4 : 8, mobile: coarse };
}
export class FrameProfiler {
  private readonly intervals: number[] = [];
  private readonly cpu: number[] = [];
  private at = 0;
  reset(): void { this.intervals.length = this.cpu.length = 0; this.at = 0; }
  add(intervalMs: number, cpuMs: number): void {
    if (!Number.isFinite(intervalMs) || intervalMs <= 0 || !Number.isFinite(cpuMs)) return;
    const at = this.at++ % 300;
    this.intervals[at] = intervalMs; this.cpu[at] = Math.max(0, cpuMs);
  }
  snapshot() {
    const sorted = [...this.intervals].sort((a, b) => a - b), cpu = [...this.cpu].sort((a, b) => a - b);
    const percentile = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(a.length * p))] ?? 0;
    const average = this.intervals.reduce((a, b) => a + b, 0) / Math.max(1, sorted.length);
    return { samples: sorted.length, fps: average ? 1000 / average : 0, p50Ms: percentile(sorted, 0.5), p95Ms: percentile(sorted, 0.95), cpuP95Ms: percentile(cpu, 0.95) };
  }
}
