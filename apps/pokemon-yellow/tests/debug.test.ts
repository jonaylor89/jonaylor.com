import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { STORY_PRESETS, CUTSCENE_PRESETS, applyPreset, presetState, spawnEncounter } from '../src/dev/presets';
import { c } from '../src/rom/constants';
import { Ppu } from '../src/gb/ppu';

describe.skipIf(!HAS_ROM)('debug tools', () => {
  it('has independent, deterministic story fixtures with valid maps/flags and a visibly labelled QA party', async () => {
    const b = await bundle();
    for (const p of [...STORY_PRESETS, ...CUTSCENE_PRESETS]) {
      const s = presetState(b, p.id, 7);
      expect(s).toEqual(presetState(b, p.id, 7));
      expect(b.maps[s.player.map]).toBeDefined();
      expect(s.player.x).toBeLessThan(b.maps[s.player.map].width * 2);
      expect(s.player.y).toBeLessThan(b.maps[s.player.map].height * 2);
      expect(s.badges).toBe(p.badges);
      for (const name of p.events) expect(s.eventFlags[c('event', name) >> 3] & (1 << (c('event', name) & 7))).not.toBe(0);
      expect(s.party.length).toBe(p.emptyParty ? 0 : 1);
    }
    expect(presetState(b, 'postgame').objectVisible[c('toggle', 'TOGGLE_CERULEAN_CAVE_GUY')]).toBe(false);
    expect(() => presetState(b, 'invalid')).toThrow('unknown story');
  });

  it('pauses before VBlank/RNG, advances exactly the requested frames, and bounds the trace', async () => {
    const h = new Harness(await bundle());
    h.run(30);
    const e = h.engine;
    const before = e.state.frames, rng = structuredClone(e.state.rng);
    e.debugPaused = true;
    h.run(100);
    expect(e.state.frames).toBe(before);
    expect(e.state.rng).toEqual(rng);
    e.traceEnabled = true;
    e.stepFrames(10, ['a']);
    h.run(20);
    expect(e.state.frames).toBe(before + 10);
    expect(e.input?.held.has('a')).toBe(true);
    for (let i = 0; i < 1000; i++) e.trace('test', String(i));
    expect(e.debugTrace).toHaveLength(200);
    expect(e.debugTrace.at(-1)?.label).toBe('999');
  });

  it('runs to the next map-script state, not an unbounded resume', async () => {
    const h = new Harness(await bundle()); h.run(30);
    const e = h.engine;
    e.boot = function* () { yield; yield; e.curScript = 1; for (;;) yield; };
    e.reload();
    const frame = e.state.frames;
    e.stepScript(); h.run(20);
    expect(e.state.frames - frame).toBe(3);
    expect(e.curScript).toBe(1);
    expect(e.debugPaused).toBe(true);
  });

  it('cancels active scene finally blocks and resets presentation on debug warp/reload', async () => {
    const h = new Harness(await bundle()); h.run(30);
    const e = h.engine;
    let closed = 0;
    e.boot = function* () { e.screen.setPpu(new Ppu()); try { for (;;) yield; } finally { closed++; } };
    e.reload(); h.run(2);
    expect(e.screen.ppu).toBeDefined();
    e.teleport(c('map', 'PALLET_TOWN'), 5, 6);
    expect(closed).toBe(1);
    expect(e.screen.ppu).toBeUndefined();
    h.run(30);
    expect(e.world.data.constName).toBe('PALLET_TOWN');
  });

  it('queues a real wild battle with validation and leaves presets undoable', async () => {
    const h = new Harness(await bundle());
    applyPreset(h.engine, 'pokedex'); h.run(30);
    const before = structuredClone(h.store.state);
    applyPreset(h.engine, 'league');
    expect(h.store.state.badges).toBe(255);
    expect(h.store.undo()).toBe(true);
    h.engine.reload();
    expect(h.store.state.player.map).toBe(before.player.map);
    h.run(30);
    const e = h.engine;
    expect(() => spawnEncounter(e, 999, 5)).toThrow();
    expect(() => spawnEncounter(e, c('pokemon', 'PIDGEY'), 101)).toThrow();
    spawnEncounter(e, c('pokemon', 'PIDGEY'), 5);
    expect(() => spawnEncounter(e, c('pokemon', 'PIDGEY'), 5)).toThrow('Finish');
    expect(h.waitUntil(() => h.inBattle, 1000)).toBe(true);
    const host = e.battleHost as { current?: { req: { species?: number; level?: number } } };
    expect(host.current?.req).toMatchObject({ species: c('pokemon', 'PIDGEY'), level: 5 });
  });
});
