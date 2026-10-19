/** Real SQLite exercises the same migration/triggers used by D1; no Docker or mock SQL. */
import { createRequire } from 'node:module';
import type { DatabaseSync as SqliteDatabase } from 'node:sqlite';
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
import { readFileSync } from 'node:fs';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type { D1Database } from '@cloudflare/workers-types';
import { cloudHistory, readCloudSave, validateSaveRequest, writeCloudSave } from '../worker/saves';
import { cleanupAuth } from '../worker/cleanup';
import { serializeSave } from '../src/game/save';
import { newGameState } from '../src/game/state';
import type { GameBundle } from '../src/data/schema';

let sqlite: SqliteDatabase;
let db: D1Database;
const count = (table: string) => (sqlite.prepare('SELECT count(*) AS n FROM ' + table).get() as { n: number }).n;
const payload = serializeSave(newGameState({ toggleableObjects: [] } as unknown as GameBundle));
const request = (expectedRevision: number, body: string | null = payload) => ({ expectedRevision, payload: body, requestId: crypto.randomUUID(), device: 'test browser' });
beforeEach(() => {
  sqlite = new DatabaseSync(':memory:');
  sqlite.exec(readFileSync('migrations/0001_auth_and_saves.sql', 'utf8'));
  sqlite.exec("INSERT INTO user(id,name,email,created_at,updated_at) VALUES ('alice','Alice','alice@example.test',0,0),('bob','Bob','bob@example.test',0,0)");
  db = {
    async batch(statements: { run(): Promise<unknown> }[]) {
      sqlite.exec('BEGIN');
      try { const results = []; for (const statement of statements) results.push(await statement.run()); sqlite.exec('COMMIT'); return results; }
      catch (error) { sqlite.exec('ROLLBACK'); throw error; }
    },
    prepare(sql: string) {
    let values: (string | number | null)[] = [];
    const statement = {
      bind(...next: (string | number | null)[]) { values = next; return statement; },
      async first() { return sqlite.prepare(sql).get(...values) ?? null; },
      async all() { return { results: sqlite.prepare(sql).all(...values), success: true }; },
      async run() { return sqlite.prepare(sql).run(...values); },
    };
    return statement;
  } } as unknown as D1Database;
});
afterEach(() => sqlite.close());
describe('SQLite save transaction boundary', () => {
  it('preserves exact save bytes and idempotent acknowledgements', async () => {
    const r = request(0); const first = await writeCloudSave(db, 'alice', r);
    expect(first.status).toBe('saved'); expect(first.snapshot.payload).toBe(payload);
    expect(await writeCloudSave(db, 'alice', r)).toEqual(first);
    await expect(writeCloudSave(db, 'alice', { ...r, payload: null })).rejects.toThrow('reused');
    expect((await readCloudSave(db, 'alice')).revision).toBe(1);
  });
  it('keeps different account data and request receipts separate', async () => {
    const r = request(0);
    await writeCloudSave(db, 'alice', r);
    expect((await readCloudSave(db, 'bob')).revision).toBe(0);
    expect(await cloudHistory(db, 'bob')).toEqual([]);
    expect((await writeCloudSave(db, 'bob', r)).status).toBe('saved');
  });
  it('atomically rejects stale updates without creating history or receipts', async () => {
    await writeCloudSave(db, 'alice', request(0));
    const loser = request(0);
    expect((await writeCloudSave(db, 'alice', loser)).status).toBe('conflict');
    expect(await cloudHistory(db, 'alice')).toHaveLength(1);
    expect(count('game_save_requests')).toBe(1);
  });
  it('retains tombstone revisions and bounds cloud history', async () => {
    await writeCloudSave(db, 'alice', request(0));
    const deleted = await writeCloudSave(db, 'alice', request(1, null));
    expect(deleted.snapshot.revision).toBe(2); expect(deleted.snapshot.payload).toBeNull();
    expect((await writeCloudSave(db, 'alice', request(1))).status).toBe('conflict');
    for (let revision = 2; revision < 25; revision++) await writeCloudSave(db, 'alice', request(revision));
    expect(await cloudHistory(db, 'alice')).toHaveLength(20);
  });
  it('rolls back the whole operation if history storage fails', async () => {
    sqlite.exec("CREATE TRIGGER simulate_disk_error BEFORE INSERT ON game_save_versions BEGIN SELECT RAISE(ABORT, 'disk full'); END");
    await expect(writeCloudSave(db, 'alice', request(0))).rejects.toThrow('disk full');
    expect((await readCloudSave(db, 'alice')).revision).toBe(0);
    expect(count('game_save_requests')).toBe(0);
  });
  it('caps save rate and receipt retention and cascades deletion', async () => {
    for (let revision = 0; revision < 120; revision++) await writeCloudSave(db, 'alice', request(revision));
    await expect(writeCloudSave(db, 'alice', request(120))).rejects.toThrow('Too many saves');
    expect(count('game_save_requests')).toBe(120);
    sqlite.exec("UPDATE game_save_requests SET created_at = 0");
    await writeCloudSave(db, 'alice', request(120));
    expect(count('game_save_requests')).toBe(120);
    sqlite.exec("DELETE FROM user WHERE id = 'alice'");
    for (const table of ['game_saves', 'game_save_versions', 'game_save_requests']) expect(count(table)).toBe(0);
  });
  it('cleans up expired auth data without deleting saved progress', async () => {
    const now = Date.now(); await writeCloudSave(db, 'alice', request(0));
    sqlite.prepare('INSERT INTO session(id, token, expires_at, created_at, updated_at, user_id) VALUES (?, ?, ?, 0, 0, ?)').run('old', 'old-token', 0, 'alice');
    sqlite.prepare('INSERT INTO session(id, token, expires_at, created_at, updated_at, user_id) VALUES (?, ?, ?, 0, 0, ?)').run('new', 'new-token', now + 1000, 'alice');
    sqlite.exec("INSERT INTO verification(id, identifier, value, expires_at, created_at, updated_at) VALUES ('old', 'old', 'opaque', 0, 0, 0)");
    sqlite.exec("INSERT INTO rate_limit(id, key, count, last_request) VALUES ('old', 'old', 1, 0)");
    sqlite.exec("INSERT INTO local_mail(recipient, subject, url, created_at) VALUES ('test@example.test', 'test', 'http://localhost', 0)");
    await cleanupAuth(db, now);
    expect(count('session')).toBe(1); expect(count('verification')).toBe(0);
    expect(count('rate_limit')).toBe(0); expect(count('local_mail')).toBe(0);
    expect((await readCloudSave(db, 'alice')).revision).toBe(1);
  });
  it('validates size and schema before accepting a client checkpoint', () => {
    expect(validateSaveRequest(request(0)).payload).toBe(payload);
    expect(() => validateSaveRequest(request(0, '{}'))).toThrow();
    expect(() => validateSaveRequest(request(0, 'a'.repeat(1048577)))).toThrow();
    expect(() => validateSaveRequest({ ...request(0), requestId: 'bad' })).toThrow();
  });
});
