export interface PendingEvent {
    id: string;
    thread_external_id: string;
    event_hash: string;
    payload_json: string;
    status: "pending" | "syncing" | "failed";
    attempt_count: number;
    last_error?: string;
    created_at: string;
    updated_at: string;
}
export declare class UploadQueue {
    private db;
    constructor(dataDir: string);
    enqueue(event: Omit<PendingEvent, "status" | "attempt_count" | "created_at" | "updated_at">): void;
    nextBatch(limit?: number): PendingEvent[];
    markSynced(ids: string[]): void;
    markFailed(ids: string[], error: string): void;
    stats(): {
        pending: number;
    };
}
