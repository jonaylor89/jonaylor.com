import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { AccountSaves, type JournalStorage } from '../src/cloud/saves';
import type { CloudSnapshot, CloudTransport, LocalJournal, SaveRequest } from '../src/cloud/types';
import { newGameState } from '../src/game/state';
import { deleteSave, deserializeSave, readSave, serializeSave, setSaveBackend, writeSave } from '../src/game/save';
import type { GameBundle } from '../src/data/schema';

const bundle = { toggleableObjects: [] } as unknown as GameBundle;
function save(name: string) { const s = newGameState(bundle); s.player.name = name; return serializeSave(s); }
function memory(): JournalStorage {
  const records = new Map<string, LocalJournal>();
  let queue = Promise.resolve();
  return {
    async read(key) { return structuredClone(records.get(key)); },
    async update(key, fn) {
      let result!: LocalJournal;
      const task = queue.then(() => { result = fn(structuredClone(records.get(key))); records.set(key, structuredClone(result)); });
      queue = task.catch(() => undefined); await task; return structuredClone(result);
    },
  };
}
class Server implements CloudTransport {
  current: CloudSnapshot = { revision: 0, payload: null, device: '', updatedAt: '' };
  receipts = new Map<string, { status: 'saved'; snapshot: CloudSnapshot }>();
  versions: CloudSnapshot[] = [];
  online = true;
  loseAck = false;
  async read() { if (!this.online) throw new Error('offline'); return structuredClone(this.current); }
  async history() { return structuredClone(this.versions); }
  async write(request: SaveRequest) {
    if (!this.online) throw new Error('offline');
    const previous = this.receipts.get(request.requestId);
    if (previous) return structuredClone(previous);
    if (request.expectedRevision !== this.current.revision) return { status: 'conflict' as const, snapshot: structuredClone(this.current) };
    this.current = { revision: this.current.revision + 1, payload: request.payload, device: request.device, updatedAt: new Date().toISOString() };
    this.versions.unshift(structuredClone(this.current));
    const result = { status: 'saved' as const, snapshot: structuredClone(this.current) };
    this.receipts.set(request.requestId, result);
    if (this.loseAck) { this.loseAck = false; throw new Error('connection lost after commit'); }
    return structuredClone(result);
  }
}
async function device(server: CloudTransport, storage = memory(), owner = 'player', name = 'phone') {
  const saves = new AccountSaves(owner, name, server, storage); await saves.open(); return saves;
}
afterEach(() => setSaveBackend(undefined));

describe('account saves', () => {
  it('protects a new-game checkpoint locally without clearing or uploading the slot', async () => {
    const server = new Server(); const disk = memory(); const s = await device(server, disk);
    await s.stage(save('OLD')); await s.sync(); server.online = false;
    const before = structuredClone(s.journal);
    await s.protectForNewGame();
    expect(s.journal.payload).toBe(before.payload); expect(s.journal.pending).toEqual(before.pending);
    expect(server.versions).toHaveLength(1);
    const again = await device(server, disk);
    expect(again.journal.backups.at(-1)?.payload).toBe(before.payload);
    expect(again.journal.backups.at(-1)?.reason).toBe('Before new adventure');
  });
  it('refuses a new adventure until divergent saves are resolved', async () => {
    const s = await device(new Server());
    s.journal.conflict = { revision: 4, payload: save('OTHER'), device: 'other', updatedAt: '' };
    // Persist the conflict as a real transport would, then test the durable guard.
    const disk: JournalStorage = { read: async () => s.journal, update: async (_key, fn) => fn(structuredClone(s.journal)) };
    const conflicted = new AccountSaves('player', 'phone', new Server(), disk); await conflicted.open();
    await expect(conflicted.protectForNewGame()).rejects.toThrow('Choose a save');
  });
  it('routes all existing save entry points through the account backend', async () => {
    const s = await device(new Server());
    setSaveBackend(s);
    await writeSave('slot1', newGameState(bundle)); await s.sync();
    expect((await readSave('slot1'))?.state.player.name).toBe('YELLOW');
    await deleteSave('slot1'); await s.sync();
    expect(await readSave('slot1')).toBeUndefined();
    expect(s.journal.revision).toBe(2);
  });
  it('isolates local journals by account ID in IndexedDB', async () => {
    const a = new AccountSaves('isolation-a', 'phone', new Server());
    const b = new AccountSaves('isolation-b', 'phone', new Server());
    await a.open(); await b.open();
    await a.stage(save('ALICE')); await a.sync();
    expect(await b.read('slot1')).toBeUndefined();
    const again = new AccountSaves('isolation-a', 'phone', new Server()); await again.open();
    expect((await again.read('slot1'))?.state.player.name).toBe('ALICE');
  });
  it('persists offline payload, base revision and request ID across reloads', async () => {
    const server = new Server(); const disk = memory();
    const a = await device(server, disk); await a.sync();
    server.online = false; await a.stage(save('OFFLINE')); await a.sync();
    const pending = structuredClone(a.journal.pending);
    const reloaded = await device(server, disk);
    expect(reloaded.journal.pending).toEqual(pending);
    server.online = true; await reloaded.sync();
    expect(server.current.payload).toBe(pending?.payload); expect(reloaded.journal.pending).toBeUndefined();
  });
  it('downloads the account checkpoint before play starts', async () => {
    const server = new Server(); const a = await device(server); await a.stage(save('RED')); await a.sync();
    const b = await device(server); await b.sync();
    expect(b.journal.payload).toBe(a.journal.payload); expect(b.journal.revision).toBe(1);
  });
  it('never silently replaces a running game with a newer remote checkpoint', async () => {
    const server = new Server(); const a = await device(server); const b = await device(server);
    await a.sync(); a.startPlaying();
    await b.stage(save('OTHER')); await b.sync(); await a.sync();
    expect(a.status).toBe('conflict'); expect(a.journal.payload).toBeNull();
    expect(a.journal.conflict?.payload).toBe(b.journal.payload);
  });
  it.each(['local', 'cloud'] as const)('keeps both divergent checkpoints when choosing %s', async choice => {
    const server = new Server(); const a = await device(server); const b = await device(server);
    await a.sync(); await b.sync();
    server.online = false; await a.stage(save('PHONE')); await a.sync();
    server.online = true; await b.stage(save('LAPTOP')); await b.sync();
    await a.sync();
    expect(a.status).toBe('conflict');
    const loser = choice === 'local' ? b.journal.payload : a.journal.payload;
    await a.resolve(choice);
    expect(a.journal.backups.some(b => b.payload === loser)).toBe(true);
    expect(deserializeSave(server.current.payload!).state.player.name).toBe(choice === 'local' ? 'PHONE' : 'LAPTOP');
  });
  it('serializes concurrent first saves with one winner and one explicit conflict', async () => {
    const server = new Server(); const a = await device(server); const b = await device(server);
    await Promise.all([a.stage(save('ONE')), b.stage(save('TWO'))]);
    await Promise.all([a.sync(), b.sync()]);
    expect(server.current.revision).toBe(1);
    expect([a.status, b.status].sort()).toEqual(['conflict', 'synced']);
  });
  it('does not clear a newer local SAVE when an older request is acknowledged', async () => {
    const server = new Server();
    let release!: () => void; let committed!: () => void;
    const committedPromise = new Promise<void>(r => { committed = r; });
    const gate = new Promise<void>(r => { release = r; });
    let first = true;
    const transport: CloudTransport = {
      read: () => server.read(), history: () => server.history(),
      async write(request) {
        const result = await server.write(request);
        if (first) { first = false; committed(); await gate; }
        return result;
      },
    };
    const a = await device(transport);
    await a.stage(save('OLDER')); await committedPromise;
    await a.stage(save('NEWER'));
    release(); await a.sync();
    expect(deserializeSave(server.current.payload!).state.player.name).toBe('NEWER');
    expect(a.journal.pending).toBeUndefined(); expect(server.current.revision).toBe(2);
  });
  it('replays an unacknowledged committed request without incrementing revision twice', async () => {
    const server = new Server(); const disk = memory();
    const a = await device(server, disk); server.loseAck = true;
    await a.stage(save('SAFE')); await a.sync();
    expect(a.status).toBe('error'); expect(server.current.revision).toBe(1);
    const b = await device(server, disk); await b.sync();
    expect(b.status).toBe('synced'); expect(server.current.revision).toBe(1);
  });
  it('preserves a cleared-slot tombstone so an old offline device cannot resurrect it silently', async () => {
    const server = new Server(); const a = await device(server); await a.stage(save('OLD')); await a.sync();
    const b = await device(server); await b.sync();
    await a.delete('slot1'); await a.sync();
    await b.stage(save('STALE')); await b.sync();
    expect(b.status).toBe('conflict'); expect(b.journal.conflict?.payload).toBeNull();
    await b.resolve('cloud'); expect(await b.read('slot1')).toBeUndefined();
  });
  it('preserves pending progress when the server returns a malformed save', async () => {
    const server = new Server(); const a = await device(server);
    server.current = { revision: 2, payload: '{"bad":true}', device: 'other', updatedAt: '' };
    await a.stage(save('GOOD')); await a.sync();
    expect(a.status).toBe('error'); expect(a.journal.pending).toBeDefined();
    expect((await a.read('slot1'))?.state.player.name).toBe('GOOD');
  });
  it('bounds local recovery history', async () => {
    const server = new Server(); server.online = false;
    const a = await device(server);
    for (let i = 0; i < 15; i++) { await a.stage(save('RED' + i)); await a.sync(); }
    expect(a.journal.backups).toHaveLength(10);
  });
  it('surfaces local storage failures without claiming the save succeeded', async () => {
    const a = await device(new Server(), { async read() { return undefined; }, async update() { throw new Error('quota'); } });
    await expect(a.stage(save('NO'))).rejects.toThrow('quota');
    expect(a.localSaveFailed).toBe(true); expect(a.journal.payload).toBeNull();
  });
});
