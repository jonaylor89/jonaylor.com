import { type VaultConfig } from "./config.js";
import { VaultClient, type CurrentThreadContext } from "./client.js";
import { UploadQueue } from "./queue.js";
interface PiLikeApi {
    on?: (event: string, handler: (event: unknown, ctx: unknown) => unknown | Promise<unknown>) => void;
    registerCommand?: (name: string, command: {
        description: string;
        handler: (args: string, ctx: unknown) => unknown | Promise<unknown>;
    }) => void;
    events?: {
        emit?: (event: string, payload: unknown) => void;
    };
    hooks?: {
        onSessionStart?: (handler: (session: unknown) => void | Promise<void>) => void;
        onEvent?: (handler: (event: unknown, session: unknown) => void | Promise<void>) => void;
        onSessionEnd?: (handler: (session: unknown) => void | Promise<void>) => void;
    };
    commands?: {
        register: (name: string, handler: (...args: unknown[]) => unknown | Promise<unknown>) => void;
    };
    handoff?: {
        provideCurrentThreadContext?: (provider: (sessionExternalId: string) => CurrentThreadContext | undefined) => void;
        transformPrompt?: (handler: (prompt: string, sessionExternalId: string) => string) => void;
    };
    logger?: {
        info: (...args: unknown[]) => void;
        warn: (...args: unknown[]) => void;
    };
}
export default function piThreadVault(pi: PiLikeApi): void;
export declare function activate(pi: PiLikeApi, extensionConfig?: Partial<VaultConfig>): {
    client: VaultClient;
    queue: UploadQueue;
};
export {};
