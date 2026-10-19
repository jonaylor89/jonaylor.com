import { describe, expect, it } from 'vitest';
import { applyFilter, COLOR_FILTERS, isColorFilter, to8bit, type RGB } from '../src/render/palette';

// Representative SGB-style 5-bit palettes: town green, cave brown, sea blue, gray.
const SAMPLES: RGB[][] = ([
  [[31, 31, 31], [19, 27, 10], [9, 16, 6], [3, 3, 3]],
  [[31, 31, 31], [23, 19, 9], [14, 9, 4], [3, 3, 3]],
  [[31, 31, 31], [16, 23, 31], [6, 12, 24], [3, 3, 3]],
  [[31, 31, 31], [21, 21, 21], [10, 10, 10], [3, 3, 3]],
] as RGB[][]).map((p) => p.map(to8bit));
const lum = (c: RGB) => {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: RGB, b: RGB) => (Math.max(lum(a), lum(b)) + 0.05) / (Math.min(lum(a), lum(b)) + 0.05);

describe('color filters', () => {
  it('validates ids from the published list', () => {
    for (const f of COLOR_FILTERS) expect(isColorFilter(f.id)).toBe(true);
    expect(isColorFilter('invalid')).toBe(false);
    expect(isColorFilter(undefined)).toBe(false);
  });

  it('keeps the original palette untouched', () => {
    for (const p of SAMPLES) expect(applyFilter(p, 'gbc')).toBe(p);
  });

  it('produces four valid shades with readable text contrast for every filter', () => {
    for (const { id } of COLOR_FILTERS)
      for (const p of SAMPLES) {
        const out = applyFilter(p, id);
        expect(out).toHaveLength(4);
        for (const c of out) for (const v of c) expect(Number.isInteger(v) && v >= 0 && v <= 255).toBe(true);
        // Dialogue is shade 3 on shade 0; keep it at least WCAG AA.
        expect(contrast(out[0], out[3]), `${id}`).toBeGreaterThanOrEqual(4.5);
        expect(lum(out[0]), `${id}`).toBeGreaterThan(lum(out[3]));
      }
  });

  it('keeps per-area hues for graded filters', () => {
    for (const id of ['vivid', 'pastel', 'dusk', 'night'] as const) {
      const [town, , sea] = SAMPLES.map((p) => applyFilter(p, id));
      expect(town[1], id).not.toEqual(sea[1]);
      expect(town[1][1] > town[1][2], `${id} town stays green`).toBe(true);
      expect(sea[1][2] > sea[1][0], `${id} sea stays blue`).toBe(true);
    }
  });

  it('makes vivid more saturated than the original', () => {
    const sat = ([r, g, b]: RGB) => Math.max(r, g, b) - Math.min(r, g, b);
    for (const p of SAMPLES.slice(0, 3)) expect(sat(applyFilter(p, 'vivid')[1])).toBeGreaterThan(sat(p[1]));
  });
});
