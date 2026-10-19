import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { newGameState, replay, Store, type Action, getBit } from '../src/game/state';
import { deserializeSave, serializeSave, writeSave, readSave, SaveError } from '../src/game/save';
import { c } from '../src/rom/constants';
import type { GameBundle } from '../src/data/schema';

const fakeBundle = { toggleableObjects: [{ map: 0, object: 1, initiallyVisible: true }, { map: 0, object: 2, initiallyVisible: false }] } as unknown as GameBundle;

describe('store', () => {
  it('replaying the action log reproduces the state', () => {
    const start = newGameState(fakeBundle);
    const store = new Store(structuredClone(start));
    const actions: Action[] = [
      { type: 'setPosition', map: 0, x: 5, y: 6, facing: 'down' },
      { type: 'setEvent', flag: c('event', 'EVENT_GOT_STARTER'), value: true },
      { type: 'giveItem', item: c('item', 'POTION'), qty: 3 },
      { type: 'addMoney', amount: -500 },
      { type: 'setObjectVisible', toggle: 1, visible: true },
    ];
    for (const a of actions) store.dispatch(a);
    expect(replay(start, store.log)).toEqual(store.state);
    expect(store.event('EVENT_GOT_STARTER')).toBe(true);
    expect(store.state.money).toBe(2500);
  });

  it('undo restores the previous state', () => {
    const store = new Store(newGameState(fakeBundle));
    store.dispatch({ type: 'setEvent', flag: 10, value: true });
    expect(getBit(store.state.eventFlags, 10)).toBe(true);
    store.undo();
    expect(getBit(store.state.eventFlags, 10)).toBe(false);
  });

  it('starts in Red\'s bedroom with 3000 money and a Potion in the PC', () => {
    const s = newGameState(fakeBundle);
    expect(s.player.map).toBe(c('map', 'REDS_HOUSE_2F'));
    expect(s.money).toBe(3000);
    expect(s.pcItems).toEqual([{ item: c('item', 'POTION'), qty: 1 }]);
    expect(s.objectVisible).toEqual([true, false]);
  });
});

describe('save files', () => {
  it('round-trips through serialization', () => {
    const s = newGameState(fakeBundle);
    s.player.name = 'RED';
    const text = serializeSave(s);
    expect(deserializeSave(text).state).toEqual(s);
  });

  it('detects corruption', () => {
    const text = serializeSave(newGameState(fakeBundle)).replace('"money":3000', '"money":9999');
    expect(() => deserializeSave(text)).toThrow(SaveError);
  });

  it('persists to IndexedDB', async () => {
    const s = newGameState(fakeBundle);
    s.badges = 0b101;
    await writeSave('slot1', s);
    const back = await readSave('slot1');
    expect(back?.state).toEqual(s);
  });
});
