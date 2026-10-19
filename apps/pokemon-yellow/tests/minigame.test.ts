/** The Surfing Pikachu minigame, started from the Summer Beach House. */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { HAS_ROM } from './helpers';
import { clearText } from './harness';
import { fieldAt } from './fieldHelpers';
import { c } from '../src/rom/constants';

describe.skipIf(!HAS_ROM)('Surfing Pikachu', () => {
  it('runs the intro and the course, then returns to the map', async () => {
    const h = await fieldAt('SUMMER_BEACH_HOUSE', 2, 4, 'up', (s) => {
      s.party[0].moves[3] = c('move', 'SURF');
    });
    const screen = h.engine.screen;
    h.press('a', 2, 10);
    for (let i = 0; i < 100 && !h.screenText().includes('YES'); i++) h.press('a', 2, 10);
    h.run(10);
    h.press('a', 2, 10); // YES
    let sawPpu = false;
    let routineMax = 0;
    for (let i = 0; i < 20000; i++) {
      h.step();
      if (screen.ppu) {
        sawPpu = true;
        // never jump: just ride until the HP or the course runs out, then A out of the results
        if (i % 30 === 0) h.press('a', 2, 2);
      } else if (sawPpu) break;
      const g = (screen.ppu as unknown as { owner?: { routine: number } } | undefined)?.owner;
      if (g) routineMax = Math.max(routineMax, g.routine & 0x7f);
    }
    expect(sawPpu).toBe(true);
    expect(screen.ppu).toBeUndefined();
    clearText(h);
    expect(h.engine.state.player.map).toBe(c('map', 'SUMMER_BEACH_HOUSE'));
    expect(h.engine.state.vars.wPikachuMapScriptFlags & 2).toBeTruthy();
  });
});
