/** The server stores the original save text: JSONB would reorder checksum input. */
export interface CloudSnapshot {
  revision: number;
  payload: string | null;
  device: string;
  updatedAt: string;
}
export interface SaveRequest {
  expectedRevision: number;
  requestId: string;
  payload: string | null;
  device: string;
}
export interface CloudTransport {
  read(): Promise<CloudSnapshot>;
  write(request: SaveRequest): Promise<{ status: 'saved' | 'conflict'; snapshot: CloudSnapshot }>;
  history(): Promise<CloudSnapshot[]>;
}
export interface PendingSave extends SaveRequest {}
export interface LocalJournal {
  version: 1;
  revision: number;
  payload: string | null;
  pending?: PendingSave;
  conflict?: CloudSnapshot;
  backups: { payload: string | null; savedAt: string; reason: string }[];
}
export type SyncStatus = 'local' | 'pending' | 'syncing' | 'synced' | 'conflict' | 'error';
