/** Progression integration audit. Checkpoint transport is explicit: these are
 * NOT a claim of an uninterrupted input-only world route. Leaders and the
 * League use real battles; no badge/reward/quest flags are written by tests.
 */
import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { clearText, Harness, pressUntil } from './harness';
import { c } from '../src/rom/constants';
import { newGameState } from '../src/game/state';
import { makePartyMon, healMon } from '../src/game/pokemon';
import { makeQaParty } from '../src/dev/presets';

const GYMS = [
  ['PEWTER_GYM', 'BOULDER', 'EVENT_BEAT_BROCK', 'EVENT_GOT_TM34', 'TM_BIDE'],
  ['CERULEAN_GYM', 'CASCADE', 'EVENT_BEAT_MISTY', 'EVENT_GOT_TM11', 'TM_BUBBLEBEAM'],
  ['VERMILION_GYM', 'THUNDER', 'EVENT_BEAT_LT_SURGE', 'EVENT_GOT_TM24', 'TM_THUNDERBOLT'],
  ['CELADON_GYM', 'RAINBOW', 'EVENT_BEAT_ERIKA', 'EVENT_GOT_TM21', 'TM_MEGA_DRAIN'],
  ['FUCHSIA_GYM', 'SOUL', 'EVENT_BEAT_KOGA', 'EVENT_GOT_TM06', 'TM_TOXIC'],
  ['SAFFRON_GYM', 'MARSH', 'EVENT_BEAT_SABRINA', 'EVENT_GOT_TM46', 'TM_PSYWAVE'],
  ['CINNABAR_GYM', 'VOLCANO', 'EVENT_BEAT_BLAINE', 'EVENT_GOT_TM38', 'TM_FIRE_BLAST'],
  ['VIRIDIAN_GYM', 'EARTH', 'EVENT_BEAT_VIRIDIAN_GYM_GIOVANNI', 'EVENT_GOT_TM27', 'TM_FISSURE'],
] as const;
const has = (h: Harness, name: string) => h.store.state.bag.some((s) => s.item === c('item', name));
function heal(h: Harness) {
  const party = structuredClone(h.store.state.party);
  for (const m of party) healMon(h.bundle, m);
  h.store.dispatch({ type: 'setParty', party }, { undoable: false });
}
async function setup(seed = 7) {
  const b = await bundle(), state = newGameState(b, seed);
  // Combat-only QA fixture: progression flags/badges/rewards start empty.
  state.party = makeQaParty(b, state.player.id, state.player.name);
  state.options = { textSpeed: 'fast', battleAnimation: false, battleStyle: 'set' };
  state.vars.wPlayerStarter = c('pokemon', 'PIKACHU');
  state.vars.wRivalStarter = c('pokemon', 'RIVAL_STARTER_JOLTEON');
  const h = new Harness(b, state); h.run(30); return h;
}
function visit(h: Harness, map: string, x: number, y: number, facing: 'up' | 'left' | 'right' | 'down' = 'up') {
  h.engine.teleport(c('map', map), x, y);
  h.store.dispatch({ type: 'face', facing }, { undoable: false });
  h.engine.ram.debugNoWildEncounters = true;
  h.run(40);
}
function talkToLeader(h: Harness, map: string) {
  const m = h.bundle.maps[c('map', map)], leader = m.objects[0];
  visit(h, map, leader.x, leader.y + 1);
  h.press('a', 2, 10);
}
function finishUntil(h: Harness, pred: () => boolean, max = 800) {
  for (let i = 0; i < max && !pred(); i++) {
    if (h.inBattle) h.finishBattle(80000);
    h.press('a', 2, 8);
  }
  if (!pred()) throw new Error(`${h.mapName} (${h.p.x},${h.p.y}) ${h.p.facing} script ${h.engine.curScript} joyIgnore=${h.engine.ram.joyIgnore}\n${JSON.stringify(h.engine.sprites[1])}\n${h.screenText()}`);
}

describe.skipIf(!HAS_ROM)('eight badges → real League → post-game (checkpoint audit)', () => {
  let h: Harness;
  beforeAll(async () => { h = await setup(); });
  for (const [index, [map, badge, beat, reward, item]] of GYMS.entries()) {
    it(`earns ${badge} through the leader battle, with exactly the original reward flags`, () => {
      expect(h.store.state.badges).toBe((1 << index) - 1);
      expect(h.store.event(beat)).toBe(false);
      expect(h.store.event(reward)).toBe(false);
      heal(h);
      talkToLeader(h, map);
      finishUntil(h, () => h.store.event(reward));
      clearText(h);
      expect(h.store.state.badges).toBe((1 << (index + 1)) - 1);
      expect(h.store.state.vars.wBeatGymFlags & (1 << index)).not.toBe(0);
      expect(h.store.event(beat)).toBe(true);
      expect(has(h, item)).toBe(true);
      expect(h.store.state.objectVisible[c('toggle', 'TOGGLE_CERULEAN_CAVE_GUY')]).toBe(true);
      // The badge isn't farmable: another conversation doesn't give another TM.
      const count = h.store.state.bag.find((s) => s.item === c('item', item))!.qty;
      h.press('a', 2, 10); clearText(h);
      expect(h.store.state.bag.find((s) => s.item === c('item', item))!.qty).toBe(count);
    });
  }

  it('walks the actual League rooms, fights all five trainers, records the team, reaches credits and unlocks the cave', async () => {
    let resets = 0;
    h.engine.hooks.reset = () => { resets++; };
    heal(h);
    visit(h, 'INDIGO_PLATEAU_LOBBY', 8, 2);
    expect(h.walkTo(8, 0)).toBe(true);
    h.run(200);
    const rooms = [
      ['LORELEIS_ROOM', 'EVENT_BEAT_LORELEIS_ROOM_TRAINER_0'],
      ['BRUNOS_ROOM', 'EVENT_BEAT_BRUNOS_ROOM_TRAINER_0'],
      ['AGATHAS_ROOM', 'EVENT_BEAT_AGATHAS_ROOM_TRAINER_0'],
      ['LANCES_ROOM', 'EVENT_BEAT_LANCE'],
    ] as const;
    for (const [map, event] of rooms) {
      expect(h.mapName).toBe(map);
      heal(h);
      // Approach from the room's original autowalk endpoint, using real input.
      if (!h.store.event(event)) {
        const leader = h.engine.world.data.objects[0];
        const targets = [[leader.x, leader.y + 1, 'up'], [leader.x - 1, leader.y, 'right'], [leader.x + 1, leader.y, 'left'], [leader.x, leader.y - 1, 'down']] as const;
        const target = targets.find(([x, y]) => h.findPath(x, y));
        if (!target) throw new Error(`No path to ${map}: ${Array.from({ length: h.engine.world.heightSquares }, (_, y) => Array.from({ length: h.engine.world.widthSquares }, (_, x) => h.engine.world.isSquarePassable(x, y) ? '.' : '#').join('')).join('\n')}`);
        for (let step = 0; step < 300 && !h.store.event(event); step++) {
          if (h.inBattle) { h.finishBattle(80000); continue; }
          if (h.textBoxOpen()) { clearText(h); continue; }
          if (h.p.x === target[0] && h.p.y === target[1]) break;
          const path = h.findPath(target[0], target[1]);
          if (!path?.length) break;
          h.walk(path[0]); h.run(4);
        }
        if (!h.store.event(event)) { h.press(target[2], 4, 16); h.press('a', 2, 10); }
      }
      finishUntil(h, () => h.store.event(event));
      clearText(h, 120);
      expect(h.store.event(event)).toBe(true);
      const exit = h.engine.world.data.warps.find((w) => w.y === 0)!;
      expect(h.walkTo(exit.x, exit.y)).toBe(true);
      h.run(200);
    }
    expect(h.mapName).toBe('CHAMPIONS_ROOM');
    heal(h);
    for (let i = 0; i < 100000 && !resets; i++) {
      if (h.inBattle) h.finishBattle(80000);
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
      if (i % 500 === 0) await new Promise((r) => setTimeout(r, 0)); // IndexedDB writes during Hall of Fame
    }
    expect(resets).toBe(1);
    expect(h.mapName).toBe('HALL_OF_FAME');
    expect(h.store.state.hallOfFame?.[0][0].species).toBe(c('pokemon', 'MEWTWO'));
    expect(h.store.state.vars.wLastBlackoutMap).toBe(c('map', 'PALLET_TOWN'));
    expect(h.store.event('EVENT_BEAT_CHAMPION_RIVAL')).toBe(false); // original League reset
    expect(h.store.state.objectVisible[c('toggle', 'TOGGLE_CERULEAN_CAVE_GUY')]).toBe(false);
    expect(h.log).toEqual([]);
  }, 30000);

  it('fights Mewtwo after the Hall of Fame and keeps its one-time disappearance', () => {
    heal(h);
    h.store.state.options.battleAnimation = false;
    visit(h, 'CERULEAN_CAVE_B1F', 27, 14);
    h.press('a', 2, 10);
    expect(pressUntil(h, () => h.inBattle, 300)).toBe(true);
    h.finishBattle(80000); clearText(h, 120);
    expect(h.store.state.objectVisible[c('toggle', 'TOGGLE_MEWTWO')]).toBe(false);
    visit(h, 'CERULEAN_CAVE_B1F', 27, 14);
    expect(h.engine.sprites.find((s) => s?.obj?.index === 1)?.hidden).toBe(true);
  });
});

function pickup(h: Harness, map: string, item: string) {
  const ball = h.bundle.maps[c('map', map)].objects.find((o) => o.kind === 'item' && o.item === c('item', item))!;
  if (!ball) throw new Error(`No ${item} on ${map}`);
  visit(h, map, ball.x, ball.y + 1);
  h.press('a', 2, 10);
  finishUntil(h, () => has(h, item));
  clearText(h);
}

describe.skipIf(!HAS_ROM)('causal key-item story gates (checkpoint transport only)', () => {
  it('helps Bill using the actual PC, receives the ticket, then earns HM01 from the captain', async () => {
    const h = await setup(21);
    visit(h, 'BILLS_HOUSE', 6, 6);
    expect(has(h, 'S_S_TICKET')).toBe(false);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_BILL_SAID_USE_CELL_SEPARATOR'));
    clearText(h);
    expect(h.walkTo(1, 5)).toBe(true);
    h.press('up', 4, 16); h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_GOT_SS_TICKET'));
    clearText(h);
    expect(h.store.event('EVENT_USED_CELL_SEPARATOR_ON_BILL')).toBe(true);
    expect(h.store.event('EVENT_MET_BILL_2')).toBe(true);
    expect(has(h, 'S_S_TICKET')).toBe(true);
    expect(h.store.state.objectVisible[c('toggle', 'TOGGLE_CERULEAN_GUARD_1')]).toBe(true);
    visit(h, 'SS_ANNE_CAPTAINS_ROOM', 4, 3, 'up');
    // Use the ROM captain position rather than relying on a hard-coded facing.
    const captain = h.engine.world.data.objects[0];
    visit(h, 'SS_ANNE_CAPTAINS_ROOM', captain.x, captain.y + 1);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_GOT_HM01'));
    clearText(h);
    expect(h.store.event('EVENT_RUBBED_CAPTAINS_BACK')).toBe(true);
    expect(has(h, 'HM_CUT')).toBe(true);
    expect(h.log).toEqual([]);
  });

  it('gets HM03 and Gold Teeth in the Safari Zone, then exchanges the teeth for HM04 exactly once', async () => {
    const h = await setup(22);
    visit(h, 'WARDENS_HOUSE', 2, 4);
    h.press('a', 2, 10); clearText(h);
    expect(has(h, 'HM_STRENGTH')).toBe(false);
    visit(h, 'SAFARI_ZONE_SECRET_HOUSE', 3, 4);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_GOT_HM03'));
    clearText(h);
    expect(has(h, 'HM_SURF')).toBe(true);
    pickup(h, 'SAFARI_ZONE_WEST', 'GOLD_TEETH');
    visit(h, 'WARDENS_HOUSE', 2, 4);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_GOT_HM04'));
    clearText(h);
    expect(has(h, 'GOLD_TEETH')).toBe(false);
    expect(has(h, 'HM_STRENGTH')).toBe(true);
    expect(h.store.event('EVENT_GAVE_GOLD_TEETH')).toBe(true);
    h.press('a', 2, 10); clearText(h);
    expect(h.store.state.bag.find((s) => s.item === c('item', 'HM_STRENGTH'))!.qty).toBe(1);
    expect(h.log).toEqual([]);
  });

  it('keeps Cinnabar Gym locked until the Secret Key has really been picked up', async () => {
    const h = await setup(23);
    visit(h, 'CINNABAR_ISLAND', 18, 5);
    h.walk('up'); clearText(h); h.run(60);
    expect(h.mapName).toBe('CINNABAR_ISLAND');
    expect(h.p.y).toBe(5);
    pickup(h, 'POKEMON_MANSION_B1F', 'SECRET_KEY');
    visit(h, 'CINNABAR_ISLAND', 18, 5);
    expect(h.waitUntil(() => h.mapName === 'CINNABAR_GYM', 400, ['up'])).toBe(true);
    expect(has(h, 'SECRET_KEY')).toBe(true); // not consumed by the door
    expect(h.log).toEqual([]);
  });

  it('earns the Lift Key and Scope from Team Rocket, frees Fuji and uses the flute to remove Snorlax', async () => {
    const h = await setup(24);
    visit(h, 'ROCKET_HIDEOUT_B4F', 11, 3);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_ROCKET_DROPPED_LIFT_KEY'));
    clearText(h);
    pickup(h, 'ROCKET_HIDEOUT_B4F', 'LIFT_KEY');
    visit(h, 'ROCKET_HIDEOUT_B4F', 24, 15);
    h.walk('up');
    finishUntil(h, () => h.store.event('EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES'));
    clearText(h);
    visit(h, 'ROCKET_HIDEOUT_B4F', 25, 4);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_BEAT_ROCKET_HIDEOUT_GIOVANNI'));
    clearText(h); h.run(100);
    pickup(h, 'ROCKET_HIDEOUT_B4F', 'SILPH_SCOPE');
    heal(h);
    visit(h, 'POKEMON_TOWER_6F', 10, 17);
    h.walk('up');
    finishUntil(h, () => h.store.event('EVENT_BEAT_GHOST_MAROWAK'));
    clearText(h);
    visit(h, 'POKEMON_TOWER_7F', 10, 13);
    h.walk('up');
    finishUntil(h, () => h.store.event('EVENT_BEAT_POKEMONTOWER_7_JESSIE_JAMES'));
    clearText(h);
    visit(h, 'POKEMON_TOWER_7F', 10, 4);
    h.press('a', 2, 10);
    finishUntil(h, () => h.mapName === 'MR_FUJIS_HOUSE');
    clearText(h);
    expect(h.store.event('EVENT_RESCUED_MR_FUJI')).toBe(true);
    const fuji = h.engine.sprites[c('object', 'MRFUJISHOUSE_MR_FUJI')];
    visit(h, 'MR_FUJIS_HOUSE', fuji.mapX, fuji.mapY + 1);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_GOT_POKE_FLUTE'));
    clearText(h);
    expect(has(h, 'POKE_FLUTE')).toBe(true);
    visit(h, 'ROUTE_12', 10, 63);
    h.press('start', 2, 10); h.press('down', 2, 8); h.press('a', 2, 20); // ITEM, no Pokédex in this checkpoint fixture
    const index = h.store.state.bag.findIndex((s) => s.item === c('item', 'POKE_FLUTE'));
    for (let i = 0; i < index; i++) h.press('down', 2, 6);
    h.press('a', 2, 10); h.press('a', 2, 20); // select / USE
    finishUntil(h, () => h.store.event('EVENT_BEAT_ROUTE12_SNORLAX'));
    clearText(h);
    expect(h.store.state.objectVisible[c('toggle', 'TOGGLE_ROUTE_12_SNORLAX')]).toBe(false);
    expect(h.log).toEqual([]);
  });

  it('picks up the Card Key, opens a real door, beats Silph’s Rocket pair and Giovanni and removes the city blockade', async () => {
    const h = await setup(25);
    visit(h, 'SILPH_CO_2F', 5, 5);
    h.press('a', 2, 10); clearText(h);
    expect(h.store.event('EVENT_SILPH_CO_2_UNLOCKED_DOOR1')).toBe(false);
    pickup(h, 'SILPH_CO_5F', 'CARD_KEY');
    visit(h, 'SILPH_CO_2F', 5, 5);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_SILPH_CO_2_UNLOCKED_DOOR1'));
    clearText(h);
    visit(h, 'SILPH_CO_11F', 3, 3);
    finishUntil(h, () => h.store.event('EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES'));
    clearText(h); heal(h);
    visit(h, 'SILPH_CO_11F', 6, 14);
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_SILPH_CO_11_UNLOCKED_DOOR'));
    clearText(h);
    h.walk('up');
    finishUntil(h, () => h.store.event('EVENT_BEAT_SILPH_CO_GIOVANNI'));
    clearText(h);
    expect(h.store.state.objectVisible[c('toggle', 'TOGGLE_SAFFRON_CITY_1')]).toBe(false);
    expect(h.store.state.objectVisible[c('toggle', 'TOGGLE_SAFFRON_CITY_8')]).toBe(true);
    expect(h.log).toEqual([]);
  });

  for (const [index, y] of [136, 119, 105, 96, 85, 56, 35].entries()) {
    it(`Route 23 guard ${index + 1} refuses the missing badge, then records the right badge once`, async () => {
      const h = await setup(31 + index);
      const event = c('event', 'EVENT_PASSED_CASCADEBADGE_CHECK') + index;
      h.store.state.player.mode = 'surf'; // guard fixtures include the two water lanes
      h.store.state.badges = (1 << (index + 1)) - 1;
      visit(h, 'ROUTE_23', 7, y);
      clearText(h); h.run(40);
      expect(h.store.state.eventFlags[event >> 3] & (1 << (event & 7))).toBe(0);
      h.store.state.badges |= 1 << (index + 1);
      visit(h, 'ROUTE_23', 7, y);
      finishUntil(h, () => !!(h.store.state.eventFlags[event >> 3] & (1 << (event & 7))));
      clearText(h);
      expect(h.store.state.eventFlags[event >> 3] & (1 << (event & 7))).not.toBe(0);
      expect(h.log).toEqual([]);
    });
  }
});

describe.skipIf(!HAS_ROM)('badge negative/retry paths', () => {
  it('awards the badge with a full bag, defers the TM and gives it once when room is made', async () => {
    const h = await setup(17);
    const fillers = h.bundle.items.filter((i) => i.id > 0 && i.id < 80 && !['COIN', 'SAFARI_BALL'].includes(i.constName)).slice(0, 20);
    h.store.state.bag = fillers.map((i) => ({ item: i.id, qty: 1 }));
    talkToLeader(h, 'PEWTER_GYM');
    finishUntil(h, () => h.store.state.badges === 1);
    clearText(h);
    expect(h.store.event('EVENT_BEAT_BROCK')).toBe(true);
    expect(h.store.event('EVENT_GOT_TM34')).toBe(false);
    h.store.dispatch({ type: 'setBag', bag: [] }, { undoable: false });
    h.press('a', 2, 10);
    finishUntil(h, () => h.store.event('EVENT_GOT_TM34'));
    clearText(h);
    expect(h.store.state.badges).toBe(1);
    expect(has(h, 'TM_BIDE')).toBe(true);
  });

  it('does not award a badge or TM after a real loss', async () => {
    const h = await setup(13), s = h.store.state;
    s.party = [makePartyMon(h.bundle, { species: c('pokemon', 'MAGIKARP'), level: 5, dvs: 0, otId: s.player.id, otName: s.player.name })];
    talkToLeader(h, 'PEWTER_GYM');
    finishUntil(h, () => h.inBattle);
    h.finishBattle(80000); clearText(h);
    expect(h.store.state.badges).toBe(0);
    expect(h.store.event('EVENT_BEAT_BROCK')).toBe(false);
    expect(h.store.event('EVENT_GOT_TM34')).toBe(false);
  });
});
