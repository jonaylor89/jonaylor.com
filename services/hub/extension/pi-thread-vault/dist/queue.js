import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
export class UploadQueue {
    db;
    constructor(dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
        this.db = new Database(path.join(dataDir, "queue.db"));
        this.db.pragma("journal_mode = WAL");
        this.db.exec(`
      create table if not exists pending_events (
        id text primary key,
        thread_external_id text not null,
        event_hash text not null,
        payload_json text not null,
        status text not null default 'pending',
        attempt_count integer not null default 0,
        last_error text,
        created_at text not null,
        updated_at text not null
      );
      create unique index if not exists pending_events_event_hash_idx on pending_events(thread_external_id, event_hash);
    `);
    }
    enqueue(event) {
        const now = new Date().toISOString();
        this.db.prepare(`
      insert into pending_events (id, thread_external_id, event_hash, payload_json, status, attempt_count, created_at, updated_at)
      values (@id, @thread_external_id, @event_hash, @payload_json, 'pending', 0, @now, @now)
      on conflict(thread_external_id, event_hash) do nothing
    `).run({ ...event, now });
    }
    nextBatch(limit = 50) {
        const now = Date.now();
        const rows = this.db.prepare(`
      select * from pending_events
      where status in ('pending', 'failed')
      order by created_at
      limit ?
    `).all(limit);
        return rows.filter((event) => shouldRetry(event, now));
    }
    markSynced(ids) {
        if (ids.length === 0)
            return;
        const stmt = this.db.prepare("delete from pending_events where id = ?");
        const tx = this.db.transaction((values) => values.forEach((id) => stmt.run(id)));
        tx(ids);
    }
    markFailed(ids, error) {
        const now = new Date().toISOString();
        const stmt = this.db.prepare("update pending_events set status = 'failed', attempt_count = attempt_count + 1, last_error = ?, updated_at = ? where id = ?");
        const tx = this.db.transaction((values) => values.forEach((id) => stmt.run(error, now, id)));
        tx(ids);
    }
    stats() {
        return this.db.prepare("select count(*) as pending from pending_events").get();
    }
}
function shouldRetry(event, now) {
    if (event.status === "pending")
        return true;
    const updated = Date.parse(event.updated_at);
    const backoff = Math.min(60_000, 1000 * 2 ** event.attempt_count);
    return Number.isNaN(updated) || now - updated >= backoff;
}
