use std::time::Duration;

use chrono::Utc;
use sqlx::SqlitePool;
use uuid::Uuid;

use crate::configuration::Settings;
use crate::domain::MemoryExtractionStatus;
use crate::startup::get_connection_pool;

use super::MemoryEngine;

/// Maximum retry attempts before a job is marked as dead-letter.
const MAX_RETRY_ATTEMPTS: i32 = 5;

/// Base backoff in seconds; actual delay = BASE * 2^attempt_count, capped at 1 hour.
const RETRY_BACKOFF_SECS: u64 = 30;

/// How long the worker sleeps when the queue is empty.
const IDLE_SLEEP_SECS: u64 = 5;

pub enum ExecutionOutcome {
    TaskCompleted,
    EmptyQueue,
}

pub async fn run_memory_worker_until_stopped(configuration: Settings) -> Result<(), anyhow::Error> {
    let pool = get_connection_pool(&configuration.database).await;
    let engine = MemoryEngine::new(&configuration.memory).await;

    if !engine.is_enabled() {
        tracing::info!("Memory engine is disabled — extraction worker will not start");
        // Park forever so tokio::select! doesn't immediately exit.
        std::future::pending::<()>().await;
    }

    tracing::info!("Memory extraction worker started");
    worker_loop(&pool, &engine).await
}

async fn worker_loop(pool: &SqlitePool, engine: &MemoryEngine) -> Result<(), anyhow::Error> {
    loop {
        match try_process_next(pool, engine).await {
            Ok(ExecutionOutcome::EmptyQueue) => {
                tokio::time::sleep(Duration::from_secs(IDLE_SLEEP_SECS)).await;
            }
            Ok(ExecutionOutcome::TaskCompleted) => {
                // Immediately check for more work.
            }
            Err(e) => {
                tracing::error!(
                    error.cause_chain = ?e,
                    error.message = %e,
                    "Memory extraction worker encountered an error"
                );
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

#[tracing::instrument(name = "memory_worker::try_process_next", skip_all, level = "debug")]
async fn try_process_next(
    pool: &SqlitePool,
    engine: &MemoryEngine,
) -> Result<ExecutionOutcome, anyhow::Error> {
    let mut tx = pool.begin().await?;

    // Dequeue one job.
    let row = sqlx::query!(
        r#"
        SELECT id, user_id, raw_text, attempt_count, last_attempted_at AS "last_attempted_at?"
        FROM memory_extraction_queue
        WHERE status IN ('pending', 'failed')
        LIMIT 1
        "#,
    )
    .fetch_optional(tx.as_mut())
    .await?;

    let row = match row {
        Some(r) => r,
        None => {
            tx.rollback().await?;
            return Ok(ExecutionOutcome::EmptyQueue);
        }
    };

    let job_id = Uuid::parse_str(&row.id).expect("invalid UUID in extraction queue");
    let user_id = row.user_id;
    let raw_text = row.raw_text;
    let attempt_count = row.attempt_count as i32;
    let last_attempted_at = row
        .last_attempted_at
        .and_then(|s| s.parse::<chrono::DateTime<Utc>>().ok());

    // Exponential backoff: skip if too soon to retry.
    if let Some(last) = last_attempted_at {
        let backoff = Duration::from_secs(
            RETRY_BACKOFF_SECS
                .saturating_mul(2u64.saturating_pow(attempt_count as u32))
                .min(3600),
        );
        let elapsed = Utc::now() - last;
        if elapsed < chrono::Duration::from_std(backoff).unwrap_or(chrono::Duration::MAX) {
            tx.rollback().await?;
            return Ok(ExecutionOutcome::EmptyQueue);
        }
    }

    // Mark as processing so we can release the row lock.
    let processing_status = MemoryExtractionStatus::Processing.as_str();
    let job_id_str = job_id.to_string();
    sqlx::query!(
        "UPDATE memory_extraction_queue SET status = ? WHERE id = ?",
        processing_status,
        job_id_str,
    )
    .execute(tx.as_mut())
    .await?;
    tx.commit().await?;

    // Run the actual extraction (LLM calls + DB inserts) outside the transaction.
    match engine.add_memory(&user_id, &raw_text).await {
        Ok(ids) => {
            tracing::info!(
                job_id = %job_id,
                user_id = %user_id,
                memories_stored = ids.len(),
                "Extraction job completed"
            );
            delete_job(pool, job_id).await?;
        }
        Err(e) => {
            let new_count = attempt_count + 1;
            let error_msg = format!("{e:#}");
            let now = Utc::now().to_rfc3339();
            let jid = job_id.to_string();

            if new_count >= MAX_RETRY_ATTEMPTS {
                tracing::warn!(
                    job_id = %job_id,
                    attempts = new_count,
                    "Max retries reached — marking as dead_letter"
                );
                let status = MemoryExtractionStatus::DeadLetter.as_str();
                sqlx::query!(
                    r#"
                    UPDATE memory_extraction_queue
                    SET status = ?,
                        attempt_count = ?,
                        last_attempted_at = ?,
                        last_error = ?
                    WHERE id = ?
                    "#,
                    status,
                    new_count,
                    now,
                    error_msg,
                    jid,
                )
                .execute(pool)
                .await?;
            } else {
                tracing::warn!(
                    job_id = %job_id,
                    attempt = new_count,
                    error = %e,
                    "Extraction failed — will retry"
                );
                let status = MemoryExtractionStatus::Failed.as_str();
                sqlx::query!(
                    r#"
                    UPDATE memory_extraction_queue
                    SET status = ?,
                        attempt_count = ?,
                        last_attempted_at = ?,
                        last_error = ?
                    WHERE id = ?
                    "#,
                    status,
                    new_count,
                    now,
                    error_msg,
                    jid,
                )
                .execute(pool)
                .await?;
            }
        }
    }

    Ok(ExecutionOutcome::TaskCompleted)
}

async fn delete_job(pool: &SqlitePool, job_id: Uuid) -> Result<(), anyhow::Error> {
    let jid = job_id.to_string();
    sqlx::query!("DELETE FROM memory_extraction_queue WHERE id = ?", jid)
        .execute(pool)
        .await?;
    Ok(())
}
