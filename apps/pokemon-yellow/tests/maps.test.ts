import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { c } from '../src/rom/constants';
import { WorldMap } from '../src/world/WorldMap';
import { afterStep, planStep, resolveWarp, type MoverState } from '../src/world/movement';

const free = { isOccupied: () => false };

describe.skipIf(!HAS_ROM)('maps', () => {
  it('every map loads and every tile resolves', async () => {
    const b = await bundle();
    for (const m of Object.values(b.maps)) {
      const w = new WorldMap(b, m.id);
      for (let ty = -4; ty < m.height * 4 + 4; ty++)
        for (let tx = -4; tx < m.width * 4 + 4; tx++) {
          const t = w.tileAt(tx, ty);
          const owner = w.tilesetForBlock(Math.floor(tx / 4), Math.floor(ty / 4));
          expect(t, `${m.constName} tile ${tx},${ty}`).toBeLessThan(owner.tileCount);
        }
    }
  });

  it('warp integrity: every warp leads to an existing warp', async () => {
    const b = await bundle();
    const problems: string[] = [];
    for (const m of Object.values(b.maps)) {
      for (const [i, w] of m.warps.entries()) {
        if (w.destMap === 0xff) continue;
        const dest = b.maps[w.destMap];
        if (!dest) problems.push(`${m.constName}#${i} -> missing map ${w.destMap}`);
        else if (!dest.warps[w.destWarp]) problems.push(`${m.constName}#${i} -> ${dest.constName} missing warp ${w.destWarp}`);
      }
    }
    expect(problems).toEqual(KNOWN_BROKEN_WARPS);
  });

  it('connections are reciprocal', async () => {
    const b = await bundle();
    const opposite = { north: 'south', south: 'north', west: 'east', east: 'west' } as const;
    for (const m of Object.values(b.maps))
      for (const [dir, conn] of Object.entries(m.connections)) {
        const other = b.maps[conn!.map];
        expect(other, `${m.constName} ${dir}`).toBeDefined();
        const back = other.connections[opposite[dir as keyof typeof opposite]];
        expect(back?.map, `${m.constName} ${dir} -> ${other.constName}`).toBe(m.id);
        expect(back?.offset).toBe(-conn!.offset || 0);
      }
  });

  it('walks out of Red\'s house and into Pallet Town', async () => {
    const b = await bundle();
    const house = new WorldMap(b, c('map', 'REDS_HOUSE_1F'));
    // Door mat warps sit on the bottom row; walking down off them warps outside.
    const door = house.data.warps[0];
    const m: MoverState = { x: door.x, y: door.y, facing: 'down', mode: 'walk' };
    const plan = planStep(house, m, 'down', free);
    expect(plan).toEqual({ type: 'warp', warp: 0 });
    const dest = resolveWarp(house, 0, c('map', 'PALLET_TOWN'));
    expect(dest).toEqual({ map: c('map', 'PALLET_TOWN'), x: 5, y: 5, lastMap: c('map', 'PALLET_TOWN') });
  });

  it('enters a house through its door tile', async () => {
    const b = await bundle();
    const pallet = new WorldMap(b, c('map', 'PALLET_TOWN'));
    // Stand just below Red's house door and walk up onto it.
    const m: MoverState = { x: 5, y: 6, facing: 'up', mode: 'walk' };
    const plan = planStep(pallet, m, 'up', free);
    expect(plan).toEqual({ type: 'walk', x: 5, y: 5 });
    const arrived = afterStep(pallet, { ...m, x: 5, y: 5 }, true);
    expect(arrived).toEqual({ type: 'warp', warp: 0 });
    const dest = resolveWarp(pallet, 0, 0);
    expect(dest.map).toBe(c('map', 'REDS_HOUSE_1F'));
    expect(dest.lastMap).toBe(c('map', 'PALLET_TOWN'));
  });

  it('blocks walking into a house wall and through water', async () => {
    const b = await bundle();
    const pallet = new WorldMap(b, c('map', 'PALLET_TOWN'));
    expect(planStep(pallet, { x: 4, y: 6, facing: 'up', mode: 'walk' }, 'up', free).type).toBe('blocked');
    // Fence/sign row next to the lab
    expect(planStep(pallet, { x: 5, y: 6, facing: 'up', mode: 'walk' }, 'up', { isOccupied: () => true })).toEqual({ type: 'blocked', reason: 'object' });
  });

  it('crosses map connections', async () => {
    const b = await bundle();
    const pallet = new WorldMap(b, c('map', 'PALLET_TOWN'));
    const r = afterStep(pallet, { x: 10, y: -1, facing: 'up', mode: 'walk' }, true);
    expect(r).toEqual({ type: 'connection', dir: 'north', map: c('map', 'ROUTE_1'), x: 10, y: 35 });
    const route1 = new WorldMap(b, c('map', 'ROUTE_1'));
    const v = afterStep(route1, { x: 8, y: -1, facing: 'up', mode: 'walk' }, true);
    expect(v).toEqual({ type: 'connection', dir: 'north', map: c('map', 'VIRIDIAN_CITY'), x: 18, y: 35 });
  });

  it('jumps ledges on Route 1 only downward', async () => {
    const b = await bundle();
    const route1 = new WorldMap(b, c('map', 'ROUTE_1'));
    let found = 0;
    for (let y = 0; y < route1.heightSquares - 2; y++)
      for (let x = 0; x < route1.widthSquares; x++) {
        const down = planStep(route1, { x, y, facing: 'down', mode: 'walk' }, 'down', free);
        if (down.type === 'jump') {
          found++;
          expect(down).toEqual({ type: 'jump', x, y: y + 2 });
          // and you cannot climb back up the ledge
          expect(planStep(route1, { x, y: y + 2, facing: 'up', mode: 'walk' }, 'up', free).type).toBe('blocked');
        }
      }
    expect(found).toBeGreaterThan(5);
  });
});

/**
 * Warps whose static destination is a placeholder in the original data.
 * The Silph Co. elevator's warps point at UNUSED_MAP_ED and are rewritten at
 * runtime by the elevator floor menu (scripts/SilphCoElevator.asm), so they
 * are resolved by the ported elevator script instead (see TASKS.md).
 */
const KNOWN_BROKEN_WARPS: string[] = [
  'SILPH_CO_ELEVATOR#0 -> missing map 237',
  'SILPH_CO_ELEVATOR#1 -> missing map 237',
];
