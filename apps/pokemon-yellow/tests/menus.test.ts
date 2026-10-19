import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { bundle, HAS_ROM } from './helpers';
import { Harness } from './harness';
import { c } from '../src/rom/constants';
import { newGameState } from '../src/game/state';
import { readSave } from '../src/game/save';
import { makePartyMon } from '../src/game/pokemon';

describe.skipIf(!HAS_ROM)('START menu', () => {
  it('changes the text speed in OPTION and saves the game', async () => {
    const b = await bundle();
    const st = newGameState(b, 0x51);
    st.player.map = c('map', 'PALLET_TOWN');
    st.player.x = 5;
    st.player.y = 8;
    const h = new Harness(b, st);
    h.run(20);
    h.press('start', 2, 10);
    expect(h.screenText()).toContain('SAVE');
    expect(h.screenText()).not.toContain('DEX'); // no Pokédex yet
    // ▶ POKéMON, ITEM, name, SAVE, OPTION → down 4
    for (let i = 0; i < 4; i++) h.press('down', 2, 4);
    h.press('a', 2, 10);
    expect(h.screenText()).toContain('TEXT SPEED');
    h.press('right', 2, 8); // MID -> SLOW
    h.press('b', 2, 10);
    expect(h.store.state.options.textSpeed).toBe('slow');
    // back in the start menu (remembers OPTION); go up to SAVE
    h.press('up', 2, 4);
    h.press('a', 2, 10);
    let saw = '';
    for (let i = 0; i < 400 && !saw.includes('saved'); i++) {
      h.run(4);
      saw += h.screenText();
      if (h.screenText().includes('YES')) h.press('a', 2, 4);
    }
    expect(saw).toContain('PLAYER');
    for (let i = 0; i < 60; i++) h.run(10);
    const file = await readSave('slot1');
    expect(file?.state.options.textSpeed).toBe('slow');
    expect(file?.state.player.map).toBe(c('map', 'PALLET_TOWN'));
  });

  const withParty = async () => {
    const b = await bundle();
    const st = newGameState(b, 0x52);
    st.player.map = c('map', 'PALLET_TOWN');
    st.player.x = 5;
    st.player.y = 8;
    const mk = (n: string, l: number) => makePartyMon(b, { species: c('pokemon', n), level: l, dvs: 0xffff, otId: st.player.id, otName: st.player.name });
    st.party = [mk('PIKACHU', 10), mk('PIDGEY', 5)];
    st.party[0].hp = 5;
    st.bag = [{ item: c('item', 'POTION'), qty: 2 }];
    const h = new Harness(b, st);
    h.run(20);
    return h;
  };

  it('uses a Potion from ITEM on a party Pokémon', async () => {
    const h = await withParty();
    h.press('start', 2, 10);
    h.press('down', 2, 4); // ITEM
    h.press('a', 2, 20);
    expect(h.screenText()).toContain('POTION');
    h.press('a', 2, 10); // POTION
    expect(h.screenText()).toContain('TOSS');
    h.press('a', 2, 20); // USE
    expect(h.screenText()).toContain('Use item on which');
    h.press('a', 2, 20); // PIKACHU
    expect(h.waitUntil(() => h.screenText().includes('recovered by'), 600)).toBe(true);
    expect(h.store.state.party[0].hp).toBe(25);
    expect(h.store.state.bag[0].qty).toBe(1);
    h.press('a', 2, 30);
    h.press('b', 2, 20); // close the bag
    h.press('b', 2, 20); // close the START menu
    expect(h.textBoxOpen()).toBe(false);
  });

  it('switches party order from POKéMON', async () => {
    const h = await withParty();
    h.press('start', 2, 10);
    h.press('a', 2, 20); // POKéMON
    expect(h.screenText()).toContain('Choose a');
    h.press('a', 2, 10); // PIKACHU → STATS / SWITCH / CANCEL
    expect(h.screenText()).toContain('SWITCH');
    h.press('down', 2, 4);
    h.press('a', 2, 20); // SWITCH
    expect(h.screenText()).toContain('Move');
    h.press('down', 2, 4);
    h.press('a', 2, 20); // onto PIDGEY
    expect(h.store.state.party.map((m) => m.nickname)).toEqual(['PIDGEY', 'PIKACHU']);
    h.run(90); // the two SFX_SWAPs
    h.press('b', 2, 20);
    expect(h.screenText()).toContain('SAVE');
  });
});

describe.skipIf(!HAS_ROM)('Pokédex and trainer card', () => {
  async function withDex() {
    const b = await bundle();
    const st = newGameState(b, 0x51);
    st.player.map = c('map', 'PALLET_TOWN');
    st.player.x = 5;
    st.player.y = 8;
    st.party = [makePartyMon(b, { species: c('pokemon', 'PIKACHU'), level: 5, dvs: 0xffff, otId: st.player.id, otName: st.player.name })];
    const ev = c('event', 'EVENT_GOT_POKEDEX');
    st.eventFlags[ev >> 3] |= 1 << (ev & 7);
    // seen BULBASAUR (#1) and PIDGEY (#16), owned PIKACHU (#25)
    for (const d of [1, 16, 25]) st.pokedex.seen[(d - 1) >> 3] |= 1 << ((d - 1) & 7);
    st.pokedex.owned[24 >> 3] |= 1 << (24 & 7);
    st.badges = 0b11;
    const h = new Harness(b, st);
    h.run(20);
    return h;
  }

  it('lists seen Pokémon and shows an entry', async () => {
    const h = await withDex();
    h.press('start', 2, 10);
    h.press('a', 2, 30); // POKéDEX
    h.run(30);
    const t = h.screenText();
    expect(t).toContain('CONTENTS');
    expect(t).toContain('BULBASAUR');
    expect(t).toContain('----------');
    expect(t).toContain('SEEN');
    h.press('a', 2, 10); // BULBASAUR
    h.press('a', 2, 30); // DATA
    h.run(20);
    expect(h.screenText()).toContain('SEED');
    h.press('b', 2, 30);
    h.run(20);
    expect(h.screenText()).toContain('CONTENTS');
    h.press('b', 2, 30);
    h.run(30);
    expect(h.screenText()).toContain('POKéMON');
  });

  it('shows the trainer card with the badges', async () => {
    const h = await withDex();
    h.press('start', 2, 10);
    for (let i = 0; i < 3; i++) h.press('down', 2, 4); // POKéDEX, POKéMON, ITEM, name
    h.press('a', 2, 30);
    h.run(20);
    const t = h.screenText();
    expect(t).toContain('NAME/');
    expect(t).toContain('MONEY/');
    expect(t).toContain('BADGES');
    h.press('a', 2, 20);
    expect(h.screenText()).not.toContain('MONEY/');
  });
});

describe.skipIf(!HAS_ROM)('Power-on', () => {
  it.each(['legacy', 'browser'])('starts a %s new game through Oak’s speech with the default names', async entry => {
    const { bootSequence, newAdventure } = await import('../src/ui/titleFlow');
    const { deleteSave } = await import('../src/game/save');
    await deleteSave('slot1'); // no save file: the menu starts at NEW GAME
    const b = await bundle();
    const h = new Harness(b, newGameState(b, 0x99));
    let transparentAfterBoot = false;
    h.engine.boot = function* (e) {
      yield* (entry === 'browser' ? newAdventure(e) : bootSequence(e));
      transparentAfterBoot = !e.screen.backdrop && [...e.screen.cells].every(cell => cell < 0);
    };
    h.run(5);
    await new Promise(r => setTimeout(r, 0)); // settle the optional rules hook
    if (entry === 'legacy') {
      await new Promise((r) => setTimeout(r, 100)); // let the save lookup settle
      h.run(60);
      for (let i = 0; i < 300 && !h.screenText().includes('NEW GAME'); i++) h.press('a', 2, 10);
      expect(h.screenText()).toContain('NEW GAME');
      h.press('a', 2, 30); // NEW GAME
    }
    // the speech: press A until the player's name menu
    for (let i = 0; i < 300 && !h.screenText().includes('NEW NAME'); i++) h.press('a', 2, 10);
    expect(h.screenText()).toContain('YELLOW');
    h.press('down', 2, 6);
    h.press('down', 2, 6); // ASH
    h.press('a', 2, 30);
    for (let i = 0; i < 300 && !h.screenText().includes('NEW NAME'); i++) h.press('a', 2, 10);
    expect(h.screenText()).toContain('GARY');
    h.press('down', 2, 6);
    h.press('down', 2, 6); // GARY
    h.press('a', 2, 30);
    for (let i = 0; i < 600 && h.engine.state.player.map !== c('map', 'REDS_HOUSE_2F'); i++) h.press('a', 2, 10);
    for (let i = 0; i < 200; i++) h.press('a', 2, 10);
    expect(h.engine.state.player.name).toBe('ASH');
    expect(h.engine.state.player.rivalName).toBe('GARY');
    expect(h.engine.state.player.map).toBe(c('map', 'REDS_HOUSE_2F'));
    expect(h.engine.screen.backdrop).toBe(false);
    expect(transparentAfterBoot).toBe(true);
  });

  it('plays the whole intro, then the title screen', async () => {
    const { bootSequence } = await import('../src/ui/titleFlow');
    const b = await bundle();
    const h = new Harness(b, newGameState(b, 0x42));
    h.engine.boot = bootSequence;
    h.run(5);
    await new Promise((r) => setTimeout(r, 100));
    let ppuFrames = 0;
    for (let i = 0; i < 4000; i++) {
      h.step();
      if (h.engine.screen.ppu) ppuFrames++;
    }
    expect(ppuFrames).toBeGreaterThan(3000); // copyright, shooting star, intro scenes, title
    for (let i = 0; i < 300 && !h.screenText().includes('GAME'); i++) h.press('a', 2, 10);
    expect(h.screenText()).toContain('NEW GAME');
  });
});
