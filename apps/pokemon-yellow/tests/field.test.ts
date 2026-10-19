/**
 * Overworld field systems (src/field): Surf, fishing, Cut, Strength, Fly, Flash
 * and forced movement, driven through the real overworld with button presses.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { clearText, Harness } from './harness';
import type { GbBattleHost } from '../src/battle/host';
import { c } from '../src/rom/constants';
import { newGameState, type GameState } from '../src/game/state';
import { makePartyMon } from '../src/game/pokemon';
import { WorldMap } from '../src/world/WorldMap';
import { fieldAt, useFieldMove } from './fieldHelpers';
import type { Facing } from '../src/world/movement';
import type { GameBundle } from '../src/data/schema';
import { setStrengthActive } from '../src/field/strength';

/** A land square whose neighbour in `dir` is water a surfer could enter. */
function findShore(b: GameBundle, map: string, dir: Facing): [number, number] {
  const w = new WorldMap(b, c('map', map));
  const [dx, dy] = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  const tt = b.tileTables;
  for (let y = 0; y < w.heightSquares; y++)
    for (let x = 0; x < w.widthSquares; x++) {
      if (!w.isSquarePassable(x, y) || !w.inBounds(x + dx, y + dy)) continue;
      if (tt.shoreTiles.includes(w.collisionTile(x, y))) continue;
      if (w.collisionTile(x + dx, y + dy) === tt.waterTile) return [x, y];
    }
  throw new Error(`no shore in ${map}`);
}

describe.skipIf(!HAS_ROM)('Surf', () => {
  it('surfs from the shore with the field move and gets off on land', async () => {
    const b = await bundle();
    const [x, y] = findShore(b, 'PALLET_TOWN', 'down');
    const h = await fieldAt('PALLET_TOWN', x, y, 'down', (s) => {
      s.badges = 1 << c('ram', 'BIT_SOULBADGE');
      s.party[1].moves[1] = c('move', 'SURF');
    });
    useFieldMove(h, 1);
    clearText(h);
    h.run(40);
    const p = h.engine.state.player;
    expect(p.mode).toBe('surf');
    expect(p.y).toBe(y + 1);
    expect(h.engine.sprites[0].pictureId).toBe(c('sprite', 'SPRITE_SEEL'));
    // back onto the shore
    expect(h.walk('up')).toBe(true);
    h.run(30);
    expect(h.engine.state.player.mode).toBe('walk');
    expect(h.engine.sprites[0].pictureId).toBe(c('sprite', 'SPRITE_RED'));
  });

  it('needs the SOUL BADGE', async () => {
    const b = await bundle();
    const [x, y] = findShore(b, 'PALLET_TOWN', 'down');
    const h = await fieldAt('PALLET_TOWN', x, y, 'down', (s) => (s.party[1].moves[1] = c('move', 'SURF')));
    useFieldMove(h, 1);
    clearText(h);
    expect(h.engine.state.player.mode).toBe('walk');
  });
});

describe.skipIf(!HAS_ROM)('Fishing', () => {
  /** START → ITEM → the first bag item → USE */
  const useFirstItem = (h: Harness) => {
    h.press('start', 2, 10);
    h.press('down', 2, 4); // ITEM
    h.press('a', 2, 20);
    h.press('a', 2, 10);
    h.press('a', 2, 20); // USE
  };

  it('the OLD ROD always hooks a Lv5 MAGIKARP', async () => {
    const b = await bundle();
    const [x, y] = findShore(b, 'PALLET_TOWN', 'down');
    const h = await fieldAt('PALLET_TOWN', x, y, 'down', (s) => (s.bag = [{ item: c('item', 'OLD_ROD'), qty: 1 }]));
    useFirstItem(h);
    let sawRod = false;
    let enemy: number | undefined;
    for (let i = 0; i < 600 && enemy === undefined; i++) {
      h.step();
      if (h.engine.ram.fishing?.rod) sawRod = true;
      if (h.screenText().includes('bite')) h.press('a', 2, 4);
      const cur = (h.engine.battleHost as GbBattleHost).current;
      if (cur?.enemy.mon.species) enemy = cur.enemy.mon.species;
    }
    expect(sawRod).toBe(true);
    expect(enemy).toBe(c('pokemon', 'MAGIKARP'));
  });

  it('cannot fish without water ahead', async () => {
    const h = await fieldAt('PALLET_TOWN', 5, 6, 'down', (s) => (s.bag = [{ item: c('item', 'OLD_ROD'), qty: 1 }]));
    useFirstItem(h);
    clearText(h);
    expect(h.engine.ram.curOpponent).toBe(0);
    expect(h.inBattle).toBe(false);
  });
});

describe.skipIf(!HAS_ROM)('Strength', () => {
  const boulderAt = (h: Harness, x: number, y: number) => h.engine.sprites.some((s) => s && s.mapX === x && s.mapY === y && s.pictureId === c('sprite', 'SPRITE_BOULDER'));

  it('pushes a boulder after the second try, only with STRENGTH active', async () => {
    for (const active of [false, true]) {
      const h = await fieldAt('VICTORY_ROAD_1F', 5, 16, 'up');
      setStrengthActive(h.engine, active); // as the START menu's STRENGTH does, after the map loaded
      h.run(60, ['up']);
      h.run(60);
      expect(boulderAt(h, 5, 14)).toBe(active);
      expect(boulderAt(h, 5, 15)).toBe(!active);
      expect(h.engine.ram.pushedBoulder).toBe(active);
    }
  });

  it('entering a map turns STRENGTH off', async () => {
    const h = await fieldAt('VICTORY_ROAD_1F', 5, 16, 'up');
    setStrengthActive(h.engine, true);
    h.engine.store.dispatch({ type: 'setPosition', map: c('map', 'VICTORY_ROAD_1F'), x: 5, y: 16 }, { undoable: false });
    h.engine.reload();
    h.run(30);
    expect((h.engine.state.vars.wStatusFlags1 ?? 0) & 1).toBe(0);
  });
});

describe.skipIf(!HAS_ROM)('Cut', () => {
  it('cuts the tree in front, which swaps its block until the map reloads', async () => {
    const b = await bundle();
    // a square on Route 2 facing a cuttable tree ($3d) from below
    const w = new WorldMap(b, c('map', 'ROUTE_2'));
    let at: [number, number] | undefined;
    for (let y = 1; y < w.heightSquares && !at; y++)
      for (let x = 0; x < w.widthSquares && !at; x++) if (w.isSquarePassable(x, y) && w.collisionTile(x, y - 1) === 0x3d) at = [x, y];
    expect(at).toBeDefined();
    const [x, y] = at!;
    const h = await fieldAt('ROUTE_2', x, y, 'up', (s) => {
      s.badges = 1 << c('ram', 'BIT_CASCADEBADGE');
      s.party[1].moves[1] = c('move', 'CUT');
    });
    useFieldMove(h, 1);
    clearText(h);
    h.run(60);
    expect(h.engine.world.collisionTile(x, y - 1)).not.toBe(0x3d);
    expect(h.walk('up')).toBe(true);
  });

  it('finds nothing to cut in open ground', async () => {
    const h = await fieldAt('PALLET_TOWN', 5, 6, 'down', (s) => {
      s.badges = 1 << c('ram', 'BIT_CASCADEBADGE');
      s.party[1].moves[1] = c('move', 'CUT');
    });
    useFieldMove(h, 1);
    let seen = false;
    for (let i = 0; i < 300 && !seen; i++) {
      h.step();
      seen = h.screenText().includes('anything to CUT');
    }
    expect(seen).toBe(true);
  });
});

describe.skipIf(!HAS_ROM)('Fly and the Town Map', () => {
  const flyer = (s: GameState) => {
    s.badges = 1 << c('ram', 'BIT_THUNDERBADGE');
    s.party[1].moves[1] = c('move', 'FLY');
    s.vars.wTownVisitedFlag = (1 << c('map', 'PALLET_TOWN')) | (1 << c('map', 'VIRIDIAN_CITY'));
  };

  it('flies to a visited town picked on the Town Map', async () => {
    const h = await fieldAt('ROUTE_1', 10, 20, 'down', flyer);
    useFieldMove(h, 1);
    h.run(40);
    expect(h.screenText()).toContain('PALLET TOWN');
    h.press('up', 2, 30); // the next visited town
    expect(h.screenText()).toContain('VIRIDIAN CITY');
    h.press('a', 2, 10);
    let sawBird = false;
    for (let i = 0; i < 900 && h.engine.state.player.map !== c('map', 'VIRIDIAN_CITY'); i++) {
      h.step();
      if (h.engine.ram.playerAnim?.bird) sawBird = true;
    }
    h.run(200);
    const b = await bundle();
    const dest = b.specialWarps.fly[c('map', 'VIRIDIAN_CITY')];
    expect(sawBird).toBe(true);
    expect(h.engine.state.player).toMatchObject({ map: c('map', 'VIRIDIAN_CITY'), x: dest.x, y: dest.y });
    expect(h.engine.ram.playerAnim).toBeUndefined();
  });

  it('cannot fly indoors', async () => {
    const h = await fieldAt('REDS_HOUSE_1F', 3, 4, 'down', flyer);
    useFieldMove(h, 1);
    let seen = false;
    for (let i = 0; i < 200 && !seen; i++) {
      h.step();
      seen = h.screenText().includes('FLY here');
    }
    expect(seen).toBe(true);
  });

  it('entering a town marks it visited', async () => {
    const h = await fieldAt('PALLET_TOWN', 5, 6, 'down');
    expect((h.engine.state.vars.wTownVisitedFlag ?? 0) & 1).toBe(1);
  });

  it('TELEPORT spins the player back to the last Pokémon Center town', async () => {
    const h = await fieldAt('ROUTE_1', 10, 20, 'down', (s) => {
      s.party[1].moves[1] = c('move', 'TELEPORT');
      s.vars.wLastBlackoutMap = c('map', 'VIRIDIAN_CITY');
    });
    useFieldMove(h, 1);
    let spun = false;
    for (let i = 0; i < 900 && h.engine.state.player.map !== c('map', 'VIRIDIAN_CITY'); i++) {
      h.step();
      if (h.screenText().includes('▼')) h.press('a', 2, 2);
      if (h.engine.ram.playerAnim && !h.engine.ram.playerAnim.bird) spun = true;
    }
    expect(spun).toBe(true);
    expect(h.engine.state.player.map).toBe(c('map', 'VIRIDIAN_CITY'));
  });
});

describe.skipIf(!HAS_ROM)('Dark caves and FLASH', () => {
  it('Rock Tunnel is dark until FLASH lights it', async () => {
    // the warp at Route 10 (8,17) leads into ROCK_TUNNEL_1F
    const h = await fieldAt('ROUTE_10', 8, 18, 'up', (s) => {
      s.badges = 1 << c('ram', 'BIT_BOULDERBADGE');
      s.party[1].moves[1] = c('move', 'FLASH');
    });
    expect(h.walk('up')).toBe(true);
    h.run(60);
    expect(h.engine.state.player.map).toBe(c('map', 'ROCK_TUNNEL_1F'));
    expect(h.engine.ram.mapPalOffset).toBe(6);
    useFieldMove(h, 1);
    clearText(h);
    expect(h.engine.ram.mapPalOffset).toBe(0);
  });
});
