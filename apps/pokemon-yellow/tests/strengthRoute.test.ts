/** Puzzle checkpoint fixture; all switches, pushes and the floor drop use input. */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { newGameState } from '../src/game/state';
import { makeQaParty } from '../src/dev/presets';
import { makePartyMon, healMon } from '../src/game/pokemon';
import { c } from '../src/rom/constants';
import { RouteDriver } from './routeDriver';

describe.skipIf(!HAS_ROM)('Victory Road real Strength route', () => {
  it('pushes the floor switches and drops the 3F boulder, then walks out', async () => {
    const b=await bundle(),s=newGameState(b,7);
    Object.assign(s.player,{map:c('map','VICTORY_ROAD_1F'),x:8,y:16,facing:'up',lastMap:c('map','ROUTE_23')});
    s.badges=255; s.options={textSpeed:'fast',battleAnimation:false,battleStyle:'set'};
    s.party=makeQaParty(b,s.player.id,s.player.name);
    const helper=makePartyMon(b,{species:c('pokemon','CHARIZARD'),level:100,dvs:0xffff,otId:s.player.id,otName:s.player.name});
    helper.moves=[c('move','STRENGTH'),c('move','FLAMETHROWER'),0,0];healMon(b,helper);s.party.push(helper);
    s.bag=[{item:c('item','HM_STRENGTH'),qty:1},{item:c('item','MAX_ELIXER'),qty:99},{item:c('item','FULL_RESTORE'),qty:99}];
    const h=new RouteDriver(b,s);h.engine.ram.debugNoWildEncounters=true;h.run(60);
    h.pushBoulder(17,13,'EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
    h.go('VICTORY_ROAD_2F'); h.pushBoulder(1,16,'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1');
    h.go('VICTORY_ROAD_3F'); h.pushBoulder(3,5,'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1');
    h.pushBoulder(23,15,'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2');
    expect([h.p.x,h.p.y]).toEqual([22,15]);h.walk('right');h.settle();
    expect(h.mapName).toBe('VICTORY_ROAD_2F');
    h.pushBoulder(9,16,'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2');
    h.go('INDIGO_PLATEAU_LOBBY');
    expect(h.mapName).toBe('INDIGO_PLATEAU_LOBBY');
    expect(h.log).toEqual([]);
  },120000);
});
