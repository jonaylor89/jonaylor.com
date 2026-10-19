/**
 * Save files: versioned, checksummed JSON in IndexedDB ("saves" store),
 * mirrored to localStorage as a fallback for browsers that evict IndexedDB.
 */
import { idbGet, idbKeys, idbPut, idbDelete, STORES } from '../data/db';
import { migrateState, STATE_VERSION, type GameState } from './state';
import { validSaveState } from './saveValidation';

export interface SaveFile {
  format: 'pokeyellow-web-save';
  version: number;
  savedAt: string;
  checksum: string;
  state: GameState;
}

export class SaveError extends Error {}

/** FNV-1a 32-bit over the canonical JSON — detects corruption, not tampering. */
export function checksum(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function serializeSave(state: GameState, now = new Date()): string {
  const body = JSON.stringify(state);
  const file: SaveFile = {
    format: 'pokeyellow-web-save',
    version: STATE_VERSION,
    savedAt: now.toISOString(),
    checksum: checksum(body),
    state,
  };
  return JSON.stringify(file);
}

export function deserializeSave(text: string): SaveFile {
  if (text.length > 1048576 || new TextEncoder().encode(text).length > 1048576) throw new SaveError('save exceeds 1 MiB');
  let file: SaveFile;
  try {
    file = JSON.parse(text);
  } catch {
    throw new SaveError('save file is not valid JSON');
  }
  if (!file || typeof file !== 'object' || Array.isArray(file)) throw new SaveError('not a save object');
  if (file.format !== 'pokeyellow-web-save') throw new SaveError('not a pokeyellow-web save');
  if (!Number.isInteger(file.version) || file.version > STATE_VERSION || file.version < 1) throw new SaveError(`unsupported save version ${file.version}`);
  if (typeof file.savedAt !== 'string' || file.savedAt.length > 64 || !Number.isFinite(Date.parse(file.savedAt)) || !validSaveState(file.state, file.version)) throw new SaveError('malformed save state');
  if (checksum(JSON.stringify(file.state)) !== file.checksum) throw new SaveError('save checksum mismatch (corrupted)');
  file.state = migrateState(file.state);
  file.version = STATE_VERSION;
  return file;
}

/** Application-installed persistence; tests/local development retain the legacy slot. */
export interface SaveBackend {
  read(slot: string): Promise<SaveFile | undefined>;
  write(slot: string, state: GameState): Promise<void>;
  delete(slot: string): Promise<void>;
}
let backend: SaveBackend | undefined;
export function setSaveBackend(next: SaveBackend | undefined): void { backend = next; }

const LS_PREFIX = 'pokeyellow-web:save:';

export async function writeSave(slot: string, state: GameState): Promise<void> {
  if (backend) return backend.write(slot, state);
  return writeLocalSave(slot, state);
}

export async function writeLocalSave(slot: string, state: GameState): Promise<void> {
  const text = serializeSave(state);
  await idbPut(STORES.saves, slot, text);
  try {
    globalThis.localStorage?.setItem(LS_PREFIX + slot, text);
  } catch {
    /* quota exceeded or unavailable: IndexedDB copy is authoritative */
  }
}

export async function readSave(slot: string): Promise<SaveFile | undefined> {
  if (backend) return backend.read(slot);
  return readLegacySave(slot);
}

export async function readLegacySave(slot: string): Promise<SaveFile | undefined> {
  let text = await idbGet<string>(STORES.saves, slot).catch(() => undefined);
  if (!text) {
    try {
      text = globalThis.localStorage?.getItem(LS_PREFIX + slot) ?? undefined;
    } catch {
      text = undefined;
    }
  }
  return text ? deserializeSave(text) : undefined;
}

export async function listSaves(): Promise<string[]> {
  if (backend) return await backend.read('slot1') ? ['slot1'] : [];
  return idbKeys(STORES.saves);
}

export async function deleteSave(slot: string): Promise<void> {
  if (backend) return backend.delete(slot);
  return deleteLocalSave(slot);
}

export async function deleteLocalSave(slot: string): Promise<void> {
  await idbDelete(STORES.saves, slot);
  try {
    globalThis.localStorage?.removeItem(LS_PREFIX + slot);
  } catch {
    /* ignore */
  }
}
