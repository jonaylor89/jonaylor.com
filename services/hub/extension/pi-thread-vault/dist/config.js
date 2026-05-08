import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export function loadConfig(extensionConfig = {}) {
    const fileConfig = readTomlLikeConfig(path.join(os.homedir(), ".pi-thread-vault", "config.toml"));
    return {
        serverUrl: extensionConfig.serverUrl ?? fileConfig.server_url ?? process.env.PI_THREAD_VAULT_SERVER_URL ?? "http://127.0.0.1:4378",
        apiToken: extensionConfig.apiToken ?? fileConfig.api_token ?? process.env.PI_THREAD_VAULT_API_TOKEN ?? "ptv_dev_token",
        defaultVisibility: (extensionConfig.defaultVisibility ?? fileConfig.default_visibility ?? "private"),
        dataDir: extensionConfig.dataDir ?? fileConfig.data_dir ?? path.join(os.homedir(), ".pi-thread-vault", "extension"),
        clientId: extensionConfig.clientId ?? fileConfig.client_id ?? os.hostname(),
        redaction: { enabled: extensionConfig.redaction?.enabled ?? fileConfig.redaction_enabled !== "false" },
    };
}
function readTomlLikeConfig(filePath) {
    if (!fs.existsSync(filePath))
        return {};
    const out = {};
    for (const rawLine of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#") || line.startsWith("["))
            continue;
        const match = line.match(/^([A-Za-z0-9_]+)\s*=\s*"?([^"#]+)"?/);
        if (match)
            out[match[1]] = match[2].trim();
    }
    return out;
}
