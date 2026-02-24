use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::startup::AppState;

#[derive(serde::Deserialize)]
pub struct CreateNewsletterRequest {
    pub title: String,
    pub html_content: String,
    pub text_content: String,
}

#[tracing::instrument(name = "API: Publish newsletter", skip_all)]
pub async fn api_publish_newsletter(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<CreateNewsletterRequest>,
) -> Response {
    if !verify_bearer_token(&headers, &state.api_bearer_token) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid or missing bearer token"})),
        )
            .into_response();
    }

    let newsletter_issue_id = Uuid::new_v4();
    let mut transaction = match state.db_pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to begin transaction");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(e) = sqlx::query(
        "INSERT INTO newsletter_issues (newsletter_issue_id, title, text_content, html_content, published_at) VALUES ($1, $2, $3, $4, NOW())",
    )
    .bind(newsletter_issue_id)
    .bind(&body.title)
    .bind(&body.text_content)
    .bind(&body.html_content)
    .execute(transaction.as_mut())
    .await
    {
        tracing::error!(error.cause_chain = ?e, "Failed to insert newsletter issue");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = sqlx::query(
        "INSERT INTO issue_delivery_queue (newsletter_issue_id, subscriber_email) SELECT $1, email FROM subscriptions WHERE status = 'confirmed'",
    )
    .bind(newsletter_issue_id)
    .execute(transaction.as_mut())
    .await
    {
        tracing::error!(error.cause_chain = ?e, "Failed to enqueue delivery tasks");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    if let Err(e) = transaction.commit().await {
        tracing::error!(error.cause_chain = ?e, "Failed to commit transaction");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    tracing::info!(
        newsletter_issue_id = %newsletter_issue_id,
        "Newsletter issue created via API"
    );

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "newsletter_issue_id": newsletter_issue_id,
            "status": "accepted"
        })),
    )
        .into_response()
}

fn verify_bearer_token(headers: &HeaderMap, expected_token: &str) -> bool {
    headers
        .get("Authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|token| token == expected_token)
        .unwrap_or(false)
}
