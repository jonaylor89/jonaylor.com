use anyhow::Context;
use chrono::{DateTime, Duration, Utc};
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::mailbox::parse_timestamp;
use crate::webhook::payload::InboundPayload;

/// A webhook POST accepted by the inbound router and waiting to go out.
#[derive(Debug, Clone)]
pub struct QueuedDelivery {
    pub delivery_id: String,
    pub alias_id: Option<String>,
    pub url: String,
    pub payload: String,
    pub status: String,
    pub attempts: i64,
    pub last_error: Option<String>,
    pub created_at: DateTime<Utc>,
}

/// Queues a webhook delivery for an alias's endpoint.
#[tracing::instrument(name = "Enqueue webhook delivery", skip(pool, payload))]
pub async fn enqueue(
    pool: &SqlitePool,
    alias_id: &str,
    url: &str,
    payload: &InboundPayload,
) -> Result<String, anyhow::Error> {
    let delivery_id = Uuid::new_v4().to_string();
    let payload =
        serde_json::to_string(payload).context("Failed to serialise the webhook payload")?;
    let now = Utc::now().to_rfc3339();

    sqlx::query!(
        r#"
        INSERT INTO webhook_deliveries (
            delivery_id, alias_id, url, payload, status, attempts, next_attempt_at, created_at
        )
        VALUES (?, ?, ?, ?, 'pending', 0, ?, ?)
        "#,
        delivery_id,
        alias_id,
        url,
        payload,
        now,
        now,
    )
    .execute(pool)
    .await
    .context("Failed to enqueue the webhook delivery")?;

    Ok(delivery_id)
}

/// Atomically claims webhook deliveries whose retry time has come.
#[tracing::instrument(name = "Claim due webhook deliveries", skip(pool))]
pub async fn claim_due(
    pool: &SqlitePool,
    limit: i64,
) -> Result<Vec<QueuedDelivery>, anyhow::Error> {
    let now = Utc::now().to_rfc3339();
    let mut tx = pool.begin().await?;

    let rows = sqlx::query!(
        r#"
        SELECT
            delivery_id, alias_id, url, payload, status, attempts, last_error, created_at
        FROM webhook_deliveries
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at ASC
        LIMIT ?
        "#,
        now,
        limit
    )
    .fetch_all(&mut *tx)
    .await?;

    let deliveries: Vec<QueuedDelivery> = rows
        .into_iter()
        .map(|row| QueuedDelivery {
            delivery_id: row.delivery_id,
            alias_id: row.alias_id,
            url: row.url,
            payload: row.payload,
            status: row.status,
            attempts: row.attempts,
            last_error: row.last_error,
            created_at: parse_timestamp(&row.created_at),
        })
        .collect();

    for delivery in &deliveries {
        sqlx::query!(
            "UPDATE webhook_deliveries SET status = 'sending' WHERE delivery_id = ?",
            delivery.delivery_id
        )
        .execute(&mut *tx)
        .await?;
    }

    tx.commit().await?;
    Ok(deliveries)
}

/// Deliveries are marked `sending` while the worker holds them, so a crash or
/// a restart mid-delivery would strand them there forever. Returning them to
/// the queue on startup costs at most a duplicate POST, which the retry logic
/// can produce anyway.
#[tracing::instrument(name = "Requeue interrupted webhook deliveries", skip(pool))]
pub async fn requeue_interrupted(pool: &SqlitePool) -> Result<u64, anyhow::Error> {
    let now = Utc::now().to_rfc3339();
    let requeued = sqlx::query!(
        r#"
        UPDATE webhook_deliveries
        SET status = 'pending', next_attempt_at = ?
        WHERE status = 'sending'
        "#,
        now,
    )
    .execute(pool)
    .await?
    .rows_affected();

    Ok(requeued)
}

#[tracing::instrument(name = "Mark webhook delivered", skip(pool))]
pub async fn mark_delivered(pool: &SqlitePool, delivery_id: &str) -> Result<(), anyhow::Error> {
    let now = Utc::now().to_rfc3339();
    sqlx::query!(
        r#"
        UPDATE webhook_deliveries
        SET status = 'delivered', delivered_at = ?, last_error = NULL
        WHERE delivery_id = ?
        "#,
        now,
        delivery_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Records a failed attempt, scheduling an exponential backoff retry until
/// `max_attempts` is reached, at which point the delivery is marked `failed`.
#[tracing::instrument(name = "Mark webhook attempt failed", skip(pool))]
pub async fn mark_attempt_failed(
    pool: &SqlitePool,
    delivery_id: &str,
    attempts: i64,
    max_attempts: i64,
    error: &str,
) -> Result<(), anyhow::Error> {
    let attempts = attempts + 1;
    if attempts >= max_attempts {
        sqlx::query!(
            r#"
            UPDATE webhook_deliveries
            SET status = 'failed', attempts = ?, last_error = ?
            WHERE delivery_id = ?
            "#,
            attempts,
            error,
            delivery_id
        )
        .execute(pool)
        .await?;
        return Ok(());
    }

    let next_attempt_at = (Utc::now() + backoff(attempts)).to_rfc3339();
    sqlx::query!(
        r#"
        UPDATE webhook_deliveries
        SET status = 'pending', attempts = ?, last_error = ?, next_attempt_at = ?
        WHERE delivery_id = ?
        "#,
        attempts,
        error,
        next_attempt_at,
        delivery_id
    )
    .execute(pool)
    .await?;
    Ok(())
}

/// Doubling backoff starting at one minute, capped at six hours.
fn backoff(attempts: i64) -> Duration {
    let minutes = 1i64
        .checked_shl(attempts.clamp(0, 16) as u32)
        .unwrap_or(360)
        .min(360);
    Duration::minutes(minutes)
}

#[cfg(test)]
mod tests {
    use super::backoff;

    #[test]
    fn backoff_doubles_and_is_capped() {
        assert_eq!(backoff(1).num_minutes(), 2);
        assert_eq!(backoff(3).num_minutes(), 8);
        assert_eq!(backoff(20).num_minutes(), 360);
    }
}
