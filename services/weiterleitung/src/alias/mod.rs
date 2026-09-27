mod generator;
mod janitor;

pub use generator::{random_local_part, random_token};
pub use janitor::run_alias_cleanup_until_stopped;

use anyhow::Context;
use chrono::{DateTime, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::domain::EmailAddress;
use crate::mailbox::parse_timestamp;

#[derive(Debug, Clone)]
pub struct Alias {
    pub alias_id: String,
    pub address: String,
    pub mailbox_id: String,
    pub note: Option<String>,
    pub enabled: bool,
    pub forward_count: i64,
    pub reply_count: i64,
    pub blocked_count: i64,
    pub created_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub webhook_url: Option<String>,
}

/// An alias joined with the address of the mailbox it forwards to.
#[derive(Debug, Clone)]
pub struct AliasWithMailbox {
    pub alias: Alias,
    pub mailbox_email: String,
}

#[tracing::instrument(name = "Insert alias", skip(pool))]
pub async fn insert_alias(
    pool: &SqlitePool,
    address: &EmailAddress,
    mailbox_id: &str,
    note: Option<String>,
    expires_at: Option<DateTime<Utc>>,
    webhook_url: Option<String>,
) -> Result<Alias, anyhow::Error> {
    let alias_id = Uuid::new_v4().to_string();
    let address = address.normalised();
    let created_at = Utc::now();
    let created_at_str = created_at.to_rfc3339();
    let expires_at_str = expires_at.map(|t| t.to_rfc3339());

    sqlx::query!(
        r#"
        INSERT INTO aliases (alias_id, address, mailbox_id, note, enabled, created_at, expires_at, webhook_url)
        VALUES (?, ?, ?, ?, 1, ?, ?, ?)
        "#,
        alias_id,
        address,
        mailbox_id,
        note,
        created_at_str,
        expires_at_str,
        webhook_url,
    )
    .execute(pool)
    .await
    .context("Failed to insert the alias")?;

    Ok(Alias {
        alias_id,
        address,
        mailbox_id: mailbox_id.to_string(),
        note,
        enabled: true,
        forward_count: 0,
        reply_count: 0,
        blocked_count: 0,
        created_at,
        last_used_at: None,
        expires_at,
        webhook_url,
    })
}

#[tracing::instrument(name = "Find alias by address", skip(pool))]
pub async fn find_alias_by_address(
    pool: &SqlitePool,
    address: &EmailAddress,
) -> Result<Option<AliasWithMailbox>, anyhow::Error> {
    let address = address.normalised();
    let row = sqlx::query!(
        r#"
        SELECT
            a.alias_id, a.address, a.mailbox_id, a.note, a.enabled,
            a.forward_count, a.reply_count, a.blocked_count,
            a.created_at, a.last_used_at, a.expires_at, a.webhook_url,
            m.email AS mailbox_email
        FROM aliases a
        JOIN mailboxes m ON m.mailbox_id = a.mailbox_id
        WHERE a.address = ?
        "#,
        address
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| AliasWithMailbox {
        alias: Alias {
            alias_id: row.alias_id,
            address: row.address,
            mailbox_id: row.mailbox_id,
            note: row.note,
            enabled: row.enabled != 0,
            forward_count: row.forward_count,
            reply_count: row.reply_count,
            blocked_count: row.blocked_count,
            created_at: parse_timestamp(&row.created_at),
            last_used_at: row.last_used_at.as_deref().map(parse_timestamp),
            expires_at: row.expires_at.as_deref().map(parse_timestamp),
            webhook_url: row.webhook_url,
        },
        mailbox_email: row.mailbox_email,
    }))
}

/// Looks up one alias by primary key, joined with its mailbox address.
#[tracing::instrument(name = "Get alias", skip(pool))]
pub async fn get_alias(
    pool: &SqlitePool,
    alias_id: &str,
) -> Result<Option<AliasWithMailbox>, anyhow::Error> {
    let row = sqlx::query!(
        r#"
        SELECT
            a.alias_id, a.address, a.mailbox_id, a.note, a.enabled,
            a.forward_count, a.reply_count, a.blocked_count,
            a.created_at, a.last_used_at, a.expires_at, a.webhook_url,
            m.email AS mailbox_email
        FROM aliases a
        JOIN mailboxes m ON m.mailbox_id = a.mailbox_id
        WHERE a.alias_id = ?
        "#,
        alias_id
    )
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|row| AliasWithMailbox {
        alias: Alias {
            alias_id: row.alias_id,
            address: row.address,
            mailbox_id: row.mailbox_id,
            note: row.note,
            enabled: row.enabled != 0,
            forward_count: row.forward_count,
            reply_count: row.reply_count,
            blocked_count: row.blocked_count,
            created_at: parse_timestamp(&row.created_at),
            last_used_at: row.last_used_at.as_deref().map(parse_timestamp),
            expires_at: row.expires_at.as_deref().map(parse_timestamp),
            webhook_url: row.webhook_url,
        },
        mailbox_email: row.mailbox_email,
    }))
}

#[tracing::instrument(name = "List aliases", skip(pool))]
pub async fn list_aliases(pool: &SqlitePool) -> Result<Vec<AliasWithMailbox>, anyhow::Error> {
    let rows = sqlx::query!(
        r#"
        SELECT
            a.alias_id, a.address, a.mailbox_id, a.note, a.enabled,
            a.forward_count, a.reply_count, a.blocked_count,
            a.created_at, a.last_used_at, a.expires_at, a.webhook_url,
            m.email AS mailbox_email
        FROM aliases a
        JOIN mailboxes m ON m.mailbox_id = a.mailbox_id
        ORDER BY a.created_at DESC
        "#
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| AliasWithMailbox {
            alias: Alias {
                alias_id: row.alias_id,
                address: row.address,
                mailbox_id: row.mailbox_id,
                note: row.note,
                enabled: row.enabled != 0,
                forward_count: row.forward_count,
                reply_count: row.reply_count,
                blocked_count: row.blocked_count,
                created_at: parse_timestamp(&row.created_at),
                last_used_at: row.last_used_at.as_deref().map(parse_timestamp),
                expires_at: row.expires_at.as_deref().map(parse_timestamp),
                webhook_url: row.webhook_url,
            },
            mailbox_email: row.mailbox_email,
        })
        .collect())
}

#[tracing::instrument(name = "Set alias enabled", skip(pool))]
pub async fn set_alias_enabled(
    pool: &SqlitePool,
    alias_id: &str,
    enabled: bool,
) -> Result<(), anyhow::Error> {
    let enabled = i64::from(enabled);
    sqlx::query!(
        "UPDATE aliases SET enabled = ? WHERE alias_id = ?",
        enabled,
        alias_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

#[tracing::instrument(name = "Delete alias", skip(pool))]
pub async fn delete_alias(pool: &SqlitePool, alias_id: &str) -> Result<(), anyhow::Error> {
    sqlx::query!("DELETE FROM aliases WHERE alias_id = ?", alias_id)
        .execute(pool)
        .await?;
    Ok(())
}

/// PATCH-style update: only the `Some` fields are written. `clear_note`,
/// `clear_webhook_url` and `clear_expires_at` set the column to NULL when the
/// caller wants to remove a value rather than leave it untouched.
#[derive(Debug, Default, Clone)]
pub struct AliasUpdate {
    pub enabled: Option<bool>,
    pub note: Option<String>,
    pub clear_note: bool,
    pub webhook_url: Option<String>,
    pub clear_webhook_url: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub clear_expires_at: bool,
}

#[tracing::instrument(name = "Update alias", skip(pool))]
pub async fn update_alias(
    pool: &SqlitePool,
    alias_id: &str,
    update: AliasUpdate,
) -> Result<(), anyhow::Error> {
    // The SET clause is built dynamically, so this cannot use the `query!`
    // macro; it stays type-checked through `QueryBuilder`'s bind API.
    let mut query = sqlx::QueryBuilder::<sqlx::Sqlite>::new("UPDATE aliases SET ");
    let mut separated = query.separated(", ");
    let mut wrote = false;

    if let Some(enabled) = update.enabled {
        separated
            .push("enabled = ")
            .push_bind_unseparated(i64::from(enabled));
        wrote = true;
    }
    if update.clear_note {
        separated.push("note = NULL");
        wrote = true;
    } else if let Some(note) = update.note {
        separated.push("note = ").push_bind_unseparated(note);
        wrote = true;
    }
    if update.clear_webhook_url {
        separated.push("webhook_url = NULL");
        wrote = true;
    } else if let Some(webhook_url) = update.webhook_url {
        separated
            .push("webhook_url = ")
            .push_bind_unseparated(webhook_url);
        wrote = true;
    }
    if update.clear_expires_at {
        separated.push("expires_at = NULL");
        wrote = true;
    } else if let Some(expires_at) = update.expires_at {
        separated
            .push("expires_at = ")
            .push_bind_unseparated(expires_at.to_rfc3339());
        wrote = true;
    }

    if !wrote {
        return Ok(());
    }

    query.push(" WHERE alias_id = ").push_bind(alias_id);
    query.build().execute(pool).await?;
    Ok(())
}

/// Deletes every alias whose `expires_at` is in the past. Returns rows deleted.
#[tracing::instrument(name = "Delete expired aliases", skip(pool))]
pub async fn delete_expired_aliases(pool: &SqlitePool) -> Result<u64, anyhow::Error> {
    let now = Utc::now().to_rfc3339();
    let result = sqlx::query!(
        "DELETE FROM aliases WHERE expires_at IS NOT NULL AND expires_at <= ?",
        now
    )
    .execute(pool)
    .await?;
    Ok(result.rows_affected())
}

/// Counter bumped after a message is accepted for an alias.
#[derive(Debug, Clone, Copy)]
pub enum AliasCounter {
    Forwarded,
    Replied,
    Blocked,
}

#[tracing::instrument(name = "Record alias activity", skip(pool))]
pub async fn record_alias_activity(
    pool: &SqlitePool,
    alias_id: &str,
    counter: AliasCounter,
) -> Result<(), anyhow::Error> {
    let now = Utc::now().to_rfc3339();
    match counter {
        AliasCounter::Forwarded => {
            sqlx::query!(
                "UPDATE aliases SET forward_count = forward_count + 1, last_used_at = ? WHERE alias_id = ?",
                now,
                alias_id
            )
            .execute(pool)
            .await?;
        }
        AliasCounter::Replied => {
            sqlx::query!(
                "UPDATE aliases SET reply_count = reply_count + 1, last_used_at = ? WHERE alias_id = ?",
                now,
                alias_id
            )
            .execute(pool)
            .await?;
        }
        AliasCounter::Blocked => {
            sqlx::query!(
                "UPDATE aliases SET blocked_count = blocked_count + 1, last_used_at = ? WHERE alias_id = ?",
                now,
                alias_id
            )
            .execute(pool)
            .await?;
        }
    }
    Ok(())
}
