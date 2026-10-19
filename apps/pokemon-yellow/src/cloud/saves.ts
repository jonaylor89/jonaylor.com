import { idbGet, idbUpdate, STORES } from '../data/db';
import { deserializeSave, serializeSave, type SaveBackend } from '../game/save';
import type { GameState } from '../game/state';
import type { CloudSnapshot, CloudTransport, LocalJournal, SyncStatus } from './types';

export interface JournalStorage {
  read(key: string): Promise<LocalJournal | undefined>;
  update(key: string, fn: (journal: LocalJournal | undefined) => LocalJournal): Promise<LocalJournal>;
}
const indexedJournal: JournalStorage = {
  read: key => idbGet<LocalJournal>(STORES.saves, key),
  update: (key, fn) => idbUpdate<LocalJournal>(STORES.saves, key, fn),
};
export function journalKey(owner: string): string { return 'account:' + owner + ':slot1'; }
function emptyJournal(): LocalJournal { return { version: 1, revision: 0, payload: null, backups: [] }; }
function backup(journal: LocalJournal, payload: string | null, reason: string): void {
  if (journal.backups.at(-1)?.payload === payload) return;
  journal.backups.push({ payload, savedAt: new Date().toISOString(), reason });
  journal.backups = journal.backups.slice(-10);
}

/**
 * One instance owns a browser's account lock for its lifetime. Cloud writes are CAS,
 * pending requests survive reloads, and an ACK never clears a newer local SAVE.
 */
export class AccountSaves implements SaveBackend {
  journal: LocalJournal = emptyJournal();
  status: SyncStatus = 'local';
  error = '';
  localSaveFailed = false;
  private listeners = new Set<() => void>();
  private flight?: Promise<void>;
  private live = false;
  constructor(readonly owner: string, readonly device: string, private transport: CloudTransport, private storage: JournalStorage = indexedJournal) {}

  subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  private notify(): void { for (const listener of this.listeners) listener(); }
  private async update(fn: (journal: LocalJournal) => void): Promise<void> {
    this.journal = await this.storage.update(journalKey(this.owner), current => {
      const journal = current ?? emptyJournal();
      fn(journal);
      return journal;
    });
    this.notify();
  }
  async open(): Promise<void> {
    const record = await this.storage.read(journalKey(this.owner));
    if (record) {
      if (record.version !== 1) throw new Error('Unsupported local cloud-save journal. Do not clear browser storage.');
      if (record.payload !== null) deserializeSave(record.payload);
      this.journal = record;
    }
    this.status = this.journal.conflict ? 'conflict' : this.journal.pending ? 'pending' : 'local';
  }
  async protectForNewGame(): Promise<void> {
    await this.update(journal => {
      if (journal.conflict) throw new Error('Choose a save before starting a new adventure.');
      if (journal.payload) backup(journal, journal.payload, 'Before new adventure');
    });
  }
  /** After boot, never silently replace a running game's checkpoint with a remote save. */
  startPlaying(): void { this.live = true; }
  private slot(slot: string): void { if (slot !== 'slot1') throw new Error('Only slot1 is supported'); }
  async read(slot: string) {
    this.slot(slot);
    return this.journal.payload === null ? undefined : deserializeSave(this.journal.payload);
  }
  async write(slot: string, state: GameState): Promise<void> {
    this.slot(slot);
    await this.stage(serializeSave(state));
  }
  async delete(slot: string): Promise<void> { this.slot(slot); await this.stage(null); }
  async stage(payload: string | null): Promise<void> {
    if (payload !== null) deserializeSave(payload);
    try {
      await this.update(journal => {
        backup(journal, journal.payload, 'Before local save');
        journal.payload = payload;
        journal.pending = { expectedRevision: journal.revision, payload, device: this.device, requestId: crypto.randomUUID() };
      });
      this.localSaveFailed = false;
    } catch (error) {
      this.localSaveFailed = true; this.status = 'error';
      this.error = 'Save was NOT written. Browser storage is unavailable or full.';
      this.notify(); throw error;
    }
    this.status = this.journal.conflict ? 'conflict' : 'pending';
    this.notify();
    // Durability is local; a slow network must never block Yellow's save animation.
    void this.sync();
  }

  sync(): Promise<void> {
    if (this.flight) return this.flight;
    this.flight = this.performSync().catch(error => {
      this.error = error instanceof Error ? error.message : String(error);
      this.status = this.journal.conflict ? 'conflict' : 'error';
      this.notify();
    }).finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async performSync(): Promise<void> {
    if (this.journal.conflict) { this.status = 'conflict'; this.notify(); return; }
    this.error = '';
    this.status = 'syncing'; this.notify();
    for (;;) {
      const request = this.journal.pending;
      if (!request) {
        const remote = await this.transport.read();
        if (remote.payload !== null) deserializeSave(remote.payload);
        await this.update(journal => {
          // SAVE may have happened while GET was in flight.
          if (journal.pending) return;
          if (remote.revision !== journal.revision) {
            if (this.live && remote.payload !== journal.payload) journal.conflict = remote;
            else {
              backup(journal, journal.payload, 'Before cloud download');
              journal.payload = remote.payload;
              journal.revision = remote.revision;
            }
          }
        });
        if (this.journal.pending) continue;
        this.status = this.journal.conflict ? 'conflict' : 'synced'; this.notify(); return;
      }
      const result = await this.transport.write(request);
      if (result.snapshot.payload !== null) deserializeSave(result.snapshot.payload);
      await this.update(journal => {
        if (result.status === 'conflict') {
          journal.conflict = result.snapshot;
          return;
        }
        journal.revision = result.snapshot.revision;
        if (journal.pending?.requestId === request.requestId) journal.pending = undefined;
        else if (journal.pending) journal.pending.expectedRevision = result.snapshot.revision;
      });
      if (this.journal.conflict) { this.status = 'conflict'; this.notify(); return; }
      if (!this.journal.pending) { this.status = 'synced'; this.notify(); return; }
    }
  }
  async resolve(choice: 'local' | 'cloud'): Promise<void> {
    const remote = this.journal.conflict;
    if (!remote) return;
    await this.update(journal => {
      backup(journal, choice === 'cloud' ? journal.payload : remote.payload, 'Conflict alternative');
      journal.revision = remote.revision;
      if (choice === 'cloud') {
        journal.payload = remote.payload;
        journal.pending = undefined;
      } else {
        journal.pending = { expectedRevision: remote.revision, payload: journal.payload, device: this.device, requestId: crypto.randomUUID() };
      }
      journal.conflict = undefined;
    });
    this.status = this.journal.pending ? 'pending' : 'synced'; this.notify();
    await this.sync();
  }
  history(): Promise<CloudSnapshot[]> { return this.transport.history(); }
}
