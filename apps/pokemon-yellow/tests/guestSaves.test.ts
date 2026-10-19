import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GuestSaves, GUEST_SLOT, GUEST_NEW_GAME_BACKUP } from '../src/cloud/guest';
import { deleteLocalSave, readLegacySave, serializeSave, writeLocalSave } from '../src/game/save';
import { idbDelete, STORES } from '../src/data/db';
import { newGameState } from '../src/game/state';
import type { GameBundle } from '../src/data/schema';

const state = () => newGameState({ toggleableObjects: [] } as unknown as GameBundle);
beforeEach(async () => {
  await deleteLocalSave(GUEST_NEW_GAME_BACKUP);
  await deleteLocalSave(GUEST_SLOT); await deleteLocalSave('slot1');
  await idbDelete(STORES.settings, 'guest-slot-migrated');
});
describe('guest saves', () => {
  it('preserves the previous adventure across a new game SAVE and reload without deleting the live slot', async () => {
    const guest = new GuestSaves(); await guest.open();
    const old = state(); old.player.name = 'OLD'; await guest.write('slot1', old);
    await guest.protectForNewGame();
    expect((await guest.read('slot1'))?.state.player.name).toBe('OLD');
    const fresh = state(); fresh.player.name = 'NEW'; await guest.write('slot1', fresh);
    const again = new GuestSaves(); await again.open();
    expect((await again.read('slot1'))?.state.player.name).toBe('NEW');
    expect((await again.newGameBackup())?.state.player.name).toBe('OLD');
    expect(await readLegacySave('slot1')).toBeUndefined();
  });
  it('persists without an account or network, and remains separate from account journals', async () => {
    const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    try {
      const guest = new GuestSaves(); await guest.open(); const notify = vi.fn(); guest.subscribe(notify);
      await guest.write('slot1', state());
      expect(notify).toHaveBeenCalledOnce(); expect(guest.lastEvent).toBe('saved'); expect(fetch).not.toHaveBeenCalled();
      const reloaded = new GuestSaves(); await reloaded.open();
      expect((await reloaded.read('slot1'))?.state.player.name).toBe('YELLOW');
      expect(await readLegacySave('slot1')).toBeUndefined();
    } finally { vi.unstubAllGlobals(); }
  });
  it('copies an old local slot once, retains the original, and never resurrects it after clearing', async () => {
    await writeLocalSave('slot1', state());
    const guest = new GuestSaves(); await guest.open();
    expect(guest.payload).not.toBeNull(); expect(await readLegacySave('slot1')).toBeDefined();
    await guest.delete('slot1'); const again = new GuestSaves(); await again.open();
    expect(await again.read('slot1')).toBeUndefined(); expect(await readLegacySave('slot1')).toBeDefined();
  });
  it('keeps a stable guest fingerprint across reloads for explicit import decisions', async () => {
    const guest = new GuestSaves(); await guest.open(); await guest.write('slot1', state());
    const again = new GuestSaves(); await again.open(); expect(again.payload).toBe(guest.payload);
    expect(JSON.parse(guest.payload!).format).toBe(JSON.parse(serializeSave(state())).format);
  });
});
