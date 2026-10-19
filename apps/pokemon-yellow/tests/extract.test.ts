import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { c } from '../src/rom/constants';
import { opsToPlain } from '../src/rom/text';

describe.skipIf(!HAS_ROM)('ROM extraction', () => {
  it('reads Pallet Town', async () => {
    const b = await bundle();
    const m = b.maps[c('map', 'PALLET_TOWN')];
    expect([m.width, m.height, m.tileset]).toEqual([10, 9, c('tileset', 'OVERWORLD')]);
    expect(m.connections).toEqual({
      north: { map: c('map', 'ROUTE_1'), offset: 0 },
      south: { map: c('map', 'ROUTE_21'), offset: 0 },
    });
    expect(m.warps).toEqual([
      { x: 5, y: 5, destMap: c('map', 'REDS_HOUSE_1F'), destWarp: 0 },
      { x: 13, y: 5, destMap: c('map', 'BLUES_HOUSE'), destWarp: 0 },
      { x: 12, y: 11, destMap: c('map', 'OAKS_LAB'), destWarp: 1 },
    ]);
    expect(m.objects[0]).toMatchObject({ sprite: c('sprite', 'SPRITE_OAK'), x: 10, y: 4 });
    expect(m.music.id).toBe(c('music', 'MUSIC_PALLET_TOWN'));
    const girl = m.texts[2];
    expect(girl.kind).toBe('text');
    if (girl.kind === 'text') expect(opsToPlain(b.texts[girl.label])).toContain("I'm raising{line}{poke}MON too!");
  });

  it('reads Route 1 connection offset and wild data', async () => {
    const b = await bundle();
    const r1 = b.maps[c('map', 'ROUTE_1')];
    expect(r1.connections.north).toEqual({ map: c('map', 'VIRIDIAN_CITY'), offset: -5 });
    const wild = b.wild.grass[c('map', 'ROUTE_1')];
    expect(wild.rate).toBe(25);
    expect(wild.slots[0]).toEqual({ level: 3, species: c('pokemon', 'PIDGEY') });
    expect(wild.slots.map((s) => s.species)).toContain(c('pokemon', 'RATTATA'));
  });

  it('reads species, moves, items, types', async () => {
    const b = await bundle();
    const bulba = b.species[c('pokemon', 'BULBASAUR')];
    expect(bulba.dex).toBe(1);
    expect(bulba.baseStats).toEqual({ hp: 45, atk: 49, def: 49, spd: 45, spc: 65 });
    expect(bulba.evolutions).toEqual([{ method: 'level', level: 16, species: c('pokemon', 'IVYSAUR') }]);
    const pika = b.species[c('pokemon', 'PIKACHU')];
    expect(pika.name).toBe('PIKACHU');
    expect(pika.evolutions).toEqual([{ method: 'item', item: c('item', 'THUNDER_STONE'), minLevel: 1, species: c('pokemon', 'RAICHU') }]);
    const tbolt = b.moves[c('move', 'THUNDERBOLT') - 1];
    expect(tbolt).toMatchObject({ name: 'THUNDERBOLT', power: 95, type: c('type', 'ELECTRIC'), pp: 15 });
    expect(b.items.find((i) => i.id === c('item', 'POTION'))).toMatchObject({ name: 'POTION', price: 300 });
    expect(b.items.find((i) => i.id === c('item', 'TM_MEGA_PUNCH'))).toMatchObject({ name: 'TM01', price: 3000 });
    expect(b.types.chart[0]).toEqual([c('type', 'WATER'), c('type', 'FIRE'), 20]);
    expect(Object.keys(b.species)).toHaveLength(151);
    expect(Object.keys(b.dexEntries)).toHaveLength(151);
  });

  it('reads trainers', async () => {
    const b = await bundle();
    const brock = b.trainers[c('trainer', 'BROCK') - 1];
    expect(brock.name).toBe('BROCK');
    expect(brock.parties[0].mons).toEqual([
      { level: 10, species: c('pokemon', 'GEODUDE') },
      { level: 12, species: c('pokemon', 'ONIX') },
    ]);
    expect(brock.baseMoney).toBe(99);
  });

  it('decodes all text without failures', async () => {
    const b = await bundle();
    expect(Object.keys(b.texts).length).toBeGreaterThan(3000);
    for (const m of Object.values(b.maps))
      for (const t of Object.values(m.texts)) if (t.kind === 'text') expect(b.texts[t.label], `${m.constName} ${t.label}`).toBeDefined();
  });

  it('extracts walking sprites with 6 frames', async () => {
    const b = await bundle();
    const red = b.sprites.find((s) => s.id === c('sprite', 'SPRITE_RED'))!;
    expect(red.frames).toBe(6);
    const ball = b.sprites.find((s) => s.id === c('sprite', 'SPRITE_POKE_BALL'))!;
    expect(ball.frames).toBe(1);
  });
});
