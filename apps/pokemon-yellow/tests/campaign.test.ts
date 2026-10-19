/** Continuous world route: no checkpoint transport and no progression writes.
 * A declared combat-only fixture replaces the party after the Pokédex and
 * supplies healing stock. HMs are not usable by the driver before obtaining
 * their real items/badges. Wild encounters are disabled (separate battle tests).
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { RouteDriver } from './routeDriver';
import { newGameState } from '../src/game/state';
import { makeQaParty } from '../src/dev/presets';
import { makePartyMon, healMon } from '../src/game/pokemon';
import { c } from '../src/rom/constants';

describe.skipIf(!HAS_ROM)('continuous campaign input route', () => {
  it('walks from a fresh game through the story gates', async () => {
    const b = await bundle(), state = newGameState(b,0x5eed);
    state.options = { textSpeed:'fast', battleAnimation:false, battleStyle:'set' };
    const h = new RouteDriver(b,state);
    h.engine.ram.debugNoWildEncounters = true;
    const ev = (n: string) => h.store.event(n);
    const room = (slots=1) => {
      while(h.store.state.bag.length>20-slots) {
        const tm=h.store.state.bag.find((s)=>s.item>=c('item','TM01'));
        if(!tm)return h.diagnostic('No expendable TM for bag space');
        h.toss(b.items.find((i)=>i.id===tm.item)!.constName);
      }
    };
    h.run(30);
    h.go('PALLET_TOWN',10,1); h.walk('up');
    h.until(() => ev('EVENT_FOLLOWED_OAK_INTO_LAB') && ev('EVENT_OAK_ASKED_TO_CHOOSE_MON'));
    h.settle();
    h.go('OAKS_LAB',7,4); h.face('up'); h.press('a',4,6);
    h.until(() => h.engine.curScript === c('map_script','SCRIPT_OAKSLAB_RIVAL_CHALLENGES_PLAYER'));
    h.go('OAKS_LAB',h.p.x,6);
    h.until(() => ev('EVENT_BATTLED_RIVAL_IN_OAKS_LAB')); h.settle();
    h.go('VIRIDIAN_MART');
    h.until(() => ev('EVENT_GOT_OAKS_PARCEL')); h.settle();
    h.go('OAKS_LAB',5,3); h.face('up'); h.press('a',4,6);
    h.until(() => ev('EVENT_GOT_POKEDEX') && ev('EVENT_1ST_ROUTE22_RIVAL_BATTLE')); h.settle();
    h.mark('Pokédex');

    // The only gameplay fixture. It does not provide key items, money, badges,
    // map positions, quest flags, puzzle flags or trainer victory flags.
    const party = makeQaParty(b,h.p.id,h.p.name);
    for (const [species,moves] of [
      ['CHARIZARD',['CUT','FLY','STRENGTH','FLAMETHROWER']],
      ['NIDOKING',['SURF','STRENGTH','EARTHQUAKE','THUNDERBOLT']],
    ] as const) {
      const mon = makePartyMon(b,{species:c('pokemon',species),level:100,otId:h.p.id,otName:h.p.name,dvs:0xaaaa});
      mon.moves = moves.map((n) => c('move',n)) as [number,number,number,number]; healMon(b,mon); party.push(mon);
    }
    h.store.dispatch({type:'setParty',party},{undoable:false});
    h.store.dispatch({type:'setBag',bag:[{item:c('item','FULL_RESTORE'),qty:99},{item:c('item','MAX_ELIXER'),qty:99}]},{undoable:false});
    h.fixtures.push({frame:h.frames,party:structuredClone(h.store.state.party),bag:structuredClone(h.store.state.bag)});

    h.go('PEWTER_GYM'); h.talk(1);
    expect(ev('EVENT_BEAT_BROCK')).toBe(true); h.mark('Brock');
    h.go('MT_MOON_B2F'); h.talk(1);
    h.acceptMenus = true; h.talk(7); h.acceptMenus = false;
    expect(h.has('DOME_FOSSIL')).toBe(true); h.mark('Mt. Moon fossil');
    h.go('CERULEAN_GYM'); h.talk(1);
    expect(ev('EVENT_BEAT_MISTY')).toBe(true); h.mark('Misty');
    h.go('BILLS_HOUSE'); h.acceptMenus = true; h.talk(1);
    h.go('BILLS_HOUSE',1,5); h.face('up'); h.press('a',4,6);
    h.until(() => ev('EVENT_GOT_SS_TICKET')); h.settle(); h.acceptMenus = false;
    expect(ev('EVENT_USED_CELL_SEPARATOR_ON_BILL')).toBe(true); h.mark('Bill / S.S. Ticket');
    h.go('SS_ANNE_CAPTAINS_ROOM'); h.talk(1);
    expect(ev('EVENT_GOT_HM01')).toBe(true); h.mark('Captain / Cut');
    h.go('VERMILION_GYM');
    const cans = b.hidden.events[c('map','VERMILION_GYM')].filter((e) => e.fn === 'GymTrashScript');
    for (let tries = 0; tries < 50 && !ev('EVENT_2ND_LOCK_OPENED'); tries++) {
      const v = h.store.state.vars;
      const index = ev('EVENT_1ST_LOCK_OPENED') ? v.wSecondLockTrashCanIndex : v.wFirstLockTrashCanIndex;
      const can = cans.find((e) => e.arg === index) ?? cans[0];
      h.inspect(can.x,can.y);
    }
    expect(ev('EVENT_2ND_LOCK_OPENED')).toBe(true);
    h.talk(1); expect(ev('EVENT_BEAT_LT_SURGE')).toBe(true); h.mark('Surge / two trash locks');
    h.go('CERULEAN_CITY'); h.mark('Return to Cerulean');
    h.go('ROUTE_9'); h.go('ROCK_TUNNEL_1F'); h.go('LAVENDER_TOWN'); h.mark('Rock Tunnel');
    h.go('CELADON_GYM'); h.talk(1);
    expect(ev('EVENT_BEAT_ERIKA')).toBe(true); h.mark('Erika');
    h.go('CELADON_MART_ROOF',10,2); h.inspect(10,1);
    expect(h.has('FRESH_WATER')).toBe(true); h.mark('Vending drink');
    h.go('GAME_CORNER'); h.talk(11); h.inspect(9,4);
    expect(ev('EVENT_FOUND_ROCKET_HIDEOUT')).toBe(true); h.mark('Poster switch');
    h.go('ROCKET_HIDEOUT_B4F'); h.talk(4);
    expect(ev('EVENT_ROCKET_DROPPED_LIFT_KEY')).toBe(true); h.talk(9);
    expect(h.has('LIFT_KEY')).toBe(true); h.mark('Lift Key');
    h.go('ROCKET_HIDEOUT_ELEVATOR',1,2); h.face('up'); h.press('a',4,6);
    h.choose('B4F'); h.run(180); h.settle();
    h.go('ROCKET_HIDEOUT_B4F',24,15); h.walk('up'); h.settle();
    expect(ev('EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES')).toBe(true);
    h.talk(1); h.talk(8);
    expect(h.has('SILPH_SCOPE')).toBe(true); h.mark('Rocket Giovanni / Silph Scope');
    h.go('ROCKET_HIDEOUT_ELEVATOR',1,2); h.face('up'); h.press('a',4,6);
    h.choose('B1F'); h.run(180); h.settle();
    h.go('ROCKET_HIDEOUT_B1F'); h.talk(5);
    h.go('POKEMON_TOWER_7F'); h.talk(3);
    expect(ev('EVENT_BEAT_GHOST_MAROWAK')).toBe(true);
    expect(ev('EVENT_RESCUED_MR_FUJI')).toBe(true);
    h.talk(5); expect(h.has('POKE_FLUTE')).toBe(true); h.mark('Marowak / Fuji / Poké Flute');
    h.go('ROUTE_12',10,61); h.face('down'); h.bag('POKE_FLUTE');
    h.until(() => ev('EVENT_BEAT_ROUTE12_SNORLAX')); h.settle(); h.mark('Route 12 Snorlax');
    h.go('FUCHSIA_GYM'); h.talk(1);
    expect(ev('EVENT_BEAT_KOGA')).toBe(true); h.mark('Koga');
    h.acceptMenus = true; h.go('SAFARI_ZONE_SECRET_HOUSE'); h.talk(1);
    expect(h.has('HM_SURF')).toBe(true);
    h.go('SAFARI_ZONE_WEST'); h.talk(4);
    expect(h.has('GOLD_TEETH')).toBe(true);
    h.go('WARDENS_HOUSE'); h.acceptMenus = false; h.talk(1);
    expect(h.has('HM_STRENGTH')).toBe(true); h.mark('Safari HM03 / Gold Teeth / HM04');
    h.go('SILPH_CO_5F'); h.talk(8);
    expect(h.has('CARD_KEY')).toBe(true); h.mark('Card Key');
    h.go('SILPH_CO_11F',3,3); h.settle();
    expect(ev('EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES')).toBe(true);
    h.go('SILPH_CO_11F',6,14); h.talk(3);
    expect(ev('EVENT_BEAT_SILPH_CO_GIOVANNI')).toBe(true); h.mark('Silph Giovanni');
    h.go('SAFFRON_GYM'); h.talk(1);
    expect(ev('EVENT_BEAT_SABRINA')).toBe(true); h.mark('Sabrina');
    h.go('PALLET_TOWN'); h.mark('Return to Pallet');
    h.allowWater = true; h.go('CINNABAR_ISLAND'); h.mark('Surf Route 21');
    room(2);h.go('POKEMON_MANSION_B1F');room();h.talk(8);
    expect(h.has('SECRET_KEY')).toBe(true); h.mark('Mansion switches / Secret Key');
    room();
    h.go('CINNABAR_GYM');
    for(const quiz of b.hidden.events[c('map','CINNABAR_GYM')].filter((q)=>q.fn==='PrintCinnabarQuiz')) {
      h.go('CINNABAR_GYM',quiz.x,quiz.y+1);h.face('up');h.acceptMenus=(quiz.arg>>4)===0;
      h.press('a',4,6);h.settle();h.acceptMenus=false;
      expect(h.store.event(c('event','EVENT_CINNABAR_GYM_GATE0_UNLOCKED')+(quiz.arg&15))).toBe(true);
    }
    h.talk(1); expect(ev('EVENT_BEAT_BLAINE')).toBe(true); h.mark('Blaine / quiz gates');
    h.go('PALLET_TOWN',10,1); h.allowWater = false;
    room();
    h.go('VIRIDIAN_GYM'); h.talk(1);
    expect(ev('EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI')).toBe(true);
    expect(h.store.state.badges).toBe(255); h.mark('Giovanni / eight badges');
    h.allowWater=true;h.go('VICTORY_ROAD_1F');
    h.pushBoulder(17,13,'EVENT_VICTORY_ROAD_1_BOULDER_ON_SWITCH');
    h.go('VICTORY_ROAD_2F');h.pushBoulder(1,16,'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH1');
    h.go('VICTORY_ROAD_3F');h.pushBoulder(3,5,'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH1');
    h.pushBoulder(23,15,'EVENT_VICTORY_ROAD_3_BOULDER_ON_SWITCH2');
    h.walk('right');h.settle();expect(h.mapName).toBe('VICTORY_ROAD_2F');
    h.pushBoulder(9,16,'EVENT_VICTORY_ROAD_2_BOULDER_ON_SWITCH2');
    h.go('INDIGO_PLATEAU_LOBBY');h.mark('Victory Road / switches / floor drop');
    for(const [map,flag] of [
      ['LORELEIS_ROOM','EVENT_BEAT_LORELEIS_ROOM_TRAINER_0'],
      ['BRUNOS_ROOM','EVENT_BEAT_BRUNOS_ROOM_TRAINER_0'],
      ['AGATHAS_ROOM','EVENT_BEAT_AGATHAS_ROOM_TRAINER_0'],
      ['LANCES_ROOM','EVENT_BEAT_LANCE'],
    ] as const) {
      h.go(map);h.talk(1);expect(ev(flag)).toBe(true);h.mark(map);
    }
    let resets=0;h.engine.hooks.reset=()=>{resets++;};
    h.go('CHAMPIONS_ROOM',undefined,undefined,{stopOnWarp:true});
    for(let i=0;i<150000 && !resets;i++) {
      if(h.inBattle)h.finishBattle(100000);
      h.step();if(i%20===0)h.press('a',4,6);
      if(i%500===0)await new Promise((r)=>setTimeout(r,0)); // let the real IndexedDB save finish
    }
    expect(resets).toBe(1);
    expect(h.mapName).toBe('HALL_OF_FAME');
    expect(h.store.state.hallOfFame?.[0][0].species).toBe(c('pokemon','MEWTWO'));
    expect(h.store.state.objectVisible[c('toggle','TOGGLE_CERULEAN_CAVE_GUY')]).toBe(false);
    expect(ev('EVENT_BEAT_CHAMPION_RIVAL')).toBe(false); // original post-League reset
    expect(h.flagTrace.some((f)=>f.flag===c('event','EVENT_BEAT_CHAMPION_RIVAL') && f.value)).toBe(true);
    expect(h.log).toEqual([]);
    expect(h.inputs.reduce((n,r)=>n+r.frames,0)).toBe(h.frames);
    h.mark('Champion / Hall of Fame / credits / cave unlocked');
  },240000);
});
