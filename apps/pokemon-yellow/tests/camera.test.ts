import { describe, expect, it } from 'vitest';
import { CameraDirector, sampleRail, type CameraShot } from '../src/render/camera';
import { CUTSCENE_SHOTS, cutsceneCamera } from '../src/render/cutscenes';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { c } from '../src/rom/constants';
import { newGameState } from '../src/game/state';

const shot: CameraShot = { id: 'test', keys: [
  { frame: 0, x: 0, z: 0, zoom: 1, pitch: 0, yaw: 0 },
  { frame: 100, x: 2, z: -2, zoom: 0.8, pitch: -4, yaw: 8 },
] };
const player = { x: 10, z: 10 };

describe('camera rails', () => {
  it('samples the same pose regardless of rendering frequency and holds the last key', () => {
    expect(sampleRail(shot.keys, 50)).toEqual({ x: 1, z: -1, zoom: 0.9, pitch: -2, yaw: 4 });
    expect(sampleRail(shot.keys, 500)).toEqual(sampleRail(shot.keys, 100));
    const a = new CameraDirector(), b = new CameraDirector();
    a.sample(shot, player, player, 0);
    b.sample(shot, player, player, 0);
    for (let i = 1; i < 100; i++) a.sample(shot, player, player, i);
    expect(a.sample(shot, player, player, 100)).toEqual(b.sample(shot, player, player, 100));
  });

  it('blends into a shot and back, with no discontinuity when switching shots', () => {
    const d = new CameraDirector();
    expect(d.sample(shot, { x: 14, z: 14 }, player, 0).x).toBe(10);
    const last = d.sample(shot, { x: 14, z: 14 }, player, 100);
    expect(last.x).toBe(16);
    expect(d.sample(undefined, player, player, 101)).toEqual(last);
    expect(d.sample(undefined, player, player, 133)).toEqual({ ...player, zoom: 1, pitch: 0, yaw: 0 });
    expect(d.active).toBe(false);
  });

  it('disables rails for reduced motion, resets on warps and translates connection origins', () => {
    const d = new CameraDirector();
    d.sample(shot, player, player, 0);
    const last = d.sample(shot, player, player, 100);
    d.shift(-20, 5);
    expect(d.sample(undefined, player, player, 101)).toEqual({ ...last, x: last.x - 20, z: last.z + 5 });
    expect(d.sample(shot, player, player, 102, true)).toEqual({ ...player, zoom: 1, pitch: 0, yaw: 0 });
    d.reset();
    expect(d.sample(undefined, { x: 100, z: 100 }, player, 500).x).toBe(10);
  });
});

describe.skipIf(!HAS_ROM)('script camera cues', () => {
  it('observes every authored milestone, never changing the game state or RNG', async () => {
    const b = await bundle();
    for (const rule of CUTSCENE_SHOTS) {
      const state = newGameState(b, 7);
      state.player.map = rule.map;
      const h = new Harness(b, state);
      h.engine.loadMapData();
      h.engine.curScript = rule.first;
      const before = structuredClone(h.engine.state);
      const rng = { ...h.engine.rng };
      for (let i = 0; i < 10; i++) expect(cutsceneCamera(h.engine).shot?.id).toBe(rule.id);
      expect(h.engine.state).toEqual(before);
      expect({ ...h.engine.rng }).toEqual(rng);
    }
  });

  it('ignores hidden subjects, releases normal follow, and hides rails in battle/PPU screens', async () => {
    const b = await bundle();
    const state = newGameState(b, 7);
    state.player.map = c('map', 'PALLET_TOWN');
    const h = new Harness(b, state), e = h.engine;
    e.loadMapData();
    e.curScript = c('map_script', 'SCRIPT_PALLETTOWN_OAK_GREETS_PLAYER');
    const oak = e.sprites[c('object', 'PALLETTOWN_OAK')];
    oak.hidden = true;
    const hidden = cutsceneCamera(e);
    expect(hidden.shot).toBeDefined();
    expect(hidden.focus.x).toBe(e.spriteRenderPos(e.sprites[0])[0] + 0.5);
    oak.hidden = false;
    oak.mapX = e.state.player.x + 20;
    const visible = cutsceneCamera(e);
    expect(Math.abs(visible.focus.x - hidden.focus.x)).toBeLessThanOrEqual(2.5);
    e.ram.isInBattle = 1;
    expect(cutsceneCamera(e).shot).toBeUndefined();
    e.ram.isInBattle = 0;
    e.curScript = c('map_script', 'SCRIPT_PALLETTOWN_DAISY');
    expect(cutsceneCamera(e).shot).toBeUndefined();
    e.ram.joyIgnore = 0xff;
    e.ram.simulatedIndex = 3;
    expect(cutsceneCamera(e).shot?.id).toContain('scripted-walk');
  });
});
