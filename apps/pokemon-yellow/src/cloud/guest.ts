import { idbGet, idbPut, STORES } from '../data/db';
import { deleteLocalSave, readLegacySave, serializeSave, writeLocalSave, type SaveBackend } from '../game/save';
import type { GameState } from '../game/state';

export const GUEST_SLOT = 'guest:slot1';
/** No cloud identity, anonymous account, or network request is needed for a guest SAVE. */
export class GuestSaves implements SaveBackend {
  payload: string | null = null;
  localSaveFailed = false;
  lastEvent: 'saved' | 'cleared' | undefined;
  private listeners = new Set<() => void>();
  async open(): Promise<void> {
    if (!await idbGet<boolean>(STORES.settings, 'guest-slot-migrated')) {
      const current = await readLegacySave(GUEST_SLOT);
      const legacy = current ? undefined : await readLegacySave('slot1');
      if (legacy) await writeLocalSave(GUEST_SLOT, legacy.state);
      await idbPut(STORES.settings, 'guest-slot-migrated', true);
    }
    const file = await readLegacySave(GUEST_SLOT);
    this.payload = file ? JSON.stringify(file) : null;
    // Re-serialize a migrated v1 state so its updated fields have a matching checksum.
    if (file) this.payload = serializeSave(file.state, new Date(file.savedAt));
  }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  startPlaying(): void { /* Guests never cloud-sync. */ }
  private slot(slot: string) { if (slot !== 'slot1') throw new Error('Only slot1 is supported'); }
  async read(slot: string) { this.slot(slot); return readLegacySave(GUEST_SLOT); }
  async write(slot: string, state: GameState) {
    this.slot(slot);
    try {
      await writeLocalSave(GUEST_SLOT, state);
      const saved = await readLegacySave(GUEST_SLOT);
      this.payload = saved ? serializeSave(saved.state, new Date(saved.savedAt)) : null;
      this.localSaveFailed = false; this.lastEvent = 'saved';
    } catch (error) { this.localSaveFailed = true; throw error; }
    finally { for (const listener of this.listeners) listener(); }
  }
  async delete(slot: string) {
    this.slot(slot); await deleteLocalSave(GUEST_SLOT);
    this.payload = null; this.lastEvent = 'cleared';
    for (const listener of this.listeners) listener();
  }
}
