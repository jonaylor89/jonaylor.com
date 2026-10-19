/** InternalClockTradeAnim runs on the real BG/window/OAM hardware. */
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { c } from '../src/rom/constants';
import { TradeAnimation } from '../src/movie/trade';
import { frontPixels } from '../src/ui/picTiles';

describe.skipIf(!HAS_ROM)('InternalClockTradeAnim', () => {
  async function setup() {
    const b = await bundle();
    const h = new Harness(b);
    const given = { species: c('pokemon', 'CLEFAIRY'), otName: 'BLUE', otId: 12345 };
    const received = { species: c('pokemon', 'MR_MIME'), otName: b.trades.otName, otId: 54321 };
    return { b, h, anim: new TradeAnimation(h.engine, given, received) };
  }

  it('plays both directions, prints ROM texts, ignores battle-animation OFF, and restores the screen', async () => {
    const { b, h, anim } = await setup();
    h.engine.state.options.battleAnimation = false;
    const co = anim.run();
    const texts = new Set<string>();
    let frames = 0;
    let circled = 0;
    let seenPic = false;
    const shades = new Uint8Array(160 * 144);
    while (!co.next().done) {
      h.engine.sound.frame();
      if (frames % 10 === 0) texts.add(h.screenText());
      if (anim.hw.ppu.oam.slice(4, 20).every((o) => o.attr & 0x10)) circled++;
      if (!seenPic && anim.hw.autoBgTransfer && h.engine.screen.get(7, 2) === 0x100) {
        const px = frontPixels(b.pics.front[anim.given.species]);
        const expected = Array.from({ length: 64 }, (_, i) => px[Math.floor(i / 8) * 56 + 55 - i % 8]);
        expect(Array.from(anim.hw.ppu.tiles.slice(0x100 * 64, 0x101 * 64))).toEqual(expected);
        seenPic = true;
      }
      if (frames % 50 === 0) {
        anim.hw.ppu.render(shades);
        expect(shades.every((v) => v < 4)).toBe(true);
      }
      if (++frames > 10000) throw new Error('trade animation did not finish');
    }
    const printed = [...texts].join('\n');
    expect(printed).toContain('CLEFAIRY went');
    expect(printed).toContain('TRAINER sends');
    expect(printed).toContain('MR.MIME is');
    expect(printed).toContain('Take good care of');
    expect(printed).toContain('12345');
    expect(printed).toContain('54321');
    expect(circled).toBeGreaterThan(300);
    expect(seenPic).toBe(true);
    expect(frames).toBeGreaterThan(2000);
    expect(h.engine.screen.ppu).toBeUndefined();
    expect(h.engine.ram.noTextDelay).toBe(false);
    expect(h.engine.state.options.battleAnimation).toBe(false);
    expect(h.log).toEqual([]);
  });

  it('maps pic glyphs column-major without treating the Game Boy tiles as pic glyphs', async () => {
    const { h, anim } = await setup();
    const tile = Array(64).fill(2);
    h.engine.screen.setGlyphOverride(0x109, tile);
    h.engine.screen.put(0, 0, 0x109);
    h.engine.screen.put(1, 0, 0x31);
    anim.syncBg();
    expect(anim.hw.tileMap[0]).toBe(15);
    expect(anim.hw.tileMap[1]).toBe(0x31);
    expect(anim.hw.tileMap[2]).toBe(0x7f);
    expect(Array.from(anim.hw.ppu.tiles.slice(0x10f * 64, 0x110 * 64))).toEqual(tile);
    expect(Array.from(h.engine.screen.glyphIndices(0x80))).toEqual(h.bundle.ui.font.pixels.slice(0, 64));
  });

  it('restores PPU and text-delay state when the coroutine is cancelled', async () => {
    const { h, anim } = await setup();
    h.engine.ram.noTextDelay = true;
    const co = anim.run();
    co.next();
    expect(h.engine.screen.ppu).toBe(anim.hw.ppu);
    // LoadHpBarAndStatusTilePatterns supplies the ID/No. glyphs, not the quote tiles.
    const hp = h.bundle.ui.hpBarAndStatus.pixels;
    expect(Array.from(anim.hw.ppu.tiles.slice(0x173 * 64, 0x174 * 64))).toEqual(hp.slice(17 * 64, 18 * 64));
    co.return();
    expect(h.engine.screen.ppu).toBeUndefined();
    expect(h.engine.ram.noTextDelay).toBe(true);
  });
});
