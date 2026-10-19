/**
 * The following Pikachu (src/engine/pikachu.ts): it walks one square behind
 * the player, hops ledges with them, can be walked through, and appears
 * per the spawn rules after a warp.
 */
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { c } from '../src/rom/constants';
import { newGameState } from '../src/game/state';
import { makePartyMon } from '../src/game/pokemon';
import { WorldMap } from '../src/world/WorldMap';
import type { Facing } from '../src/world/movement';

async function withPikachu(map: string, x: number, y: number, facing: Facing = 'up') {
  const b = await bundle();
  const st = newGameState(b, 0x99);
  st.player.map = c('map', map);
  st.player.x = x;
  st.player.y = y;
  st.player.facing = facing;
  st.party = [
    makePartyMon(b, { species: c('pokemon', 'STARTER_PIKACHU'), level: 5, dvs: 0xffff, otId: st.player.id, otName: st.player.name }),
  ];
  const h = new Harness(b, st);
  h.engine.ram.debugNoWildEncounters = true;
  h.run(30);
  return h;
}

const pika = (h: Harness) => h.engine.sprites[h.engine.pikachuSlot];

describe.skipIf(!HAS_ROM)('Pikachu follower', () => {
  it('spawns on the player and then follows one square behind', async () => {
    const h = await withPikachu('ROUTE_1', 10, 30);
    expect(pika(h)?.pictureId).toBe(c('sprite', 'SPRITE_PIKACHU'));
    expect(pika(h)?.hidden).toBe(true); // on the player's square
    h.walk('up');
    h.walk('up');
    h.walk('up');
    h.run(20);
    const s = pika(h)!;
    expect([s.mapX, s.mapY]).toEqual([h.p.x, h.p.y + 1]);
    expect(s.hidden).toBe(false);
    expect(s.offX).toBe(0);
    expect(s.offY).toBe(0);
    // turning around and walking back passes through Pikachu (after the bump frames)
    h.walk('down');
    h.walk('down');
    h.run(20);
    expect(h.p.y).toBeGreaterThan(s.mapY - 1);
  });

  it('follows over a ledge in one two-square hop', async () => {
    const b = await bundle();
    const route = new WorldMap(b, c('map', 'ROUTE_1'));
    const ledge = b.tileTables.ledges.find((l) => l.facing === 0)!;
    let at: [number, number] | undefined;
    for (let y = 0; y < route.heightSquares - 2 && !at; y++)
      for (let x = 0; x < route.widthSquares && !at; x++)
        if (route.collisionTile(x, y) === ledge.standing && route.collisionTile(x, y + 1) === ledge.ledge && route.isSquarePassable(x, y - 1))
          at = [x, y];
    expect(at).toBeDefined();
    const [lx, ly] = at!;
    const h = await withPikachu('ROUTE_1', lx, ly - 1, 'down');
    h.walk('down'); // Pikachu now behind, at (lx, ly - 1)
    h.run(20);
    h.walk('down', 120); // hop the ledge to ly + 2
    h.run(60);
    expect(h.p.y).toBe(ly + 2);
    // Pikachu runs one command behind: it is still above the ledge…
    const s = pika(h)!;
    expect([s.mapX, s.mapY]).toEqual([lx, ly]);
    // …and hops it (two squares at once) when the player takes the next step
    h.walk('down');
    h.run(20);
    expect([pika(h)!.mapX, pika(h)!.mapY]).toEqual([lx, ly + 2]);
  });

  it('is hidden while text is shown over it and when not in the party', async () => {
    const h = await withPikachu('ROUTE_1', 10, 30);
    h.walk('up');
    h.run(20);
    expect(pika(h)?.hidden).toBe(false);
    h.store.dispatch({ type: 'setParty', party: [] }, { undoable: false });
    h.run(2);
    expect(pika(h)?.hidden).toBe(true);
  });
});

describe.skipIf(!HAS_ROM)('talking to Pikachu', () => {
  it('shows the mood/happiness picture in a 5x5 window, then closes it', async () => {
    const h = await withPikachu('ROUTE_1', 10, 30);
    h.store.dispatch({ type: 'setPikachu', happiness: 90, mood: 128 }, { undoable: false });
    h.walk('up');
    h.walk('up');
    h.run(30);
    // turn to face Pikachu (one square below)
    h.press('down', 2, 20);
    expect(h.engine.state.player.facing).toBe('down');
    expect(pika(h)?.mapY).toBe(h.p.y + 1);
    const { pikachuEmotionIndex } = await import('../src/engine/pikachuEmotions');
    // happiness 90 → second row, mood 128 → third column: PikaPicAnimScript5 / emotion 5
    expect(pikachuEmotionIndex(h.engine)).toBe(5);
    h.press('a', 2, 2);
    let sawPic = false;
    for (let i = 0; i < 400 && !sawPic; i++) {
      h.run(1);
      sawPic = h.engine.screen.get(8, 7) >= 0x80 && h.engine.screen.get(6, 5) >= 0;
    }
    expect(sawPic).toBe(true);
    h.run(600);
    expect(h.engine.screen.get(8, 7)).toBe(-1); // window closed
  });
});
