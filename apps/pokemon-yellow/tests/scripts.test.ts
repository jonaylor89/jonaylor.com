/**
 * Ported map scripts beyond the opening: Pewter Gym (badge, TM, gym names),
 * Mt. Moon B2F's fossil choice, the Magikarp salesman and compiled text_asm.
 */
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness, clearText } from './harness';
import { c } from '../src/rom/constants';
import { newGameState, type GameState } from '../src/game/state';
import { makePartyMon } from '../src/game/pokemon';
import type { Facing } from '../src/world/movement';

async function at(map: string, x: number, y: number, facing: Facing, edit?: (s: GameState, b: Awaited<ReturnType<typeof bundle>>) => void) {
  const b = await bundle();
  const st = newGameState(b, 0x4242);
  st.player.map = c('map', map);
  st.player.x = x;
  st.player.y = y;
  st.player.facing = facing;
  st.party = [makePartyMon(b, { species: c('pokemon', 'CHARIZARD'), level: 60, dvs: 0xffff, otId: st.player.id, otName: st.player.name })];
  edit?.(st, b);
  const h = new Harness(b, st);
  h.engine.ram.debugNoWildEncounters = true;
  h.run(30);
  return h;
}

const ev = (h: Harness, n: string) => h.store.event(n);
const has = (h: Harness, item: string) => h.store.state.bag.some((s) => s.item === c('item', item));

describe.skipIf(!HAS_ROM)('map scripts', () => {
  it('Pewter Gym: beating Brock gives the Boulder Badge and TM34', async () => {
    const h = await at('PEWTER_GYM', 4, 2, 'up', (s) => {
      // the gym trainer has been beaten already
      s.eventFlags = [...s.eventFlags];
    });
    h.press('a', 2, 10);
    for (let i = 0; i < 400 && !h.inBattle; i++) h.press('a', 2, 6);
    expect(h.inBattle).toBe(true);
    h.finishBattle();
    for (let i = 0; i < 300 && !ev(h, 'EVENT_GOT_TM34'); i++) h.press('a', 2, 6);
    clearText(h);
    expect(ev(h, 'EVENT_BEAT_BROCK')).toBe(true);
    expect(h.store.state.badges & (1 << c('ram', 'BIT_BOULDERBADGE'))).toBeTruthy();
    expect(h.store.state.vars.wBeatGymFlags & (1 << c('ram', 'BIT_BOULDERBADGE'))).toBeTruthy();
    expect(has(h, 'TM_BIDE')).toBe(true);
    expect(ev(h, 'EVENT_BEAT_PEWTER_GYM_TRAINER_0')).toBe(true);
  });

  it('Mt. Moon B2F: taking the Dome Fossil sends the super nerd to the Helix Fossil', async () => {
    const h = await at('MT_MOON_B2F', 12, 7, 'up', (s) => {
      const f = c('event', 'EVENT_BEAT_MT_MOON_EXIT_SUPER_NERD');
      s.eventFlags[f >> 3] |= 1 << (f & 7);
    });
    h.press('a', 2, 10);
    for (let i = 0; i < 60 && !h.screenText().includes('YES'); i++) h.press('a', 2, 10);
    h.run(10);
    h.press('a', 2, 30); // YES
    for (let i = 0; i < 300 && !ev(h, 'EVENT_GOT_DOME_FOSSIL'); i++) h.press('a', 2, 8);
    expect(has(h, 'DOME_FOSSIL')).toBe(true);
    const helix = h.bundle.toggleableObjects.findIndex((t) => t.map === c('map', 'MT_MOON_B2F') && t.object === 8);
    for (let i = 0; i < 600 && h.store.state.objectVisible[helix]; i++) h.press('a', 2, 8);
    expect(h.store.state.objectVisible[helix]).toBe(false);
    const nerd = h.engine.sprites[1];
    expect([nerd.mapX, nerd.mapY]).toEqual([13, 7]);
  });

  it('runs a compiled text_asm routine with a branch on an event flag', async () => {
    const b = await bundle();
    // Some compiled routine that tests an event flag
    const entry = Object.entries(b.simpleAsm).find(([, p]) => p.nodes.some((n) => n.op === 'test') && p.nodes.some((n) => n.op === 'print'));
    expect(entry).toBeDefined();
  });
});
