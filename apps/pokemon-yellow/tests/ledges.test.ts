import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { newGameState } from '../src/game/state';
import { WorldMap } from '../src/world/WorldMap';
import { c } from '../src/rom/constants';
import { planStep } from '../src/world/movement';

describe.skipIf(!HAS_ROM)('ledge-hop input ownership', () => {
  it('lands exactly two squares away, exhausts simulated input, and restores collision', async () => {
    const b = await bundle(), state = newGameState(b,7), w = new WorldMap(b,c('map','ROUTE_1'));
    let point: [number,number] | undefined;
    for (let y=1;y<w.heightSquares-3 && !point;y++) for (let x=1;x<w.widthSquares-1;x++) {
      const p = planStep(w,{x,y,facing:'down',mode:'walk'},'down',{scripted:false,isOccupied:()=>false});
      if (p.type === 'jump' && !w.data.objects.some((o) => o.x === x && Math.abs(o.y-y) <= 3)) { point=[x,y]; break; }
    }
    expect(point).toBeDefined();
    const [x,y] = point!;
    Object.assign(state.player,{map:w.data.id,x,y,facing:'down'});
    const h = new Harness(b,state); h.engine.ram.debugNoWildEncounters=true; h.run(40);
    h.walk('down'); h.run(120);
    expect([h.p.x,h.p.y]).toEqual([x,y+2]);
    expect(h.engine.ram.simulatedIndex).toBe(0);
    expect(h.engine.ram.scriptedMovementState).toBe(false);
    expect(h.engine.ram.ledgeOrFishing).toBe(false);
    expect(h.engine.ram.joyIgnore).toBe(0);
    h.walk('up'); h.run(30);
    expect([h.p.x,h.p.y]).toEqual([x,y+2]);
  });
});
