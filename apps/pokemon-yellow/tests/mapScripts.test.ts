/**
 * Map scripts ported from scripts/*.asm, driven through the real overworld.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { HAS_ROM } from './helpers';
import { clearText, type Harness } from './harness';
import { c } from '../src/rom/constants';
import { fieldAt } from './fieldHelpers';
import type { GbBattleHost } from '../src/battle/host';
import { makePartyMon } from '../src/game/pokemon';
import { readSave } from '../src/game/save';

const I = (n: string) => c('item', n);

/** Walk one square, then let any script text and simulated steps play out. */
function stepAndSettle(h: Harness, dir: 'up' | 'down' | 'left' | 'right'): void {
  h.walk(dir);
  for (let i = 0; i < 6; i++) {
    clearText(h);
    h.run(30);
  }
}

describe.skipIf(!HAS_ROM)('Saffron gates', () => {
  it('the thirsty guard turns the player back', async () => {
    const h = await fieldAt('ROUTE_5_GATE', 3, 2, 'down');
    stepAndSettle(h, 'down');
    expect(h.engine.state.player.y).toBe(2);
    expect(h.engine.state.vars.wStatusFlags1 ?? 0).toBe(0);
  });

  it('a drink lets the player through for good', async () => {
    const h = await fieldAt('ROUTE_5_GATE', 3, 2, 'down', (s) => (s.bag = [{ item: I('LEMONADE'), qty: 1 }]));
    stepAndSettle(h, 'down');
    expect(h.engine.state.player.y).toBe(3);
    expect(h.engine.state.bag.some((s) => s.item === I('LEMONADE'))).toBe(false);
    expect((h.engine.state.vars.wStatusFlags1 ?? 0) & (1 << c('ram', 'BIT_GAVE_SAFFRON_GUARDS_DRINK'))).toBeTruthy();
  });
});

describe.skipIf(!HAS_ROM)('Cycling Road gate', () => {
  it('stops pedestrians and walks them back', async () => {
    const h = await fieldAt('ROUTE_16_GATE_1F', 3, 8, 'right');
    stepAndSettle(h, 'right');
    expect(h.engine.state.player.x).toBe(5);
    expect(h.engine.state.player.y).toBe(7);
  });

  it('lets cyclists through', async () => {
    const h = await fieldAt('ROUTE_16_GATE_1F', 3, 8, 'right', (s) => (s.bag = [{ item: I('BICYCLE'), qty: 1 }]));
    stepAndSettle(h, 'right');
    expect(h.engine.state.player).toMatchObject({ x: 4, y: 8 });
  });
});

describe.skipIf(!HAS_ROM)('The road to the League', () => {
  it("Route 22's gate needs the BOULDERBADGE", async () => {
    const h = await fieldAt('ROUTE_22_GATE', 4, 3, 'up');
    stepAndSettle(h, 'up');
    expect(h.engine.state.player.y).toBe(3);
    const ok = await fieldAt('ROUTE_22_GATE', 4, 3, 'up', (s) => (s.badges = 1 << c('ram', 'BIT_BOULDERBADGE')));
    stepAndSettle(ok, 'up');
    expect(ok.engine.state.player.y).toBe(2);
    expect(ok.walk('up')).toBe(true);
  });

  it("Route 23's guards check each badge once", async () => {
    const h = await fieldAt('ROUTE_23', 7, 137, 'up');
    stepAndSettle(h, 'up');
    expect(h.engine.state.player.y).toBe(137);
    const ok = await fieldAt('ROUTE_23', 7, 137, 'up', (s) => (s.badges = 1 << c('ram', 'BIT_CASCADEBADGE')));
    stepAndSettle(ok, 'up');
    expect(ok.engine.state.player.y).toBe(136);
    expect(ok.engine.env.checkEvent('EVENT_PASSED_CASCADEBADGE_CHECK')).toBe(true);
  });
});

describe.skipIf(!HAS_ROM)('Elevators', () => {
  it('the Celadon Mart elevator takes the player to the chosen floor', async () => {
    // come in from 1F's elevator door, then use the panel
    const h = await fieldAt('CELADON_MART_1F', 1, 2, 'up');
    expect(h.walk('up')).toBe(true);
    h.run(60);
    expect(h.engine.state.player.map).toBe(c('map', 'CELADON_MART_ELEVATOR'));
    // the panel is the sign at (3,0); stand below it facing up
    h.engine.store.dispatch({ type: 'setPosition', map: c('map', 'CELADON_MART_ELEVATOR'), x: 3, y: 1, facing: 'up' }, { undoable: false });
    h.run(5);
    h.press('up', 2, 10);
    h.press('a', 2, 30);
    for (let i = 0; i < 6 && !h.screenText().includes('3F'); i++) h.press('a', 2, 20);
    h.press('down', 2, 6);
    h.press('down', 2, 6); // 3F
    h.press('a', 2, 10);
    // the shake and the chime
    h.run(400);
    clearText(h);
    // out through the door
    h.engine.store.dispatch({ type: 'setPosition', map: c('map', 'CELADON_MART_ELEVATOR'), x: 1, y: 2, facing: 'down' }, { undoable: false });
    h.run(5);
    h.walk('down');
    h.run(60);
    expect(h.engine.state.player.map).toBe(c('map', 'CELADON_MART_3F'));
  });
});

describe.skipIf(!HAS_ROM)('Snorlax', () => {
  it('wakes up after the POKé FLUTE and fights', async () => {
    const h = await fieldAt('ROUTE_12', 10, 63, 'up', (s) => {
      s.eventFlags[c('event', 'EVENT_FIGHT_ROUTE12_SNORLAX') >> 3] |= 1 << (c('event', 'EVENT_FIGHT_ROUTE12_SNORLAX') & 7);
    });
    let enemy = 0;
    for (let i = 0; i < 600 && !enemy; i++) {
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
      enemy = (h.engine.battleHost as GbBattleHost).current?.enemy.mon.species ?? 0;
    }
    expect(enemy).toBe(c('pokemon', 'SNORLAX'));
    expect(h.engine.state.objectVisible[c('toggle', 'TOGGLE_ROUTE_12_SNORLAX')]).toBe(false);
  });
});

describe.skipIf(!HAS_ROM)('Seafoam Islands', () => {
  it('a boulder pushed onto a hole drops to the floor below', async () => {
    const h = await fieldAt('SEAFOAM_ISLANDS_1F', 20, 8, 'up');
    const slot = h.engine.sprites.findIndex((s) => s?.pictureId === c('sprite', 'SPRITE_BOULDER'));
    const boulder = h.engine.sprites[slot];
    boulder.mapX = 17;
    boulder.mapY = 6;
    h.engine.ram.boulderSpriteIndex = slot;
    h.engine.ram.pushedBoulder = true;
    h.run(10);
    const v = h.engine.state.objectVisible;
    expect(h.engine.env.checkEvent('EVENT_SEAFOAM1_BOULDER1_DOWN_HOLE')).toBe(true);
    expect(v[c('toggle', 'TOGGLE_SEAFOAM_ISLANDS_1F_BOULDER_1')]).toBe(false);
    expect(v[c('toggle', 'TOGGLE_SEAFOAM_ISLANDS_B1F_BOULDER_1')]).toBe(true);
  });

  it('the holes drop the player to the next floor', async () => {
    const h = await fieldAt('SEAFOAM_ISLANDS_1F', 17, 7, 'up');
    h.walk('up');
    for (let i = 0; i < 400 && h.engine.state.player.map !== c('map', 'SEAFOAM_ISLANDS_B1F'); i++) h.step();
    h.run(100);
    expect(h.engine.state.player.map).toBe(c('map', 'SEAFOAM_ISLANDS_B1F'));
  });
});

describe.skipIf(!HAS_ROM)('Spinner tiles', () => {
  it("Viridian Gym's arrows slide the player, spinning", async () => {
    // (19,11) slides up 9 squares
    const h = await fieldAt('VIRIDIAN_GYM', 19, 12, 'up', (s) => (s.badges = 0x7f));
    h.walk('up');
    const facings = new Set<string>();
    const arrows = new Set<boolean | undefined>();
    for (let i = 0; i < 400 && h.engine.state.player.y > 2; i++) {
      h.step();
      facings.add(h.engine.state.player.facing);
      arrows.add(h.engine.ram.spinnerArrowsAnimated);
    }
    // LoadSpinnerArrowTiles alternates the arrow graphics
    expect(arrows.has(true) && arrows.has(false)).toBe(true);
    h.run(30);
    expect(h.engine.state.player).toMatchObject({ x: 19, y: 2 });
    expect(facings.size).toBe(4);
    expect(h.engine.ram.spinning).toBe(false);
  });
});

describe.skipIf(!HAS_ROM)('Game Corner', () => {
  it('plays one round on a slot machine', async () => {
    const h = await fieldAt('GAME_CORNER', 17, 14, 'right', (s) => {
      s.bag = [{ item: I('COIN_CASE'), qty: 1 }];
      s.coins = 100;
    });
    h.press('a', 2, 10);
    let sawWheels = false;
    let i = 0;
    for (; i < 3000; i++) {
      h.step();
      const t = h.screenText();
      if (h.engine.screen.objects.length) sawWheels = true;
      if (t.includes('YES') && t.includes('NO') && sawWheels) break; // "One more go?"
      if (i % 25 === 0) h.press('a', 2, 2); // YES, bet ×3, stop the wheels, prompts
    }
    expect(sawWheels).toBe(true);
    expect(i).toBeLessThan(3000);
    const coins = h.engine.state.coins;
    expect(coins === 97 || coins > 100).toBe(true);
    h.press('down', 2, 4);
    h.press('a', 2, 30); // NO
    clearText(h);
    expect(h.engine.screen.objects.length).toBe(0);
  });

  it('out-of-order machines and the coin case check', async () => {
    const h = await fieldAt('GAME_CORNER', 17, 10, 'right');
    h.press('a', 2, 60);
    expect(h.screenText()).toMatch(/COIN CASE|OUT OF ORDER|lunch|keys/i);
  });
});

describe.skipIf(!HAS_ROM)('Prize room', () => {
  it('trades coins for a TM', async () => {
    // the TM window is the sign at (6,2)
    const h = await fieldAt('GAME_CORNER_PRIZE_ROOM', 6, 3, 'up', (s) => {
      s.bag = [{ item: I('COIN_CASE'), qty: 1 }];
      s.coins = 5000;
    });
    h.press('a', 2, 10);
    for (let i = 0; i < 20 && !h.screenText().includes('NO THANKS'); i++) h.press('a', 2, 20);
    h.press('a', 2, 20); // the first TM
    for (let i = 0; i < 20 && !h.screenText().includes('YES'); i++) h.press('a', 2, 20);
    h.press('a', 2, 20); // YES
    clearText(h);
    expect(h.engine.state.coins).toBe(5000 - 3300);
    expect(h.engine.state.bag.some((s) => s.item === I('TM_DRAGON_RAGE'))).toBe(true);
  });
});

describe.skipIf(!HAS_ROM)('Rocket Hideout', () => {
  const setEv = (s: { eventFlags: number[] }, n: string) => {
    const i = c('event', n);
    s.eventFlags[i >> 3] |= 1 << (i & 7);
  };

  it('the B1F door opens once its last grunt is beaten', async () => {
    const shut = await fieldAt('ROCKET_HIDEOUT_B1F', 23, 2, 'down');
    expect(shut.engine.world.blockAt(12, 8)).toBe(0x54);
    const open = await fieldAt('ROCKET_HIDEOUT_B1F', 23, 2, 'down', (s) => setEv(s, 'EVENT_BEAT_ROCKET_HIDEOUT_1_TRAINER_4'));
    expect(open.engine.world.blockAt(12, 8)).toBe(0x0e);
  });

  it('Jessie & James stop the player on B4F', async () => {
    const h = await fieldAt('ROCKET_HIDEOUT_B4F', 24, 15, 'up', (s, b) => {
      s.party = [makePartyMon(b, { species: c('pokemon', 'MEWTWO'), level: 70, dvs: 0xffff, otId: s.player.id, otName: s.player.name })];
    });
    h.walk('up');
    let fought = false;
    for (let i = 0; i < 2000 && !fought; i++) {
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
      if (h.inBattle) {
        expect(h.engine.ram.trainerNo).toBe(0x2b);
        h.finishBattle();
        fought = true;
      }
    }
    expect(fought).toBe(true);
    for (let i = 0; i < 40; i++) {
      clearText(h);
      h.run(20);
    }
    const s = h.engine.state;
    expect(s.eventFlags[c('event', 'EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES') >> 3] & (1 << (c('event', 'EVENT_BEAT_ROCKET_HIDEOUT_4_JESSIE_JAMES') & 7))).toBeTruthy();
    expect(s.objectVisible[c('toggle', 'TOGGLE_ROCKET_HIDEOUT_B4F_JESSIE')]).toBe(false);
  });
});

describe.skipIf(!HAS_ROM)('Pokémon Tower', () => {
  const strong = (s: { party: unknown[]; player: { id: number; name: string } }, b: Parameters<typeof makePartyMon>[0]) => {
    s.party = [makePartyMon(b, { species: c('pokemon', 'MEWTWO'), level: 70, dvs: 0xffff, otId: s.player.id, otName: s.player.name })];
  };
  const ev = (h: Harness, n: string) => !!(h.engine.state.eventFlags[c('event', n) >> 3] & (1 << (c('event', n) & 7)));

  it('the rival battles on 2F and leaves', async () => {
    const h = await fieldAt('POKEMON_TOWER_2F', 15, 6, 'up', strong);
    h.walk('up');
    let fought = false;
    for (let i = 0; i < 1500 && !fought; i++) {
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
      if (h.inBattle) {
        expect(h.engine.ram.curOpponent).toBe(c('opp', 'OPP_RIVAL2'));
        h.finishBattle();
        fought = true;
      }
    }
    expect(fought).toBe(true);
    for (let i = 0; i < 30; i++) {
      clearText(h);
      h.run(20);
    }
    expect(ev(h, 'EVENT_BEAT_POKEMON_TOWER_RIVAL')).toBe(true);
    expect(h.engine.state.objectVisible[c('toggle', 'TOGGLE_POKEMON_TOWER_2F_RIVAL')]).toBe(false);
  });

  it('the purified zone on 5F heals the party', async () => {
    const h = await fieldAt('POKEMON_TOWER_5F', 10, 7, 'down', (s) => (s.party[0].hp = 1));
    stepAndSettle(h, 'down');
    expect(h.engine.state.party[0].hp).toBe(h.engine.state.party[0].maxHp);
    expect(ev(h, 'EVENT_IN_PURIFIED_ZONE')).toBe(true);
  });

  it('the ghost Marowak on 6F is calmed with the SILPH SCOPE', async () => {
    const h = await fieldAt('POKEMON_TOWER_6F', 10, 17, 'up', (s, b) => {
      strong(s, b);
      s.bag = [{ item: I('SILPH_SCOPE'), qty: 1 }];
    });
    h.walk('up');
    let enemy = 0;
    for (let i = 0; i < 600 && !h.inBattle; i++) {
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
    }
    enemy = (h.engine.battleHost as GbBattleHost).current?.enemy.mon.species ?? 0;
    expect(enemy).toBe(c('pokemon', 'MAROWAK'));
    h.finishBattle();
    for (let i = 0; i < 20; i++) {
      clearText(h);
      h.run(20);
    }
    expect(ev(h, 'EVENT_BEAT_GHOST_MAROWAK')).toBe(true);
  });

  it('rescuing Mr. Fuji on 7F warps to his house', async () => {
    const h = await fieldAt('POKEMON_TOWER_7F', 10, 4, 'up');
    h.press('a', 2, 10);
    for (let i = 0; i < 20 && h.engine.state.player.map === c('map', 'POKEMON_TOWER_7F'); i++) {
      clearText(h);
      h.run(30);
    }
    expect(h.engine.state.player.map).toBe(c('map', 'MR_FUJIS_HOUSE'));
    expect([h.engine.state.player.x, h.engine.state.player.y]).toEqual([3, 7]);
    expect(ev(h, 'EVENT_RESCUED_MR_FUJI')).toBe(true);
  });
});

describe.skipIf(!HAS_ROM)('Safari Zone', () => {
  const evOn = (h: Harness, n: string) => !!(h.engine.state.eventFlags[c('event', n) >> 3] & (1 << (c('event', n) & 7)));
  const settle = (h: Harness, until: () => boolean, max = 200) => {
    for (let i = 0; i < max && !until(); i++) {
      h.press('a', 2, 4);
      h.run(10);
    }
  };

  it('pays ¥500 for 30 balls, and the PA calls time after 502 steps', async () => {
    const h = await fieldAt('SAFARI_ZONE_GATE', 4, 3, 'up', (s) => (s.money = 1000));
    h.walk('up');
    settle(h, () => h.engine.state.player.map !== c('map', 'SAFARI_ZONE_GATE'));
    expect(h.engine.state.player.map).toBe(c('map', 'SAFARI_ZONE_CENTER'));
    expect(h.engine.state.money).toBe(500);
    expect(h.engine.state.vars.wNumSafariBalls).toBe(30);
    expect(evOn(h, 'EVENT_IN_SAFARI_ZONE')).toBe(true);
    // the last step runs out
    h.engine.env.setVar('wSafariSteps', 0);
    h.walk('up');
    settle(h, () => h.engine.state.player.map === c('map', 'SAFARI_ZONE_GATE') && !h.engine.ram.simulatedIndex && h.engine.env.curScript === 0);
    expect(h.engine.state.player.map).toBe(c('map', 'SAFARI_ZONE_GATE'));
    expect(evOn(h, 'EVENT_IN_SAFARI_ZONE')).toBe(false);
    expect(h.engine.state.vars.wNumSafariBalls).toBe(0);
  });

  it('lets a broke player in for 1 ball on the fourth try', async () => {
    const h = await fieldAt('SAFARI_ZONE_GATE', 4, 3, 'up', (s) => (s.money = 0));
    for (let attempt = 0; attempt < 3; attempt++) {
      h.walk('up');
      settle(h, () => h.engine.state.player.y === 3 && !h.engine.ram.simulatedIndex && h.engine.env.curScript === 0);
      expect(h.engine.state.player.map).toBe(c('map', 'SAFARI_ZONE_GATE'));
    }
    h.walk('up');
    settle(h, () => h.engine.state.player.map !== c('map', 'SAFARI_ZONE_GATE'));
    expect(h.engine.state.player.map).toBe(c('map', 'SAFARI_ZONE_CENTER'));
    expect(h.engine.state.vars.wNumSafariBalls).toBe(1);
  });

  it('a player short of ¥500 gets one ball per ¥23', async () => {
    const h = await fieldAt('SAFARI_ZONE_GATE', 4, 3, 'up', (s) => (s.money = 100));
    h.walk('up');
    settle(h, () => h.engine.state.player.map !== c('map', 'SAFARI_ZONE_GATE'));
    expect(h.engine.state.vars.wNumSafariBalls).toBe(5);
    expect(h.engine.state.money).toBe(0);
  });
});

describe.skipIf(!HAS_ROM)('Pokémon Mansion', () => {
  it('the secret switch swaps the gates', async () => {
    const h = await fieldAt('POKEMON_MANSION_1F', 2, 6, 'up');
    expect(h.engine.world.blockAt(12, 6)).toBe(0x0e);
    expect(h.engine.world.blockAt(8, 3)).toBe(0x2d);
    h.press('a', 2, 10);
    for (let i = 0; i < 40 && !h.screenText().includes('YES'); i++) h.press('a', 2, 10);
    h.press('a', 2, 10); // YES
    const ev = c('event', 'EVENT_MANSION_SWITCH_ON');
    for (let i = 0; i < 20 && !(h.engine.state.eventFlags[ev >> 3] & (1 << (ev & 7))); i++) h.press('a', 2, 10);
    h.run(10);
    expect(h.engine.world.blockAt(12, 6)).toBe(0x2d);
    expect(h.engine.world.blockAt(8, 3)).toBe(0x0e);
  });

  it('a hole on 3F drops to 1F', async () => {
    const h = await fieldAt('POKEMON_MANSION_3F', 16, 13, 'down');
    h.walk('down');
    h.run(120);
    expect(h.engine.state.player.map).toBe(c('map', 'POKEMON_MANSION_1F'));
  });
});

describe.skipIf(!HAS_ROM)('Cinnabar Gym', () => {
  const evOn = (h: Harness, n: string, off = 0) => {
    const i = c('event', n) + off;
    return !!(h.engine.state.eventFlags[i >> 3] & (1 << (i & 7)));
  };
  function* answerQuiz(h: Harness, yes: boolean) {
    h.press('a', 2, 10);
    for (let i = 0; i < 150 && !h.screenText().includes('YES'); i++) h.press('a', 2, 10);
    h.run(10);
    if (!yes) h.press('down', 2, 10);
    h.press('a', 2, 10);
    yield;
  }

  it('a right answer opens the gate', async () => {
    const h = await fieldAt('CINNABAR_GYM', 15, 8, 'up', (s) => {
      s.party.forEach((m) => (m.level = 60));
    });
    expect(h.engine.world.blockAt(9, 3)).toBe(0x54);
    [...answerQuiz(h, true)];
    for (let i = 0; i < 80 && !evOn(h, 'EVENT_CINNABAR_GYM_GATE1_UNLOCKED'); i++) h.press('a', 2, 10);
    h.run(10);
    expect(evOn(h, 'EVENT_CINNABAR_GYM_GATE1_UNLOCKED')).toBe(true);
    expect(h.engine.world.blockAt(9, 3)).toBe(0x0e);
  });

  it('a wrong answer brings the trainer over to battle, then opens the gate', async () => {
    const h = await fieldAt('CINNABAR_GYM', 15, 8, 'up', (s, b) => {
      s.party = [makePartyMon(b, { species: c('pokemon', 'MEWTWO'), level: 70, dvs: 0xffff, otId: s.player.id, otName: s.player.name })];
    });
    [...answerQuiz(h, false)];
    let fought = false;
    for (let i = 0; i < 1500 && !fought; i++) {
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
      if (h.inBattle) {
        h.finishBattle();
        fought = true;
      }
    }
    expect(fought).toBe(true);
    for (let i = 0; i < 20; i++) {
      clearText(h);
      h.run(20);
    }
    expect(evOn(h, 'EVENT_BEAT_CINNABAR_GYM_TRAINER_1')).toBe(true);
    expect(evOn(h, 'EVENT_CINNABAR_GYM_GATE1_UNLOCKED')).toBe(true);
    expect(h.engine.world.blockAt(9, 3)).toBe(0x0e);
  });
});

describe.skipIf(!HAS_ROM)('Pokémon League', () => {
  const evOn = (h: Harness, n: string) => !!(h.engine.state.eventFlags[c('event', n) >> 3] & (1 << (c('event', n) & 7)));

  it('walks the player into Lorelei’s room and starts the challenge', async () => {
    const h = await fieldAt('LORELEIS_ROOM', 5, 11, 'up');
    h.run(200);
    expect(h.engine.state.player.y).toBe(5);
    expect(evOn(h, 'EVENT_AUTOWALKED_INTO_LORELEIS_ROOM')).toBe(true);
    expect(h.engine.state.vars.wElite4Flags & (1 << c('ram', 'BIT_STARTED_ELITE_4'))).toBeTruthy();
    expect(h.engine.world.blockAt(2, 0)).toBe(0x24);
  });

  it('beats the Champion, follows Oak and enters the Hall of Fame', async () => {
    const h = await fieldAt('CHAMPIONS_ROOM', 4, 7, 'up', (s, b) => {
      s.party = [makePartyMon(b, { species: c('pokemon', 'MEWTWO'), level: 100, dvs: 0xffff, otId: s.player.id, otName: s.player.name })];
      s.mapScripts[c('map', 'CHAMPIONS_ROOM')] = c('map_script', 'SCRIPT_CHAMPIONSROOM_PLAYER_ENTERS');
      s.vars.wRivalStarter = c('pokemon', 'RIVAL_STARTER_JOLTEON');
      s.vars.wPlayerStarter = c('pokemon', 'PIKACHU');
    });
    let resets = 0;
    h.engine.hooks.reset = () => resets++;
    // the battle itself is the battle engine's business: the rival is beaten at once
    let fought = 0;
    (h.engine as { battleHost: unknown }).battleHost = {
      *run(_env: unknown, req: { kind: string; trainerClass?: number }) {
        if (req.kind === 'trainer' && req.trainerClass === c('opp', 'OPP_RIVAL3') - 200) fought++;
        return 'win';
      },
    };
    for (let i = 0; i < 40000 && !resets; i++) {
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
      // Durable saves now wait for the actual IndexedDB commit, not a frame timeout.
      if (i % 1000 === 0) await new Promise(resolve => setTimeout(resolve, 0));
    }
    expect(fought).toBe(1);
    expect(evOn(h, 'EVENT_BEAT_CHAMPION_RIVAL')).toBe(false); // the League events are reset after the Hall of Fame
    expect(h.engine.state.player.map).toBe(c('map', 'HALL_OF_FAME'));
    expect(h.engine.state.hallOfFame?.length).toBe(1);
    expect(h.engine.state.hallOfFame?.[0][0].species).toBe(c('pokemon', 'MEWTWO'));
    expect(h.engine.state.vars.wLastBlackoutMap).toBe(c('map', 'PALLET_TOWN'));
    expect(resets).toBe(1);
    expect((await readSave('slot1'))?.state.hallOfFame?.length).toBe(1);
  });
});

describe.skipIf(!HAS_ROM)('Silph Co.', () => {
  const evOn = (h: Harness, n: string) => !!(h.engine.state.eventFlags[c('event', n) >> 3] & (1 << (c('event', n) & 7)));

  it('a card-key door stays unlocked', async () => {
    // 2F door 1 is block (2,2), its door tiles on row 4; stand below it facing up
    const h = await fieldAt('SILPH_CO_2F', 5, 5, 'up', (s) => (s.bag = [{ item: I('CARD_KEY'), qty: 1 }]));
    expect(h.engine.world.blockAt(2, 2)).toBe(0x54);
    h.press('a', 2, 10);
    for (let i = 0; i < 10; i++) {
      clearText(h);
      h.run(10);
    }
    expect(evOn(h, 'EVENT_SILPH_CO_2_UNLOCKED_DOOR1')).toBe(true);
    expect(h.engine.world.blockAt(2, 2)).not.toBe(0x54);
  });

  it('beating Giovanni sends Team Rocket out of Saffron', async () => {
    const h = await fieldAt('SILPH_CO_11F', 6, 14, 'up', (s) => {
      for (const n of ['EVENT_BEAT_SILPH_CO_11F_JESSIE_JAMES', 'EVENT_SILPH_CO_11_UNLOCKED_DOOR']) {
        const ev = c('event', n);
        s.eventFlags[ev >> 3] |= 1 << (ev & 7);
      }
    });
    let fought = 0;
    (h.engine as { battleHost: unknown }).battleHost = {
      *run() {
        fought++;
        return 'win';
      },
    };
    h.walk('up');
    for (let i = 0; i < 2000 && !evOn(h, 'EVENT_BEAT_SILPH_CO_GIOVANNI'); i++) {
      h.step();
      if (i % 20 === 0) h.press('a', 2, 2);
    }
    expect(fought).toBe(1);
    expect(evOn(h, 'EVENT_BEAT_SILPH_CO_GIOVANNI')).toBe(true);
    expect(h.engine.state.objectVisible[c('toggle', 'TOGGLE_SAFFRON_CITY_1')]).toBe(false);
    expect(h.engine.state.objectVisible[c('toggle', 'TOGGLE_SAFFRON_CITY_8')]).toBe(true);
  });
});

describe.skipIf(!HAS_ROM)('Static encounters', () => {
  for (const [map, x, y, species, toggle] of [
    ['POWER_PLANT', 4, 10, 'ZAPDOS', 'TOGGLE_ZAPDOS'],
    ['VICTORY_ROAD_2F', 11, 6, 'MOLTRES', 'TOGGLE_MOLTRES'],
    ['CERULEAN_CAVE_B1F', 27, 14, 'MEWTWO', 'TOGGLE_MEWTWO'],
  ] as const) {
    it(`${species} battles when talked to`, async () => {
      const h = await fieldAt(map, x, y, 'up');
      let enemy = 0;
      (h.engine as { battleHost: unknown }).battleHost = {
        *run(_env: unknown, req: { kind: string; species?: number }) {
          enemy = req.species ?? 0;
          return 'win';
        },
      };
      h.press('a', 2, 10);
      for (let i = 0; i < 60 && !enemy; i++) h.press('a', 2, 10);
      expect(enemy).toBe(c('pokemon', species));
      h.run(60);
      expect(h.engine.state.objectVisible[c('toggle', toggle)]).toBe(false);
    });
  }
});
