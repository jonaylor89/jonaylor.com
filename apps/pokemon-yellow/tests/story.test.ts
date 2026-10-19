/**
 * Continuous playthrough from a new game, driving the real engine with
 * simulated button presses. Each step continues from the previous one.
 * Battles run on the real battle engine; the harness fights them with A.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness, clearText, exitVia, pressUntil } from './harness';
import { c } from '../src/rom/constants';
import { newGameState } from '../src/game/state';

describe.skipIf(!HAS_ROM)('playthrough: new game to the Town Map', () => {
  let h: Harness;
  const ev = (n: string) => h.store.event(n);
  const labScript = () => h.store.state.mapScripts[c('map', 'OAKS_LAB')];
  const S = (n: string) => c('map_script', `SCRIPT_OAKSLAB_${n}`);
  const enterDoor = (x: number, y: number) => {
    expect(h.walkTo(x, y + 1)).toBe(true);
    h.walk('up');
    h.run(60);
  };
  /** Walk onto the exit mat and out; stepping on any exit warp counts. */
  const leaveBuilding = () => {
    const from = h.p.map;
    const w = h.engine.world.data.warps[0];
    h.walkTo(w.x, w.y);
    if (h.p.map === from) h.walk('down');
    h.run(60);
    expect(h.p.map).not.toBe(from);
  };


  beforeAll(async () => {
    h = new Harness(await bundle(), newGameState(await bundle(), 0x5eed));
    // this test follows the story flags; wild battles are covered by tests/battle.test.ts
    h.engine.ram.debugNoWildEncounters = true;
    h.run(30);
  });

  it('starts in the bedroom and walks out of the house', () => {
    expect(h.mapName).toBe('REDS_HOUSE_2F');
    expect(h.walkTo(7, 1)).toBe(true);
    h.run(40);
    expect(h.mapName).toBe('REDS_HOUSE_1F');
    leaveBuilding();
    expect(h.mapName).toBe('PALLET_TOWN');
    expect([h.p.x, h.p.y]).toEqual([5, 6]); // stepped out of the door
  });

  it('is stopped by Oak at the north exit and led to the lab', () => {
    expect(h.walkTo(10, 1)).toBe(true);
    h.walk('up');
    h.run(10);
    expect(ev('EVENT_OAK_APPEARED_IN_PALLET')).toBe(true);
    expect(h.waitUntil(() => h.screenText().includes('Wait'), 600)).toBe(true);
    expect(pressUntil(h, () => h.mapName === 'OAKS_LAB', 400)).toBe(true);
    expect(h.waitUntil(() => ev('EVENT_FOLLOWED_OAK_INTO_LAB'), 2000)).toBe(true);
    expect(pressUntil(h, () => labScript() === S('PLAYER_DONT_GO_AWAY_SCRIPT'), 200)).toBe(true);
    expect(ev('EVENT_OAK_ASKED_TO_CHOOSE_MON')).toBe(true);
  });

  it('cannot leave yet, then the rival takes the Eevee ball and Oak gives Pikachu', () => {
    // Walking south to y=6 makes Oak call the player back.
    expect(h.walkTo(5, 6)).toBe(true);
    expect(pressUntil(h, () => labScript() === S('PLAYER_DONT_GO_AWAY_SCRIPT') && h.p.y === 5, 100)).toBe(true);
    expect(h.walkTo(7, 4)).toBe(true);
    h.walk('up');
    h.run(10);
    h.press('a');
    expect(pressUntil(h, () => labScript() === S('RIVAL_CHALLENGES_PLAYER'), 400)).toBe(true);
    const pika = h.store.state.party[0];
    expect(pika).toMatchObject({ species: c('pokemon', 'PIKACHU'), level: 5, nickname: 'PIKACHU', catchRate: c('item', 'LIGHT_BALL_GSC') });
    expect(pika.moves.slice(0, 2)).toEqual([c('move', 'THUNDERSHOCK'), c('move', 'GROWL')]);
  });

  it('battles the rival on the way out; the rival leaves and Pikachu follows', () => {
    expect(h.walkTo(h.p.x, 6)).toBe(true);
    expect(pressUntil(h, () => labScript() === S('NOOP'), 400)).toBe(true);
    expect(ev('EVENT_BATTLED_RIVAL_IN_OAKS_LAB')).toBe(true);
    // Eevee evolves into Flareon later if the rival lost this battle, Vaporeon if he won
    const won = h.engine.ram.battleResult === 0;
    expect(h.store.state.vars.wRivalStarter).toBe(c('pokemon', won ? 'RIVAL_STARTER_FLAREON' : 'RIVAL_STARTER_VAPOREON'));
    expect(h.engine.sprites[c('object', 'OAKSLAB_RIVAL')].hidden).toBe(true);
    expect(h.engine.sprites[h.engine.pikachuSlot]?.pictureId).toBe(c('sprite', 'SPRITE_PIKACHU'));
    clearText(h);
  });

  it('picks up Oak\'s Parcel in the Viridian Mart', () => {
    leaveBuilding();
    expect(h.mapName).toBe('PALLET_TOWN');
    expect(exitVia(h, 'up')).toBe(true);
    expect(h.mapName).toBe('ROUTE_1');
    expect(exitVia(h, 'up')).toBe(true);
    expect(h.mapName).toBe('VIRIDIAN_CITY');
    const mart = h.engine.world.data.warps.find((w) => h.bundle.maps[w.destMap]?.constName === 'VIRIDIAN_MART')!;
    enterDoor(mart.x, mart.y);
    expect(h.mapName).toBe('VIRIDIAN_MART');
    expect(pressUntil(h, () => ev('EVENT_GOT_OAKS_PARCEL'))).toBe(true);
    clearText(h);
    expect(h.store.state.bag.some((s) => s.item === c('item', 'OAKS_PARCEL'))).toBe(true);
  });

  it('delivers the parcel and receives the Pokédex', () => {
    leaveBuilding();
    expect(exitVia(h, 'down')).toBe(true);
    expect(h.mapName).toBe('ROUTE_1');
    expect(exitVia(h, 'down')).toBe(true);
    expect(h.mapName).toBe('PALLET_TOWN');
    enterDoor(12, 11);
    expect(h.mapName).toBe('OAKS_LAB');
    expect(h.walkTo(5, 3)).toBe(true);
    h.walk('up');
    h.run(10);
    h.press('a');
    expect(pressUntil(h, () => ev('EVENT_GOT_POKEDEX'), 400)).toBe(true);
    expect(pressUntil(h, () => ev('EVENT_1ST_ROUTE22_RIVAL_BATTLE'), 400)).toBe(true);
    clearText(h);
    expect(h.store.state.bag.some((s) => s.item === c('item', 'OAKS_PARCEL'))).toBe(false);
    expect(h.store.state.mapScripts[c('map', 'VIRIDIAN_CITY')]).toBe(c('map_script', 'SCRIPT_VIRIDIANCITY_AFTER_POKEDEX'));
  });

  it('gets the Town Map from Daisy', () => {
    leaveBuilding();
    expect(h.mapName).toBe('PALLET_TOWN');
    enterDoor(13, 5);
    expect(h.mapName).toBe('BLUES_HOUSE');
    const daisy = h.engine.sprites[1];
    expect(h.walkTo(daisy.mapX, daisy.mapY + 1)).toBe(true);
    h.walk('up');
    h.run(10);
    h.press('a');
    expect(pressUntil(h, () => ev('EVENT_GOT_TOWN_MAP'), 200)).toBe(true);
    clearText(h);
    expect(h.store.state.bag.some((s) => s.item === c('item', 'TOWN_MAP'))).toBe(true);
  });
});
