use std::time::Duration;

use chrono::Utc;
use sqlx::{Sqlite, SqlitePool, Transaction};
use tokio::task::JoinSet;
use tracing::{Span, field::display};
use uuid::Uuid;

use secrecy::ExposeSecret;

use crate::{
    configuration::Settings, domain::SubscriberEmail, email_client::EmailClient,
    routes::generate_unsubscribe_url, startup::get_connection_pool,
};

// Number of tasks to process concurrently
const CONCURRENT_TASKS: usize = 1;

// Maximum number of retry attempts before moving to dead letter queue
const MAX_RETRY_ATTEMPTS: i32 = 5;

// Minimum time between retry attempts (exponential backoff base)
const RETRY_BACKOFF_MINUTES: i64 = 5;

type SqliteTransaction = Transaction<'static, Sqlite>;

struct NewsletterIssue {
    title: String,
    text_content: String,
    html_content: String,
}

struct DequeuedTask {
    transaction: SqliteTransaction,
    issue_id: Uuid,
    email: String,
    attempt_count: i32,
    last_attempted_at: Option<chrono::DateTime<Utc>>,
}

pub enum ExecutionOutcome {
    TaskCompleted,
    EmptyQueue,
}

enum TaskExecutionResult {
    Processed,
    SkippedBackoff,
}

pub async fn run_worker_until_stopped(configuration: Settings) -> Result<(), anyhow::Error> {
    let connection_pool = get_connection_pool(&configuration.database).await;
    let email_client = configuration.email_client.client();
    let base_url = configuration.application.base_url.clone();
    let hmac_secret = configuration
        .application
        .hmac_secret
        .expose_secret()
        .clone();
    worker_loop(&connection_pool, &email_client, &hmac_secret, &base_url).await
}

async fn worker_loop(
    pool: &SqlitePool,
    email_client: &EmailClient,
    hmac_secret: &str,
    base_url: &str,
) -> Result<(), anyhow::Error> {
    loop {
        match try_execute_tasks(pool, email_client, hmac_secret, base_url).await {
            Ok(ExecutionOutcome::EmptyQueue) => {
                tokio::time::sleep(Duration::from_hours(24)).await;
            }
            Err(_) => {
                tokio::time::sleep(Duration::from_secs(1)).await;
            }

            Ok(ExecutionOutcome::TaskCompleted) => {}
        }
    }
}

#[tracing::instrument(skip_all)]
pub async fn try_execute_tasks(
    pool: &SqlitePool,
    email_client: &EmailClient,
    hmac_secret: &str,
    base_url: &str,
) -> Result<ExecutionOutcome, anyhow::Error> {
    let mut processed_any_batch = false;

    loop {
        let tasks = dequeue_tasks(pool, CONCURRENT_TASKS).await?;

        if tasks.is_empty() {
            let exec_outcome = if processed_any_batch {
                ExecutionOutcome::TaskCompleted
            } else {
                ExecutionOutcome::EmptyQueue
            };

            return Ok(exec_outcome);
        }

        let task_count = tasks.len();
        tracing::info!("Processing {} tasks concurrently", task_count);

        let mut join_set = JoinSet::new();

        for task in tasks {
            let pool_clone = pool.clone();
            let email_client_clone = email_client.clone();
            let hmac_secret = hmac_secret.to_string();
            let base_url = base_url.to_string();

            join_set.spawn(async move {
                execute_single_task(
                    pool_clone,
                    email_client_clone,
                    task,
                    &hmac_secret,
                    &base_url,
                )
                .await
            });
        }

        let mut processed_in_batch = false;

        while let Some(result) = join_set.join_next().await {
            match result {
                Ok(Ok(TaskExecutionResult::Processed)) => {
                    processed_in_batch = true;
                }
                Ok(Ok(TaskExecutionResult::SkippedBackoff)) => {}
                Ok(Err(e)) => {
                    tracing::error!(
                        error.cause_chain = ?e,
                        "Task execution failed"
                    );
                }
                Err(e) => {
                    tracing::error!(
                        error.cause_chain = ?e,
                        "Task join failed"
                    );
                }
            }
        }

        processed_any_batch = true;

        if !processed_in_batch {
            return Ok(ExecutionOutcome::TaskCompleted);
        }
    }
}

#[tracing::instrument(
    skip_all,
    fields(
        newsletter_issue_id=tracing::field::Empty,
        subscriber_email=tracing::field::Empty,
    )
)]
async fn execute_single_task(
    pool: SqlitePool,
    email_client: EmailClient,
    mut task: DequeuedTask,
    hmac_secret: &str,
    base_url: &str,
) -> Result<TaskExecutionResult, anyhow::Error> {
    Span::current()
        .record("newsletter_issue_id", display(task.issue_id))
        .record("subscriber_email", display(&task.email));

    // Check if we should retry this task based on exponential backoff
    if let Some(last_attempted) = task.last_attempted_at {
        let backoff_duration = Duration::from_secs(
            (RETRY_BACKOFF_MINUTES * 60 * 2_i64.pow(task.attempt_count as u32).min(32)) as u64,
        );
        let elapsed = Utc::now() - last_attempted;

        if elapsed < chrono::Duration::from_std(backoff_duration).unwrap() {
            // Too soon to retry - skip this task for now
            tracing::debug!(
                "Skipping task (backoff): attempt {}, last_attempted {:?} ago",
                task.attempt_count,
                elapsed
            );
            // Just rollback transaction without deleting
            task.transaction.rollback().await?;
            return Ok(TaskExecutionResult::SkippedBackoff);
        }
    }

    let unsubscribe_url = generate_unsubscribe_url(base_url, &task.email, hmac_secret);

    let send_result = match SubscriberEmail::parse(task.email.clone()) {
        Ok(email_addr) => {
            let issue = get_issue(&pool, task.issue_id).await?;

            let html_with_footer = format!(
                "{}\n<hr style=\"border:none;border-top:1px solid #eee;margin:30px 0\">\
                 <p style=\"color:#999;font-size:12px;text-align:center\">\
                 <a href=\"{}\" style=\"color:#999\">Unsubscribe</a></p>",
                issue.html_content, unsubscribe_url
            );
            let text_with_footer = format!(
                "{}\n\n---\nUnsubscribe: {}",
                issue.text_content, unsubscribe_url
            );

            email_client
                .send_email(
                    &email_addr,
                    &issue.title,
                    &html_with_footer,
                    &text_with_footer,
                    Some(&unsubscribe_url),
                )
                .await
        }
        Err(e) => {
            // Invalid email - this is a non-retryable error
            tracing::error!(
                error.cause_chain = ?e,
                error.message = %e,
                "Invalid email address - moving to dead letter queue"
            );
            move_to_dead_letter_queue(
                &mut task.transaction,
                task.issue_id,
                &task.email,
                task.attempt_count,
                &e.to_string(),
            )
            .await?;
            delete_task(task.transaction, task.issue_id, &task.email).await?;
            return Ok(TaskExecutionResult::Processed);
        }
    };

    match send_result {
        Ok(_) => {
            // Success - delete from queue
            tracing::info!("Successfully sent email to {}", task.email);
            delete_task(task.transaction, task.issue_id, &task.email).await?;
        }
        Err(e) => {
            let error_message = e.to_string();
            tracing::error!(
                error.cause_chain = ?e,
                error.message = %error_message,
                attempt = task.attempt_count + 1,
                "Failed to deliver issue to confirmed subscriber"
            );

            // Update attempt count and error message
            let new_attempt_count = task.attempt_count + 1;

            if new_attempt_count >= MAX_RETRY_ATTEMPTS {
                // Max retries reached - move to dead letter queue
                tracing::warn!(
                    "Max retry attempts ({}) reached for {}. Moving to dead letter queue.",
                    MAX_RETRY_ATTEMPTS,
                    task.email
                );
                move_to_dead_letter_queue(
                    &mut task.transaction,
                    task.issue_id,
                    &task.email,
                    new_attempt_count,
                    &error_message,
                )
                .await?;
                delete_task(task.transaction, task.issue_id, &task.email).await?;
            } else {
                // Update retry tracking and keep in queue
                update_retry_tracking(
                    &mut task.transaction,
                    task.issue_id,
                    &task.email,
                    new_attempt_count,
                    &error_message,
                )
                .await?;
                task.transaction.commit().await?;
            }
        }
    }

    Ok(TaskExecutionResult::Processed)
}

#[tracing::instrument(skip_all)]
async fn dequeue_tasks(
    pool: &SqlitePool,
    limit: usize,
) -> Result<Vec<DequeuedTask>, anyhow::Error> {
    let mut tasks = Vec::new();

    // Dequeue tasks one by one to get separate transactions for each
    // This allows parallel processing without holding locks
    for _ in 0..limit {
        let mut transaction = pool.begin().await?;
        let r = sqlx::query!(
            r#"
            SELECT
                newsletter_issue_id,
                subscriber_email,
                attempt_count,
                last_attempted_at AS "last_attempted_at?"
            FROM issue_delivery_queue
            LIMIT 1
            "#,
        )
        .fetch_optional(transaction.as_mut())
        .await?;

        if let Some(r) = r {
            tasks.push(DequeuedTask {
                transaction,
                issue_id: Uuid::parse_str(&r.newsletter_issue_id)
                    .expect("invalid UUID in delivery queue"),
                email: r.subscriber_email,
                attempt_count: r.attempt_count as i32,
                last_attempted_at: r
                    .last_attempted_at
                    .and_then(|s| s.parse::<chrono::DateTime<Utc>>().ok()),
            });
        } else {
            // No more tasks available
            transaction.rollback().await?;
            break;
        }
    }

    Ok(tasks)
}

#[tracing::instrument(skip_all)]
async fn delete_task(
    mut transaction: SqliteTransaction,
    issue_id: Uuid,
    email: &str,
) -> Result<(), anyhow::Error> {
    let issue_id_str = issue_id.to_string();
    sqlx::query!(
        r#"
        DELETE FROM issue_delivery_queue
        WHERE
            newsletter_issue_id = ?
        AND
            subscriber_email = ?
        "#,
        issue_id_str,
        email,
    )
    .execute(transaction.as_mut())
    .await?;

    transaction.commit().await?;

    Ok(())
}

#[tracing::instrument(skip_all)]
async fn get_issue(pool: &SqlitePool, issue_id: Uuid) -> Result<NewsletterIssue, anyhow::Error> {
    let issue_id_str = issue_id.to_string();
    let row = sqlx::query!(
        r#"
        SELECT title, text_content, html_content
        FROM newsletter_issues
        WHERE
            newsletter_issue_id = ?
        "#,
        issue_id_str,
    )
    .fetch_one(pool)
    .await?;

    let issue = NewsletterIssue {
        title: row.title,
        text_content: row.text_content,
        html_content: row.html_content,
    };

    Ok(issue)
}

#[tracing::instrument(skip_all)]
async fn update_retry_tracking(
    transaction: &mut SqliteTransaction,
    issue_id: Uuid,
    email: &str,
    attempt_count: i32,
    error_message: &str,
) -> Result<(), anyhow::Error> {
    let now = Utc::now().to_rfc3339();
    let issue_id_str = issue_id.to_string();
    sqlx::query!(
        r#"
        UPDATE issue_delivery_queue
        SET attempt_count = ?,
            last_attempted_at = ?,
            error_message = ?
        WHERE newsletter_issue_id = ? AND subscriber_email = ?
        "#,
        attempt_count,
        now,
        error_message,
        issue_id_str,
        email,
    )
    .execute(transaction.as_mut())
    .await?;

    Ok(())
}

#[tracing::instrument(skip_all)]
async fn move_to_dead_letter_queue(
    transaction: &mut SqliteTransaction,
    issue_id: Uuid,
    email: &str,
    attempt_count: i32,
    error_message: &str,
) -> Result<(), anyhow::Error> {
    let now = Utc::now().to_rfc3339();
    let issue_id_str = issue_id.to_string();
    sqlx::query!(
        r#"
        INSERT INTO dead_letter_queue (
            newsletter_issue_id,
            subscriber_email,
            attempt_count,
            last_error,
            failed_at
        )
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (newsletter_issue_id, subscriber_email)
        DO UPDATE SET
            attempt_count = excluded.attempt_count,
            last_error = excluded.last_error,
            failed_at = excluded.failed_at
        "#,
        issue_id_str,
        email,
        attempt_count,
        error_message,
        now,
    )
    .execute(transaction.as_mut())
    .await?;

    Ok(())
}
