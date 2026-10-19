/** Gen 1 party/box struct serialization. */
import { describe, expect, it } from 'vitest';
import { HAS_ROM, bundle } from './helpers';
import { makePartyMon } from '../src/game/pokemon';
import { c } from '../src/rom/constants';
import { BOX_DATA_LENGTH, PARTY_DATA_LENGTH, decodeBox, decodeMon, decodeParty, encodeBox, encodeMon, encodeParty } from '../src/game/gen1';

describe.skipIf(!HAS_ROM)('Gen 1 structs', () => {
  it('writes a party struct in the WRAM layout and reads it back', async () => {
    const b = await bundle();
    const pm = makePartyMon(b, { species: c('pokemon', 'PIKACHU'), level: 25, dvs: 0xa5c3, otId: 0x1234, otName: 'ASH' });
    pm.nickname = 'SPARKY';
    pm.statExp.atk = 0x0102;
    pm.exp = 0x012345;
    const bytes = encodeMon(pm, true);
    expect(bytes.length).toBe(44);
    expect(bytes[0]).toBe(c('pokemon', 'PIKACHU'));
    expect([bytes[12], bytes[13]]).toEqual([0x12, 0x34]);
    expect([bytes[14], bytes[15], bytes[16]]).toEqual([0x01, 0x23, 0x45]);
    expect([bytes[19], bytes[20]]).toEqual([0x01, 0x02]);
    expect([bytes[27], bytes[28]]).toEqual([0xa5, 0xc3]);
    expect(bytes[33]).toBe(25);
    expect(decodeMon(b, bytes, 'SPARKY', 'ASH')).toEqual(pm);
  });

  it('round-trips a party and a box with names', async () => {
    const b = await bundle();
    const mons = ['PIKACHU', 'NIDORAN_M', 'MR_MIME'].map((n, i) => {
      const m = makePartyMon(b, { species: c('pokemon', n), level: 10 + i, dvs: 0xffff, otId: 1, otName: 'RED' });
      return m;
    });
    const party = encodeParty(mons);
    expect(party.length).toBe(PARTY_DATA_LENGTH);
    expect(party[0]).toBe(3);
    expect(party[4]).toBe(0xff);
    expect(decodeParty(b, party).map((m) => [m.nickname, m.otName, m.level, m.maxHp])).toEqual(mons.map((m) => [m.nickname, m.otName, m.level, m.maxHp]));
    const box = encodeBox(mons);
    expect(box.length).toBe(BOX_DATA_LENGTH);
    // box structs carry no stats: they are recalculated on the way out
    expect(decodeBox(b, box).map((m) => [m.species, m.level, m.atk])).toEqual(mons.map((m) => [m.species, m.level, m.atk]));
  });
});
