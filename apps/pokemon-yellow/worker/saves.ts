import type { D1Database } from '@cloudflare/workers-types';
import { deserializeSave } from '../src/game/save';
import type { CloudSnapshot, SaveRequest } from '../src/cloud/types';

type Row = { revision: number; payload: string | null; device: string; updated_at: string };
type Receipt = { expected_revision: number; payload: string | null; device: string; updated_at: string };
const convert = (row: Row): CloudSnapshot => ({ revision: row.revision, payload: row.payload, device: row.device, updatedAt: row.updated_at });
export const noSave = (): CloudSnapshot => ({ revision: 0, payload: null, device: '', updatedAt: '' });

export function validateSaveRequest(value: unknown): SaveRequest {
  const r = value as SaveRequest | null;
  if (!r || !Number.isSafeInteger(r.expectedRevision) || r.expectedRevision < 0 || r.expectedRevision >= Number.MAX_SAFE_INTEGER ||
      typeof r.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(r.requestId) ||
      typeof r.device !== 'string' || r.device.length > 80 ||
      !(r.payload === null || typeof r.payload === 'string')) throw new Error('Invalid save request');
  if (r.payload !== null) deserializeSave(r.payload);
  return r;
}
export async function readCloudSave(db: D1Database, owner: string): Promise<CloudSnapshot> {
  const row = await db.prepare('SELECT revision, payload, device, updated_at FROM game_saves WHERE owner = ?').bind(owner).first<Row>();
  return row ? convert(row) : noSave();
}
export async function cloudHistory(db: D1Database, owner: string): Promise<CloudSnapshot[]> {
  const rows = await db.prepare('SELECT revision, payload, device, updated_at FROM game_save_versions WHERE owner = ? ORDER BY revision DESC LIMIT 20').bind(owner).all<Row>();
  return rows.results.map(convert);
}
export class RequestReuseError extends Error {}
export class SaveRateError extends Error {}
export async function writeCloudSave(db: D1Database, owner: string, request: SaveRequest) {
  const receipt = async () => {
    const row = await db.prepare('SELECT expected_revision, payload, device, updated_at FROM game_save_requests WHERE owner = ? AND request_id = ?')
      .bind(owner, request.requestId).first<Receipt>();
    if (!row) return undefined;
    if (row.expected_revision !== request.expectedRevision || row.payload !== request.payload || row.device !== request.device) {
      throw new RequestReuseError('Request ID reused with different content');
    }
    return { status: 'saved' as const, snapshot: { revision: row.expected_revision + 1, payload: row.payload, device: row.device, updatedAt: row.updated_at } };
  };
  const previous = await receipt();
  if (previous) return previous;
  const now = new Date();
  try {
    await db.prepare('INSERT INTO game_save_requests(owner, request_id, expected_revision, payload, device, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(owner, request.requestId, request.expectedRevision, request.payload, request.device, now.getTime(), now.toISOString()).run();
  } catch (error) {
    // Concurrent retries may both miss the receipt before INSERT. Re-read it first.
    const retried = await receipt();
    if (retried) return retried;
    const message = String(error);
    if (message.includes('save_revision_conflict')) return { status: 'conflict' as const, snapshot: await readCloudSave(db, owner) };
    if (message.includes('save_rate_limit')) throw new SaveRateError('Too many saves. Please wait a minute.');
    throw error;
  }
  return { status: 'saved' as const, snapshot: { revision: request.expectedRevision + 1, payload: request.payload, device: request.device, updatedAt: now.toISOString() } };
}
