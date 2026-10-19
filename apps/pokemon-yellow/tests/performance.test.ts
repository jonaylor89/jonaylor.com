import { describe, expect, it } from 'vitest';
import { FrameProfiler, renderQuality, RENDER_BUDGET } from '../src/render/quality';

describe('render budgets', () => {
  it('caps phone fill rate and connected-border geometry independently of desktop', () => {
    expect(renderQuality(true, 3)).toEqual({ pixelRatio: 1.5, margin: 4, mobile: true });
    expect(renderQuality(false, 3)).toEqual({ pixelRatio: 2, margin: 8, mobile: false });
    expect(renderQuality(true, NaN).pixelRatio).toBe(1);
    expect(renderQuality(false, 1).pixelRatio).toBe(1);
    expect(RENDER_BUDGET.drawCalls).toBeLessThan(100);
  });
  it('reports bounded-window frame/CPU percentiles, excluding invalid samples', () => {
    const p = new FrameProfiler();
    p.add(NaN, 0); p.add(0, 0);
    expect(p.snapshot().samples).toBe(0);
    for (let i = 0; i < 1000; i++) p.add(1000 / 60, 3);
    const s = p.snapshot();
    expect(s.samples).toBe(300);
    expect(s.fps).toBeCloseTo(60);
    expect(s.cpuP95Ms).toBe(3);
    p.reset();
    expect(p.snapshot().samples).toBe(0);
  });
});
