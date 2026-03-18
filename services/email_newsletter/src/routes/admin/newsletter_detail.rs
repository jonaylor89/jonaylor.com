use anyhow::Context;
use axum::Form;
use axum::extract::{Path, State};
use axum::response::{Html, Json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::authentication::AuthenticatedUser;
use crate::utils::e500;

#[derive(serde::Serialize)]
pub struct NewsletterSummary {
    newsletter_issue_id: Uuid,
    title: String,
    published_at: String,
    delivered: i64,
    pending: i64,
    failed: i64,
}

#[derive(serde::Serialize)]
pub struct NewsletterListResponse {
    newsletters: Vec<NewsletterSummary>,
    total: i64,
}

#[tracing::instrument(name = "List newsletters", skip_all)]
pub async fn list_newsletters(
    _user: AuthenticatedUser,
    State(pool): State<PgPool>,
) -> Result<Json<NewsletterListResponse>, crate::utils::AppError> {
    let rows = sqlx::query!(
        r#"
        SELECT
            n.newsletter_issue_id,
            n.title,
            n.published_at,
            COALESCE(q.pending, 0) as "pending!",
            COALESCE(d.failed, 0) as "failed!"
        FROM newsletter_issues n
        LEFT JOIN (
            SELECT newsletter_issue_id, COUNT(*) as pending
            FROM issue_delivery_queue
            GROUP BY newsletter_issue_id
        ) q ON q.newsletter_issue_id = n.newsletter_issue_id
        LEFT JOIN (
            SELECT newsletter_issue_id, COUNT(*) as failed
            FROM dead_letter_queue
            GROUP BY newsletter_issue_id
        ) d ON d.newsletter_issue_id = n.newsletter_issue_id
        ORDER BY n.published_at DESC
        "#
    )
    .fetch_all(&pool)
    .await
    .context("Failed to fetch newsletters")
    .map_err(e500)?;

    let total = rows.len() as i64;

    // To compute "delivered", we need the total subscribers at send time.
    // We approximate: delivered = total_enqueued - pending - failed
    // But we don't store total_enqueued. So we just report pending and failed,
    // and leave delivered as 0 (or we could count confirmed subscribers but that's
    // not accurate for past issues). Let's just do a separate query for each.
    let mut newsletters = Vec::with_capacity(rows.len());
    for r in rows {
        // Count how many were originally enqueued (confirmed subscribers at publish time)
        // is not stored. We can infer delivered = (original - pending - failed).
        // Since we can't know original, let's show delivered as "not in queue and not in DLQ"
        // which is best-effort.
        newsletters.push(NewsletterSummary {
            newsletter_issue_id: r.newsletter_issue_id,
            title: r.title,
            published_at: r.published_at,
            delivered: 0, // We don't have this data; would need a separate tracking table
            pending: r.pending,
            failed: r.failed,
        });
    }

    Ok(Json(NewsletterListResponse { newsletters, total }))
}

#[derive(serde::Serialize)]
pub struct NewsletterDetail {
    newsletter_issue_id: Uuid,
    title: String,
    text_content: String,
    html_content: String,
    published_at: String,
}

#[tracing::instrument(name = "Get newsletter detail", skip(pool))]
pub async fn get_newsletter(
    _user: AuthenticatedUser,
    State(pool): State<PgPool>,
    Path(issue_id): Path<Uuid>,
) -> Result<Json<NewsletterDetail>, crate::utils::AppError> {
    let row = sqlx::query!(
        r#"
        SELECT newsletter_issue_id, title, text_content, html_content, published_at
        FROM newsletter_issues
        WHERE newsletter_issue_id = $1
        "#,
        issue_id,
    )
    .fetch_optional(&pool)
    .await
    .context("Failed to fetch newsletter")
    .map_err(e500)?;

    match row {
        Some(r) => Ok(Json(NewsletterDetail {
            newsletter_issue_id: r.newsletter_issue_id,
            title: r.title,
            text_content: r.text_content,
            html_content: r.html_content,
            published_at: r.published_at,
        })),
        None => Err(crate::utils::AppError::new(
            anyhow::anyhow!("Newsletter not found"),
            axum::http::StatusCode::NOT_FOUND,
        )),
    }
}

#[derive(serde::Deserialize)]
pub struct PreviewData {
    title: String,
    html: String,
}

#[tracing::instrument(name = "Preview newsletter", skip_all)]
pub async fn preview_newsletter(
    _user: AuthenticatedUser,
    Form(data): Form<PreviewData>,
) -> Html<String> {
    let preview = format!(
        r#"<!DOCTYPE html>
<html><head><title>Preview: {title}</title>
<style>body {{ font-family: sans-serif; max-width: 600px; margin: 2rem auto; padding: 1rem; }}</style>
</head><body>
<p style="color:#999;font-size:12px;margin-bottom:1rem">&#9888; Preview — this has not been sent</p>
<h1>{title}</h1>
<hr>
{html}
</body></html>"#,
        title = htmlescape::encode_minimal(&data.title),
        html = data.html,
    );

    Html(preview)
}
