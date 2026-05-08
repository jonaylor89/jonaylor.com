export interface RedactionStats {
    api_keys: number;
    auth_headers: number;
    private_keys: number;
    env_lines: number;
    database_urls: number;
}
export interface RedactionResult {
    content: string;
    stats: RedactionStats;
}
export declare function redactContent(input: string): RedactionResult;
export declare function mergeStats(stats: RedactionStats[]): RedactionStats;
