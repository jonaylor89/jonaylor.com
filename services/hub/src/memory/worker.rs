use std::time::Duration;

use chrono::Utc;
use sqlx::{PgPool, Row};
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
    let pool = get_connection_pool(&configuration.database);
    let engine = MemoryEngine::new(pool.clone(), &configuration.memory);

    if !engine.is_enabled() {
        tracing::info!("Memory engine is disabled — extraction worker will not start");
        // Park forever so tokio::select! doesn't immediately exit.
        std::future::pending::<()>().await;
    }

    tracing::info!("Memory extraction worker started");
    worker_loop(&pool, &engine).await
}

async fn worker_loop(pool: &PgPool, engine: &MemoryEngine) -> Result<(), anyhow::Error> {
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
    pool: &PgPool,
    engine: &MemoryEngine,
) -> Result<ExecutionOutcome, anyhow::Error> {
    let mut tx = pool.begin().await?;

    // Dequeue one job, skipping rows locked by concurrent workers.
    let row = sqlx::query(
        r#"
        SELECT id, user_id, raw_text, attempt_count, last_attempted_at
        FROM memory_extraction_queue
        WHERE status IN ('pending', 'failed')
        FOR UPDATE SKIP LOCKED
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

    let job_id: Uuid = row.get("id");
    let user_id: String = row.get("user_id");
    let raw_text: String = row.get("raw_text");
    let attempt_count: i32 = row.get("attempt_count");
    let last_attempted_at: Option<chrono::DateTime<Utc>> = row.get("last_attempted_at");

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
    sqlx::query("UPDATE memory_extraction_queue SET status = $2 WHERE id = $1")
        .bind(job_id)
        .bind(MemoryExtractionStatus::Processing.as_str())
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

            if new_count >= MAX_RETRY_ATTEMPTS {
                tracing::warn!(
                    job_id = %job_id,
                    attempts = new_count,
                    "Max retries reached — marking as dead_letter"
                );
                sqlx::query(
                    r#"
                    UPDATE memory_extraction_queue
                    SET status = $5,
                        attempt_count = $2,
                        last_attempted_at = $3,
                        last_error = $4
                    WHERE id = $1
                    "#,
                )
                .bind(job_id)
                .bind(new_count)
                .bind(Utc::now())
                .bind(&error_msg)
                .bind(MemoryExtractionStatus::DeadLetter.as_str())
                .execute(pool)
                .await?;
            } else {
                tracing::warn!(
                    job_id = %job_id,
                    attempt = new_count,
                    error = %e,
                    "Extraction failed — will retry"
                );
                sqlx::query(
                    r#"
                    UPDATE memory_extraction_queue
                    SET status = $5,
                        attempt_count = $2,
                        last_attempted_at = $3,
                        last_error = $4
                    WHERE id = $1
                    "#,
                )
                .bind(job_id)
                .bind(new_count)
                .bind(Utc::now())
                .bind(&error_msg)
                .bind(MemoryExtractionStatus::Failed.as_str())
                .execute(pool)
                .await?;
            }
        }
    }

    Ok(ExecutionOutcome::TaskCompleted)
}

async fn delete_job(pool: &PgPool, job_id: Uuid) -> Result<(), anyhow::Error> {
    sqlx::query("DELETE FROM memory_extraction_queue WHERE id = $1")
        .bind(job_id)
        .execute(pool)
        .await?;
    Ok(())
}
