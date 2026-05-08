const ZERO_STATS = {
    api_keys: 0,
    auth_headers: 0,
    private_keys: 0,
    env_lines: 0,
    database_urls: 0,
};
const PATTERNS = [
    ["private_keys", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED:private-key]"],
    ["auth_headers", /\bAuthorization\s*:\s*(Bearer|Basic)\s+[^\s\n\r]+/gi, "Authorization: [REDACTED:auth-header]"],
    ["api_keys", /\bgh[pousr]_[A-Za-z0-9_]{30,}\b/g, "[REDACTED:github-token]"],
    ["api_keys", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:openai-key]"],
    ["api_keys", /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED:anthropic-key]"],
    ["api_keys", /\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-access-key]"],
    ["api_keys", /\b(?:api[_-]?key|token|secret|password)\b\s*[:=]\s*["']?[^"'\s]{16,}["']?/gi, "$1=[REDACTED:secret-value]"],
    ["database_urls", /\b(?:postgres(?:ql)?|mysql|mongodb|redis):\/\/[^\s"'<>]+/gi, "[REDACTED:database-url]"],
];
export function redactContent(input) {
    const stats = { ...ZERO_STATS };
    let content = redactEnvLines(input, stats);
    for (const [key, pattern, replacement] of PATTERNS) {
        content = content.replace(pattern, (...args) => {
            stats[key] += 1;
            if (replacement.includes("$1") && typeof args[1] === "string") {
                return replacement.replace("$1", args[1]);
            }
            return replacement;
        });
    }
    return { content, stats };
}
function redactEnvLines(input, stats) {
    return input.replace(/^([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|DSN|URL)[A-Z0-9_]*\s*=\s*).+$/gim, (_match, prefix) => {
        stats.env_lines += 1;
        return `${prefix}[REDACTED:env-value]`;
    });
}
export function mergeStats(stats) {
    return stats.reduce((acc, stat) => ({
        api_keys: acc.api_keys + stat.api_keys,
        auth_headers: acc.auth_headers + stat.auth_headers,
        private_keys: acc.private_keys + stat.private_keys,
        env_lines: acc.env_lines + stat.env_lines,
        database_urls: acc.database_urls + stat.database_urls,
    }), { ...ZERO_STATS });
}
