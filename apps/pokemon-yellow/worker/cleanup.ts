import type { D1Database } from '@cloudflare/workers-types';

/** Retain game checkpoints/receipts; only prune expired auth and development-mail data. */
export async function cleanupAuth(db: D1Database, now = Date.now()): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM session WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM verification WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM rate_limit WHERE last_request < ?').bind(now - 24 * 60 * 60 * 1000),
    db.prepare('DELETE FROM local_mail WHERE created_at < ?').bind(now - 24 * 60 * 60 * 1000),
  ]);
}
