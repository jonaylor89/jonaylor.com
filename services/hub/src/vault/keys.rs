use crate::vault::{new_id, now_rfc3339, token_hash};
use anyhow::{Context, Result};
use rand::RngCore;
use sqlx::PgPool;

/// Prefix shared by every key issued for the vault. Lets log scanners /
/// secret-detection tools (GitHub, Gitleaks, etc.) recognise leaks.
pub const TOKEN_PREFIX: &str = "ptv_";

/// How many characters of the plaintext token to store unhashed for display in
/// the admin UI. Includes the `ptv_` tag plus a handful of random chars — enough
/// to disambiguate keys in a list without coming close to a useful secret leak.
pub const TOKEN_PREFIX_DISPLAY_LEN: usize = 12;

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
    let name = name.trim();
    anyhow::ensure!(!name.is_empty(), "client name is required");

    let plaintext_token = generate_token();
    let hash = token_hash(&plaintext_token);
    let prefix = display_prefix(&plaintext_token);
    let client_id = new_id("clt");
    let now = now_rfc3339();

    sqlx::query(
        r#"INSERT INTO vault_clients (id, name, api_token_hash, token_prefix, created_at)
           VALUES ($1, $2, $3, $4, $5)"#,
    )
    .bind(&client_id)
    .bind(name)
    .bind(&hash)
    .bind(&prefix)
    .bind(&now)
    .execute(pool)
    .await
    .context("failed to insert vault_clients row")?;

    Ok(GeneratedKey {
        client_id,
        name: name.to_string(),
        plaintext_token,
        token_prefix: prefix,
        created_at: now,
    })
}

/// Soft-deletes a client by setting `revoked_at`. The matching token will no
/// longer authenticate (the auth lookup filters revoked rows).
pub async fn revoke_api_key(pool: &PgPool, client_id: &str) -> Result<bool> {
    let now = now_rfc3339();
    let result = sqlx::query(
        r#"UPDATE vault_clients
              SET revoked_at = $1
            WHERE id = $2
              AND revoked_at IS NULL"#,
    )
    .bind(&now)
    .bind(client_id)
    .execute(pool)
    .await
    .context("failed to revoke vault client")?;

    Ok(result.rows_affected() > 0)
}

pub fn generate_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    format!(
        "{TOKEN_PREFIX}{}",
        base64::encode_config(bytes, base64::URL_SAFE_NO_PAD)
    )
}

fn display_prefix(token: &str) -> String {
    token
        .chars()
        .take(TOKEN_PREFIX_DISPLAY_LEN)
        .collect::<String>()
}
