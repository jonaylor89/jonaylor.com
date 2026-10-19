import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness, pressUntil, clearText } from './harness';
import { c } from '../src/rom/constants';
import { newGameState, getBit } from '../src/game/state';
import { DIR_VEC } from '../src/world/movement';
import { facingName } from '../src/engine/sprites';
import { WorldMap } from '../src/world/WorldMap';
import { makePartyMon } from '../src/game/pokemon';

describe.skipIf(!HAS_ROM)('trainer engine', () => {
  it('a Viridian Forest trainer spots the player, walks up, challenges and is marked beaten', async () => {
    const b = await bundle();
    const forest = b.maps[c('map', 'VIRIDIAN_FOREST')];
    expect(forest.scriptKind).toBe('trainers');
    const w = new WorldMap(b, forest.id);
    // Pick a trainer and a free square 3 steps in front of it.
    let setup: { header: number; x: number; y: number } | undefined;
    for (const [i, hdr] of forest.trainerHeaders.entries()) {
      const o = forest.objects[hdr.spriteIndex - 1];
      if (o.movement !== 0xff || hdr.engageDistance < 3) continue;
      const f = facingName({ 0xd0: 0, 0xd1: 4, 0xd2: 8, 0xd3: 12 }[o.rangeOrDirection] ?? 0);
      const [dx, dy] = DIR_VEC[f];
      const ok = [1, 2, 3].every((k) => w.isSquarePassable(o.x + dx * k, o.y + dy * k));
      if (ok) {
        setup = { header: i, x: o.x + dx * 3, y: o.y + dy * 3 };
        break;
      }
    }
    expect(setup).toBeDefined();
    const st = newGameState(b, 0x7a);
    st.player.map = forest.id;
    st.player.x = setup!.x;
    st.player.y = setup!.y;
    st.party = [makePartyMon(b, { species: c('pokemon', 'CHARIZARD'), level: 50, dvs: 0xffff, otId: st.player.id, otName: st.player.name })];
    const moneyBefore = st.money;
    const h = new Harness(b, st);
    const hdr = forest.trainerHeaders[setup!.header];
    h.run(10);
    expect(h.waitUntil(() => h.engine.ram.emotionBubble?.slot === hdr.spriteIndex, 120)).toBe(true);
    // The trainer walks up to stand next to the player.
    const ok = pressUntil(h, () => getBit(h.store.state.eventFlags, hdr.eventFlag), 1500);
    expect(ok).toBe(true);
    expect(h.store.state.money).toBeGreaterThan(moneyBefore); // prize money
    clearText(h);
    const s = h.engine.sprites[hdr.spriteIndex];
    expect(Math.abs(s.mapX - h.p.x) + Math.abs(s.mapY - h.p.y)).toBe(1);
    expect(h.store.state.mapScripts[forest.id] ?? 0).toBe(0);
    // Once beaten, the trainer no longer engages; talking gives the after-battle text.
    h.run(120);
    expect(h.textBoxOpen()).toBe(false);
  });
});
