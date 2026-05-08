import type { VaultConfig } from "./config.js";
import type { UploadQueue } from "./queue.js";
export interface NormalizedSession {
    external_session_id: string;
    title?: string;
    cwd?: string;
    repo_remote?: string;
    repo_branch?: string;
    repo_head?: string;
}
export interface NormalizedEvent {
    external_event_id?: string;
    parent_external_event_id?: string | null;
    event_hash: string;
    role: string;
    kind: string;
    content?: string;
    metadata: Record<string, unknown>;
    created_at: string;
}
export interface CurrentThreadContext {
    threadId: string;
    threadUrl: string;
    serverUrl: string;
    sessionExternalId: string;
    lastSyncedEventId?: string;
}
export declare class VaultClient {
    private readonly config;
    private readonly queue;
    private currentContexts;
    constructor(config: VaultConfig, queue: UploadQueue);
    currentThreadContext(sessionExternalId: string): CurrentThreadContext | undefined;
    flush(session: NormalizedSession): Promise<void>;
    recordHandoff(input: {
        sourceThreadId: string;
        targetExternalSessionId?: string;
        goal: string;
        generatedPrompt: string;
        sourceEventIds?: string[];
    }): Promise<void>;
}
