use anyhow::Context;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::authentication::AuthenticatedUser;
use crate::utils::e500;

#[derive(serde::Serialize)]
pub struct DeadLetterEntry {
    newsletter_issue_id: Uuid,
    newsletter_title: Option<String>,
    subscriber_email: String,
    attempt_count: i32,
    last_error: String,
    failed_at: String,
}

#[derive(serde::Serialize)]
pub struct DeadLettersResponse {
    entries: Vec<DeadLetterEntry>,
    total: i64,
}

#[tracing::instrument(name = "List dead letters", skip_all)]
pub async fn list_dead_letters(
    _user: AuthenticatedUser,
    State(pool): State<PgPool>,
) -> Result<Json<DeadLettersResponse>, crate::utils::AppError> {
    let total = sqlx::query_scalar!(r#"SELECT COUNT(*) as "count!" FROM dead_letter_queue"#)
        .fetch_one(&pool)
        .await
        .context("Failed to count dead letters")
        .map_err(e500)?;

    let rows = sqlx::query!(
        r#"
        SELECT
            d.newsletter_issue_id,
            n.title as "newsletter_title?",
            d.subscriber_email,
            d.attempt_count,
            d.last_error,
            d.failed_at
        FROM dead_letter_queue d
        LEFT JOIN newsletter_issues n ON n.newsletter_issue_id = d.newsletter_issue_id
        ORDER BY d.failed_at DESC
        "#
    )
    .fetch_all(&pool)
    .await
    .context("Failed to fetch dead letters")
    .map_err(e500)?;

    let entries = rows
        .into_iter()
        .map(|r| DeadLetterEntry {
            newsletter_issue_id: r.newsletter_issue_id,
            newsletter_title: r.newsletter_title,
            subscriber_email: r.subscriber_email,
            attempt_count: r.attempt_count,
            last_error: r.last_error,
            failed_at: r.failed_at.to_rfc3339(),
        })
        .collect();

    Ok(Json(DeadLettersResponse { entries, total }))
}

#[tracing::instrument(name = "Retry dead letter", skip(pool))]
pub async fn retry_dead_letter(
    _user: AuthenticatedUser,
    State(pool): State<PgPool>,
    Path((newsletter_issue_id, subscriber_email)): Path<(Uuid, String)>,
) -> Result<impl IntoResponse, crate::utils::AppError> {
    let subscriber_email = urlencoding::decode(&subscriber_email)
        .map_err(|e| {
            crate::utils::AppError::new(
                anyhow::anyhow!("Invalid email encoding: {}", e),
                StatusCode::BAD_REQUEST,
            )
        })?
        .into_owned();

    // Verify the dead letter exists
    let exists = sqlx::query_scalar!(
        r#"
        SELECT COUNT(*) as "count!"
        FROM dead_letter_queue
        WHERE newsletter_issue_id = $1 AND subscriber_email = $2
        "#,
        newsletter_issue_id,
        subscriber_email,
    )
    .fetch_one(&pool)
    .await
    .context("Failed to check dead letter")
    .map_err(e500)?;

    if exists == 0 {
        return Err(crate::utils::AppError::new(
            anyhow::anyhow!("Dead letter entry not found"),
            StatusCode::NOT_FOUND,
        ));
    }

    let mut tx = pool
        .begin()
        .await
        .context("Failed to begin transaction")
        .map_err(e500)?;

    // Re-enqueue into delivery queue with reset attempt count
    sqlx::query!(
        r#"
        INSERT INTO issue_delivery_queue (newsletter_issue_id, subscriber_email, attempt_count)
        VALUES ($1, $2, 0)
        ON CONFLICT (newsletter_issue_id, subscriber_email) DO NOTHING
        "#,
        newsletter_issue_id,
        subscriber_email,
    )
    .execute(tx.as_mut())
    .await
    .context("Failed to re-enqueue delivery")
    .map_err(e500)?;

    // Remove from dead letter queue
    sqlx::query!(
        r#"
        DELETE FROM dead_letter_queue
        WHERE newsletter_issue_id = $1 AND subscriber_email = $2
        "#,
        newsletter_issue_id,
        subscriber_email,
    )
    .execute(tx.as_mut())
    .await
    .context("Failed to remove from dead letter queue")
    .map_err(e500)?;

    tx.commit()
        .await
        .context("Failed to commit transaction")
        .map_err(e500)?;

    Ok(StatusCode::NO_CONTENT)
}
