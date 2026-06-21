use crate::domain::{ApiClientId, ApiClientName, ApiToken};
use crate::vault::now_rfc3339;
use anyhow::{Context, Result};
use sqlx::PgPool;

/// The plaintext token surfaced to the operator exactly once at creation time.
pub struct GeneratedKey {
    pub client_id: String,
    pub name: String,
    pub plaintext_token: String,
    pub token_prefix: String,
    pub created_at: String,
}

/// Mints a new API key, persists only its SHA-256 hash, and returns the
/// plaintext to the caller. The caller is responsible for showing the secret
/// to the user once — it cannot be recovered later.
pub async fn issue_api_key(pool: &PgPool, name: &str) -> Result<GeneratedKey> {
    let name = ApiClientName::parse(name.to_string()).map_err(anyhow::Error::msg)?;
    let token = ApiToken::generate();
    let hash = token.hash();
    let prefix = token.display_prefix();
    let client_id = ApiClientId::generate();
    let now = now_rfc3339();

    sqlx::query(
        r#"INSERT INTO vault_clients (id, name, api_token_hash, token_prefix, created_at)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(client_id.as_ref())
    .bind(name.as_ref())
    .bind(hash.as_ref())
    .bind(&prefix)
    .bind(&now)
    .execute(pool)
    .await
    .context("failed to insert vault_clients row")?;

    Ok(GeneratedKey {
        client_id: client_id.to_string(),
        name: name.to_string(),
        plaintext_token: token.expose_secret().to_string(),
        token_prefix: prefix,
        created_at: now,
    })
}

/// Soft-deletes a client by setting `revoked_at`. The matching token will no
/// longer authenticate (the auth lookup filters revoked rows).
pub async fn revoke_api_key(pool: &PgPool, client_id: &str) -> Result<bool> {
    let client_id = ApiClientId::parse(client_id.to_string()).map_err(anyhow::Error::msg)?;
    let now = now_rfc3339();
    let result = sqlx::query(
        r#"UPDATE vault_clients
              SET revoked_at = $1
            WHERE id = $2
              AND revoked_at IS NULL"#,
    )
    .bind(&now)
    .bind(client_id.as_ref())
    .execute(pool)
    .await
    .context("failed to revoke vault client")?;

    Ok(result.rows_affected() > 0)
}

pub fn generate_token() -> String {
    ApiToken::generate().expose_secret().to_string()
}
