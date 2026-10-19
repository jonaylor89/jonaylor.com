/**
 * Marts, PCs (Bill's, the item PC) and hidden events driven through the
 * real overworld with button presses.
 */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { clearText, Harness } from './harness';
import { c } from '../src/rom/constants';
import { addItem, newGameState, type GameState } from '../src/game/state';
import { makePartyMon } from '../src/game/pokemon';
import type { Facing } from '../src/world/movement';
import { STAY } from '../src/engine/sprites';

const I = (n: string) => c('item', n);

async function at(map: string, x: number, y: number, facing: Facing, edit?: (s: GameState) => void) {
  const b = await bundle();
  const st = newGameState(b, 0x77);
  st.player.map = c('map', map);
  st.player.x = x;
  st.player.y = y;
  st.player.facing = facing;
  const mk = (n: string, l: number) => makePartyMon(b, { species: c('pokemon', n), level: l, dvs: 0xffff, otId: st.player.id, otName: st.player.name });
  st.party = [mk('PIKACHU', 10), mk('PIDGEY', 7)];
  edit?.(st);
  const h = new Harness(b, st);
  h.engine.ram.debugNoWildEncounters = true;
  h.run(30);
  return h;
}

/** Press A until the screen shows `text` (or give up). */
function aUntil(h: Harness, text: string, max = 40): boolean {
  for (let i = 0; i < max; i++) {
    if (h.screenText().includes(text)) return true;
    h.press('a', 2, 20);
  }
  return h.screenText().includes(text);
}

/** Press A until `text` is gone (a prompt was dismissed). */
function dismiss(h: Harness, text: string, max = 40): boolean {
  for (let i = 0; i < max && h.screenText().includes(text); i++) h.press('a', 2, 20);
  h.run(20);
  return !h.screenText().includes(text);
}

/** Wait until the screen shows `text`, then let the menu or text settle. */
function waitText(h: Harness, text: string, max = 600): boolean {
  const ok = h.waitUntil(() => h.screenText().includes(text), max);
  h.run(40);
  return ok;
}

describe.skipIf(!HAS_ROM)('Poké Mart', () => {
  it('buys two POKé BALLs and sells a POTION at half price', async () => {
    const h = await at('PEWTER_MART', 2, 5, 'left', (s) => (s.bag = [{ item: I('POTION'), qty: 3 }]));
    h.press('a', 2, 10);
    expect(aUntil(h, 'BUY')).toBe(true);
    expect(h.screenText()).toContain('¥3000');
    h.press('a', 2, 20); // BUY
    expect(waitText(h, 'POKé BALL')).toBe(true);
    expect(h.screenText()).toContain('¥200');
    h.press('a', 2, 20); // POKé BALL
    h.press('up', 2, 10); // ×02
    expect(h.screenText()).toContain('×02');
    expect(h.screenText()).toContain('¥400');
    h.press('a', 2, 20);
    expect(aUntil(h, 'YES')).toBe(true);
    h.run(20);
    h.press('a', 2, 20); // YES
    expect(waitText(h, 'Here you are')).toBe(true);
    expect(h.store.state.money).toBe(2600);
    expect(h.store.state.bag).toContainEqual({ item: I('POKE_BALL'), qty: 2 });
    h.press('a', 2, 20);
    h.press('b', 2, 20); // close the list
    expect(waitText(h, 'Is there anything')).toBe(true);
    h.press('a', 2, 20);
    expect(waitText(h, 'SELL')).toBe(true);
    h.press('down', 2, 6);
    h.press('a', 2, 20); // SELL
    expect(waitText(h, 'What would you')).toBe(true);
    h.press('a', 2, 20);
    expect(waitText(h, 'POTION')).toBe(true);
    h.press('a', 2, 20); // POTION (first slot)
    expect(h.screenText()).toContain('¥150'); // 300 / 2
    h.press('a', 2, 20);
    expect(aUntil(h, 'YES')).toBe(true);
    h.run(20);
    h.press('a', 2, 20);
    h.run(30);
    expect(h.store.state.money).toBe(2750);
    expect(h.store.state.bag).toContainEqual({ item: I('POTION'), qty: 2 });
    // leave: B out of the list, then B on BUY/SELL/QUIT once "anything else" has printed
    h.press('b', 2, 20);
    expect(waitText(h, 'anything', 300)).toBe(true);
    h.run(60);
    h.press('b', 2, 20);
    expect(waitText(h, 'Thank you')).toBe(true);
    h.press('a', 2, 30);
    h.run(30);
    expect(h.textBoxOpen()).toBe(false);
  });
});

describe('AddItemToInventory', () => {
  it('tops a stack up to 99 and starts a new stack with the rest', () => {
    const bag = [{ item: 4, qty: 98 }];
    expect(addItem(bag, 4, 5, 20)).toBe(true);
    expect(bag).toEqual([
      { item: 4, qty: 99 },
      { item: 4, qty: 4 },
    ]);
    const full = Array.from({ length: 20 }, (_, i) => ({ item: i + 1, qty: 99 }));
    expect(addItem(full, 1, 1, 20)).toBe(false);
    expect(full[0].qty).toBe(99);
  });
});

describe.skipIf(!HAS_ROM)('PCs', () => {
  it('deposits and withdraws a Pokémon in Bill\'s PC from a Pokémon Center PC', async () => {
    const h = await at('PEWTER_POKECENTER', 13, 4, 'up');
    h.press('a', 2, 10);
    expect(waitText(h, 'turned on')).toBe(true);
    expect(aUntil(h, 'LOG OFF')).toBe(true);
    h.run(20);
    expect(h.screenText()).toContain('SOMEONE');
    h.press('a', 2, 20); // SOMEONE's PC
    expect(aUntil(h, 'WITHDRAW')).toBe(true);
    h.press('down', 2, 6);
    h.press('a', 2, 20); // DEPOSIT
    expect(waitText(h, 'PIDGEY')).toBe(true);
    h.press('down', 2, 6);
    h.press('a', 2, 20); // PIDGEY
    expect(waitText(h, 'STATS')).toBe(true);
    h.press('a', 2, 20); // DEPOSIT
    expect(waitText(h, 'stored in Box 1', 900)).toBe(true);
    expect(h.store.state.party.map((m) => m.nickname)).toEqual(['PIKACHU']);
    expect(h.store.state.boxes[0].map((m) => m.nickname)).toEqual(['PIDGEY']);
    expect(h.store.state.boxes[0][0].boxLevel).toBe(7);
    expect(dismiss(h, 'stored in')).toBe(true);
    h.press('up', 2, 6); // the cursor comes back on DEPOSIT (wParentMenuItem)
    h.press('a', 2, 20); // WITHDRAW
    expect(waitText(h, 'PIDGEY')).toBe(true);
    h.press('a', 2, 20);
    expect(waitText(h, 'STATS')).toBe(true);
    h.press('a', 2, 20);
    expect(waitText(h, 'taken out', 900)).toBe(true);
    expect(h.store.state.party.map((m) => m.nickname)).toEqual(['PIKACHU', 'PIDGEY']);
    expect(h.store.state.party[1].level).toBe(7);
    expect(h.store.state.boxes[0]).toEqual([]);
  });

  it('shows the Hall of Fame teams on the PKMN LEAGUE PC', async () => {
    const h = await at('PEWTER_POKECENTER', 13, 4, 'up', (s) => {
      s.vars.wNumHoFTeams = 1;
      s.hallOfFame = [[{ species: c('pokemon', 'PIKACHU'), level: 55, nick: 'SPARKY' }]];
    });
    h.press('a', 2, 10);
    expect(waitText(h, 'turned on')).toBe(true);
    expect(aUntil(h, 'LOG OFF')).toBe(true);
    h.run(20);
    expect(h.screenText()).toContain('LEAGUE');
    for (let i = 0; i < 3; i++) h.press('down', 2, 6);
    h.press('a', 2, 20); // PKMN LEAGUE
    expect(aUntil(h, 'HALL OF FAME No')).toBe(true);
    expect(h.screenText()).toContain('SPARKY');
    expect(h.screenText()).toMatch(/No\s+1/);
    expect(aUntil(h, 'LOG OFF')).toBe(true);
  });

  it('stores and withdraws items in the bedroom PC', async () => {
    const h = await at('REDS_HOUSE_2F', 0, 2, 'up', (s) => (s.bag = [{ item: I('POTION'), qty: 5 }]));
    h.press('a', 2, 10);
    expect(waitText(h, 'turned on')).toBe(true);
    expect(aUntil(h, 'DEPOSIT ITEM')).toBe(true);
    h.press('down', 2, 6);
    h.press('a', 2, 20); // DEPOSIT ITEM
    expect(waitText(h, 'POTION')).toBe(true);
    expect(aUntil(h, '×', 3)).toBe(true);
    h.press('a', 2, 10);
    h.press('up', 2, 6); // ×02
    h.press('a', 2, 20);
    expect(waitText(h, 'stored via', 900)).toBe(true);
    expect(h.store.state.bag).toEqual([{ item: I('POTION'), qty: 3 }]);
    expect(h.store.state.pcItems).toContainEqual({ item: I('POTION'), qty: 3 }); // a new game starts with one in the PC
  });
});

describe.skipIf(!HAS_ROM)('hidden events', () => {
  it('finds a hidden item once (Viridian Forest)', async () => {
    const h = await at('VIRIDIAN_FOREST', 2, 18, 'left');
    const before = h.store.state.bag.length;
    h.press('a', 2, 10);
    expect(waitText(h, 'found')).toBe(true);
    h.run(60);
    expect(h.store.state.bag.length).toBe(before + 1);
    expect(h.store.state.bag.at(-1)?.item).toBe(c('item', 'POTION'));
    h.run(60);
    h.press('a', 2, 60);
    expect(h.screenText()).not.toContain('found');
    expect(h.store.state.bag.length).toBe(before + 1);
  });

  it("reads Oak's posters and the school notebook", async () => {
    const h = await at('OAKS_LAB', 4, 1, 'up');
    h.press('a', 2, 10);
    expect(waitText(h, 'START')).toBe(true);
    const h2 = await at('VIRIDIAN_SCHOOL_HOUSE', 3, 5, 'up');
    h2.press('a', 2, 10);
    expect(aUntil(h2, 'Turn the')).toBe(true);
  });
});

describe.skipIf(!HAS_ROM)('In-game trades', () => {
  /** Stand below the trader with `give` leading the party, say YES and pick it. */
  const trade = async (map: string, x: number, y: number, give: string) => {
    const b = await bundle();
    const h = await at(map, x, y, 'up', (s) =>
      s.party.unshift(makePartyMon(b, { species: c('pokemon', give), level: 16, dvs: 0xffff, otId: s.player.id, otName: s.player.name })),
    );
    h.press('a', 2, 10);
    expect(aUntil(h, 'YES')).toBe(true);
    h.press('a', 2, 30); // YES → party menu
    expect(waitText(h, 'Choose a')).toBe(true);
    h.press('a', 2, 30); // the first mon
    return h;
  };

  it('trades CLEFAIRY for MILES the MR.MIME on Route 2, then remembers it', async () => {
    const h = await trade('ROUTE_2_TRADE_HOUSE', 4, 2, 'CLEFAIRY');
    expect(aUntil(h, 'traded', 300)).toBe(true); // includes the complete cable animation
    clearText(h);
    const st = h.engine.state;
    const mime = st.party[st.party.length - 1];
    expect(st.party.map((m) => m.species)).not.toContain(c('pokemon', 'CLEFAIRY'));
    expect(mime.species).toBe(c('pokemon', 'MR_MIME'));
    expect(mime.nickname).toBe('MILES');
    expect(mime.level).toBe(16);
    expect(mime.otName).toBe((await bundle()).trades.otName);
    expect(st.vars.wCompletedInGameTradeFlags).toBe(1 << c('script', 'TRADE_FOR_MILES'));
    // talking again gives the after-trade text, no yes/no
    h.press('a', 2, 10);
    h.run(60);
    expect(h.screenText()).not.toContain('YES');
  });

  it('refuses the wrong Pokémon', async () => {
    const h = await trade('ROUTE_2_TRADE_HOUSE', 4, 2, 'PIDGEY');
    clearText(h);
    expect(h.engine.state.party.length).toBe(3);
    expect(h.engine.state.vars.wCompletedInGameTradeFlags ?? 0).toBe(0);
  });

  it('trades CUBONE for RICKY, who evolves into MACHAMP', async () => {
    const h = await trade('UNDERGROUND_PATH_ROUTE_5', 2, 4, 'CUBONE');
    expect(aUntil(h, 'evolved', 300)).toBe(true);
    clearText(h);
    const st = h.engine.state;
    const ricky = st.party[st.party.length - 1];
    expect(ricky.species).toBe(c('pokemon', 'MACHAMP'));
    expect(ricky.nickname).toBe('RICKY');
  });
});

describe.skipIf(!HAS_ROM)("Oak's aides", () => {
  const visit = async (owned: number) => {
    const h = await at('ROUTE_2_GATE', 2, 4, 'left', (s) => {
      for (let i = 0; i < owned; i++) s.pokedex.owned[i >> 3] |= 1 << (i & 7);
    });
    h.press('a', 2, 10);
    expect(aUntil(h, 'YES')).toBe(true);
    h.press('a', 2, 30); // YES
    clearText(h);
    return h;
  };
  const hasFlash = (h: Harness) => h.engine.state.bag.some((s) => s.item === I('HM_FLASH'));

  it('turns the player away with fewer than 10 owned', async () => {
    const h = await visit(9);
    expect(hasFlash(h)).toBe(false);
  });

  it('gives HM05 for 10 owned, then only explains FLASH', async () => {
    const h = await visit(10);
    expect(hasFlash(h)).toBe(true);
    // the second visit skips the offer
    h.press('a', 2, 10);
    h.run(60);
    expect(h.screenText()).not.toContain('YES');
    clearText(h);
    expect(h.engine.state.bag.filter((s) => s.item === I('HM_FLASH'))).toHaveLength(1);
  });
});

describe.skipIf(!HAS_ROM)('Day Care', () => {
  it('takes a Pokémon, grows it by steps, and returns it for ¥100 per level + ¥100', async () => {
    const b = await bundle();
    const h = await at('DAYCARE', 3, 3, 'left');
    const pidgey = c('pokemon', 'PIDGEY');
    // deposit the second mon (PIDGEY Lv7)
    h.press('a', 2, 10);
    expect(aUntil(h, 'YES')).toBe(true);
    h.press('a', 2, 30);
    expect(aUntil(h, 'Choose a')).toBe(true);
    h.press('down', 2, 10);
    h.press('a', 2, 30);
    clearText(h);
    let st = h.engine.state;
    expect(st.party.map((m) => m.species)).not.toContain(pidgey);
    expect(st.daycare?.species).toBe(pidgey);
    expect(st.daycare?.boxLevel).toBe(7);
    const exp0 = st.daycare!.exp;

    // a step adds one exp
    const ok = h.walk('up');
    expect(ok).toBe(true);
    expect(h.engine.state.daycare!.exp).toBeGreaterThan(exp0);

    // grow it to Lv12 and collect it: 5 levels → ¥600
    const growth = b.species[pidgey].growthRate;
    const { calcExperience } = await import('../src/game/pokemon');
    h.engine.store.dispatch({ type: 'setDaycare', mon: { ...h.engine.state.daycare!, exp: calcExperience(b, growth, 12) } }, { undoable: false });
    const money = h.engine.state.money;
    // back behind the counter (Pikachu now follows on the square below)
    h.engine.store.dispatch({ type: 'setPosition', map: c('map', 'DAYCARE'), x: 3, y: 3, facing: 'left' }, { undoable: false });
    h.run(10);
    h.press('left', 2, 10); // turn in place
    h.press('a', 2, 10);
    expect(aUntil(h, 'grown by')).toBe(true);
    expect(h.screenText()).toContain('5');
    expect(aUntil(h, 'YES')).toBe(true);
    h.press('a', 2, 30);
    clearText(h);
    st = h.engine.state;
    expect(st.daycare).toBeUndefined();
    expect(st.money).toBe(money - 600);
    const back = st.party[st.party.length - 1];
    expect(back.species).toBe(pidgey);
    expect(back.level).toBe(12);
    expect(back.hp).toBe(back.maxHp);
    expect(back.moves).toContain(c('move', 'QUICK_ATTACK')); // learned at 12
  });

  it('refuses a Pokémon that knows an HM move', async () => {
    const h = await at('DAYCARE', 3, 3, 'left', (s) => (s.party[1].moves[1] = c('move', 'CUT')));
    h.press('a', 2, 10);
    expect(aUntil(h, 'YES')).toBe(true);
    h.press('a', 2, 30);
    expect(aUntil(h, 'Choose a')).toBe(true);
    h.press('down', 2, 10);
    h.press('a', 2, 30);
    expect(aUntil(h, 'HM move')).toBe(true);
    clearText(h);
    expect(h.engine.state.daycare).toBeUndefined();
    expect(h.engine.state.party).toHaveLength(2);
  });
});

describe.skipIf(!HAS_ROM)('Out-of-battle poison', () => {
  it('takes 1 HP every fourth step and faints a mon at 0 HP', async () => {
    const PSN = 1 << c('battle', 'PSN');
    const h = await at('ROUTE_1', 10, 20, 'up', (s) => {
      s.party[1].status = PSN;
      s.party[1].hp = 2;
    });
    let fainted = false;
    for (let i = 0; i < 16 && !fainted; i++) {
      h.run(20, [i & 1 ? 'down' : 'up']);
      h.run(10);
      fainted = h.screenText().includes('fainted');
      if (fainted) clearText(h);
    }
    expect(fainted).toBe(true);
    const pidgey = h.engine.state.party[1];
    expect(pidgey.hp).toBe(0);
    expect(pidgey.status).toBe(0);
  });
});

describe.skipIf(!HAS_ROM)('Gift and item NPCs', () => {
  const has = (h: Harness, item: string) => h.engine.state.bag.some((s) => s.item === I(item));
  /** Talk, answer YES to the first yes/no, then clear the rest. */
  const talkYes = (h: Harness) => {
    h.press('a', 2, 10);
    expect(aUntil(h, 'YES')).toBe(true);
    h.press('a', 2, 30);
    clearText(h);
  };

  it('Melanie gives BULBASAUR once Pikachu is happy enough', async () => {
    const h = await at('CERULEAN_MELANIES_HOUSE', 3, 2, 'up', (s) => (s.pikachu.happiness = 150));
    talkYes(h);
    const st = h.engine.state;
    expect(st.party.map((m) => m.species)).toContain(c('pokemon', 'BULBASAUR'));
    expect(st.objectVisible[c('toggle', 'TOGGLE_CERULEAN_BULBASAUR')]).toBe(false);
    const sad = await at('CERULEAN_MELANIES_HOUSE', 3, 2, 'up', (s) => (s.pikachu.happiness = 100));
    sad.press('a', 2, 10);
    expect(aUntil(sad, 'YES', 20)).toBe(false);
    expect(sad.engine.state.party).toHaveLength(2);
  });

  it('the Bike Shop swaps the BIKE VOUCHER for a BICYCLE', async () => {
    const h = await at('BIKE_SHOP', 6, 3, 'up', (s) => (s.bag = [{ item: I('BIKE_VOUCHER'), qty: 1 }]));
    h.press('a', 2, 10);
    clearText(h);
    expect(has(h, 'BICYCLE')).toBe(true);
    expect(has(h, 'BIKE_VOUCHER')).toBe(false);
  });

  it('the Vermilion fishing guru gives the OLD ROD once', async () => {
    const h = await at('VERMILION_OLD_ROD_HOUSE', 3, 4, 'left');
    talkYes(h);
    expect(has(h, 'OLD_ROD')).toBe(true);
    expect((h.engine.state.vars.wStatusFlags1 ?? 0) & (1 << c('ram', 'BIT_GOT_OLD_ROD'))).toBeTruthy();
    h.press('a', 2, 10);
    expect(aUntil(h, 'YES', 20)).toBe(false);
  });

  it("the Name Rater won't rename a traded Pokémon", async () => {
    const h = await at('NAME_RATERS_HOUSE', 4, 3, 'right', (s) => (s.party[0].otId ^= 1));
    talkYes(h);
    expect(h.screenText()).not.toContain('renamed');
    expect(h.engine.state.party[0].nickname).toBe('PIKACHU');
  });

  it('the Cinnabar Lab revives OLD AMBER into AERODACTYL', async () => {
    const h = await at('CINNABAR_LAB_FOSSIL_ROOM', 5, 3, 'up', (s) => (s.bag = [{ item: I('OLD_AMBER'), qty: 1 }]));
    h.press('a', 2, 10);
    expect(aUntil(h, 'OLD AMBER')).toBe(true);
    h.press('a', 2, 30); // choose OLD AMBER
    expect(aUntil(h, 'YES')).toBe(true);
    h.press('a', 2, 30);
    clearText(h);
    expect(has(h, 'OLD_AMBER')).toBe(false);
    expect(h.engine.env.checkEvent('EVENT_LAB_STILL_REVIVING_FOSSIL')).toBe(true);
    // stepping outside finishes the revival (CinnabarIsland_Script resets the flag)
    const back = { ...h.engine.state.player };
    h.engine.store.dispatch({ type: 'setPosition', map: c('map', 'CINNABAR_ISLAND'), x: 8, y: 12, facing: 'down' }, { undoable: false });
    h.engine.loadMapData();
    h.run(30);
    expect(h.engine.env.checkEvent('EVENT_LAB_STILL_REVIVING_FOSSIL')).toBe(false);
    // back in the lab; the scientist wanders, so stand below him and hold him still
    h.engine.store.dispatch({ type: 'setPosition', ...back }, { undoable: false });
    h.engine.loadMapData();
    const sci = h.engine.sprites[1];
    sci.movementByte1 = STAY;
    h.run(20);
    h.engine.store.dispatch({ type: 'setPosition', ...back, x: sci.mapX, y: sci.mapY + 1 }, { undoable: false });
    h.press('up', 2, 10);
    h.press('a', 2, 10);
    clearText(h, 120);
    expect(h.engine.state.party.map((m) => m.species)).toContain(c('pokemon', 'AERODACTYL'));
    expect(h.engine.env.checkEvent('EVENT_GAVE_FOSSIL_TO_LAB')).toBe(false);
  });

  it('the Celadon Mansion EEVEE ball and the Safari Zone warden', async () => {
    const h = await at('CELADON_MANSION_ROOF_HOUSE', 4, 4, 'up');
    h.press('a', 2, 10);
    clearText(h);
    expect(h.engine.state.party.map((m) => m.species)).toContain(c('pokemon', 'EEVEE'));
    expect(h.engine.state.objectVisible[c('toggle', 'TOGGLE_CELADON_MANSION_EEVEE_GIFT')]).toBe(false);

    const w = await at('WARDENS_HOUSE', 2, 4, 'up', (s) => (s.bag = [{ item: I('GOLD_TEETH'), qty: 1 }]));
    w.press('a', 2, 10);
    clearText(w);
    expect(has(w, 'GOLD_TEETH')).toBe(false);
    expect(has(w, 'HM_STRENGTH')).toBe(true);
  });
});
