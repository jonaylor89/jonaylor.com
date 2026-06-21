use crate::domain::ApiToken;
use crate::vault::now_rfc3339;
use axum::http::{HeaderMap, StatusCode, header};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::PgPool;

type HmacSha256 = Hmac<Sha256>;

/// Validates a Bearer token in the Authorization header against the `vault_clients` table.
/// Returns the matching client_id and updates its `last_seen_at` on success.
pub async fn require_api_token(headers: &HeaderMap, pool: &PgPool) -> Result<String, StatusCode> {
    let token = bearer_token(headers).ok_or(StatusCode::UNAUTHORIZED)?;
    let token = ApiToken::parse(token.to_string()).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let hash = token.hash();
    let client_id: Option<String> = sqlx::query_scalar(
        "SELECT id FROM vault_clients WHERE api_token_hash = $1 AND revoked_at IS NULL",
    )
    .bind(hash.as_ref())
    .fetch_optional(pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let client_id = client_id.ok_or(StatusCode::UNAUTHORIZED)?;
    let now = now_rfc3339();
    sqlx::query("UPDATE vault_clients SET last_seen_at = $1 WHERE id = $2")
        .bind(now)
        .bind(&client_id)
        .execute(pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(client_id)
}

pub fn sign(value: &str, secret: &str) -> String {
    let mut mac = HmacSha256::new_from_slice(secret.as_bytes()).expect("HMAC accepts any key size");
    mac.update(value.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

pub fn verify_signature(value: &str, signature: &str, secret: &str) -> bool {
    sign(value, secret) == signature
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(header::AUTHORIZATION)?
        .to_str()
        .ok()?
        .strip_prefix("Bearer ")
}
