import { createAuthClient } from 'better-auth/client';
import type { CloudSnapshot, CloudTransport, SaveRequest } from './types';

export function createPlayerAuth() {
  return createAuthClient({
    baseURL: location.origin, basePath: '/api/auth',
    fetchOptions: { credentials: 'same-origin', cache: 'no-store', timeout: 5_000 },
  });
}
export type PlayerAuth = ReturnType<typeof createPlayerAuth>;
export interface PlayerIdentity { id: string; email: string }

export function snapshot(value: unknown): CloudSnapshot {
  const s = value as CloudSnapshot | null;
  if (!s || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      !(s.payload === null || typeof s.payload === 'string') ||
      typeof s.device !== 'string' || typeof s.updatedAt !== 'string') throw new Error('Invalid cloud-save response');
  return s;
}
export class WorkerSaves implements CloudTransport {
  constructor(private owner: string) {}
  private async request(path: string, body?: SaveRequest): Promise<unknown> {
    if (!navigator.onLine) throw new Error('Offline. Your local checkpoint is safe; sign in again if your session expires.');
    const response = await fetch('/api/save' + path, {
      method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      headers: { 'X-Game-Account': this.owner, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? 'Cloud save request failed (' + response.status + ')');
    return result;
  }
  async read() { return snapshot(await this.request('')); }
  async write(request: SaveRequest) {
    const result = await this.request('', request) as { status: 'saved' | 'conflict'; snapshot: unknown };
    if (!['saved', 'conflict'].includes(result.status)) throw new Error('Invalid save acknowledgement');
    return { status: result.status, snapshot: snapshot(result.snapshot) };
  }
  async history(): Promise<CloudSnapshot[]> {
    const rows = await this.request('/history');
    if (!Array.isArray(rows)) throw new Error('Invalid save history');
    return rows.map(snapshot);
  }
}
