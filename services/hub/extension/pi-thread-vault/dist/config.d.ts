export interface VaultConfig {
    serverUrl: string;
    apiToken: string;
    defaultVisibility: "private" | "public";
    dataDir: string;
    clientId: string;
    redaction: {
        enabled: boolean;
    };
    memory: {
        enabled: boolean;
        userId: string;
    };
}
export declare function loadConfig(extensionConfig?: Partial<VaultConfig>): VaultConfig;
