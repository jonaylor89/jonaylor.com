pub mod api;
pub mod auth;
pub mod keys;
pub mod search;
pub mod templates;
pub mod web;

use sha2::{Digest, Sha256};

pub fn now_rfc3339() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
}

pub fn new_id(prefix: &str) -> String {
    format!("{}_{}", prefix, uuid::Uuid::new_v4().simple())
}

pub fn token_hash(value: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("sha256:{}", hex::encode(hasher.finalize()))
}

/// Postgres TEXT columns refuse NUL bytes; coding-agent sessions occasionally embed them
/// inside captured stdout/binary content. Strip them before insert so the payload survives.
pub fn strip_nuls(s: &str) -> String {
    if s.contains('\0') {
        s.replace('\0', "")
    } else {
        s.to_string()
    }
}

pub fn strip_nuls_opt(s: Option<String>) -> Option<String> {
    s.map(|value| strip_nuls(&value))
}

pub fn strip_nuls_json(value: &mut serde_json::Value) {
    match value {
        serde_json::Value::String(s) if s.contains('\0') => *s = s.replace('\0', ""),
        serde_json::Value::Array(items) => items.iter_mut().for_each(strip_nuls_json),
        serde_json::Value::Object(map) => map.values_mut().for_each(strip_nuls_json),
        _ => {}
    }
}

/// Creates the on-disk blob directories used by the vault for raw event/redacted-session/handoff dumps.
pub async fn prepare_blob_dirs(data_dir: &std::path::Path) -> Result<(), std::io::Error> {
    tokio::fs::create_dir_all(data_dir.join("blobs/events")).await?;
    tokio::fs::create_dir_all(data_dir.join("blobs/redacted_sessions")).await?;
    tokio::fs::create_dir_all(data_dir.join("blobs/handoffs")).await?;
    Ok(())
}
