use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use sqlx::PgPool;
use uuid::Uuid;

use crate::domain::{NewSubscriber, SubscriberEmail, SubscriberName, SubscriptionToken};
use crate::email_client::EmailClient;
use crate::routes::subscriptions::{
    get_subscriber_by_email, insert_subscriber, send_already_subscribed_email,
    send_confirmation_email, store_token,
};
use crate::startup::{AppState, ApplicationBaseUrl};

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

#[derive(serde::Deserialize)]
pub struct ApiSubscribeRequest {
    pub email: String,
    pub name: Option<String>,
}

#[tracing::instrument(
    name = "API: Subscribe",
    skip(pool, email_client, base_url, body),
    fields(
        subscriber_email = %body.email,
        subscriber_name = ?body.name
    )
)]
pub async fn api_subscribe(
    State(pool): State<PgPool>,
    State(email_client): State<EmailClient>,
    State(base_url): State<ApplicationBaseUrl>,
    Json(body): Json<ApiSubscribeRequest>,
) -> Response {
    let name = match SubscriberName::parse(body.name) {
        Ok(name) => name,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let email = match SubscriberEmail::parse(body.email) {
        Ok(email) => email,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let new_subscriber = NewSubscriber { email, name };

    let mut transaction = match pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to begin transaction");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Something went wrong"})),
            )
                .into_response();
        }
    };

    let existing = get_subscriber_by_email(&mut transaction, &new_subscriber.email).await;
    match existing {
        Ok(Some((_id, status))) if status == "confirmed" => {
            if let Err(e) = transaction.commit().await {
                tracing::error!(error.cause_chain = ?e, "Failed to commit transaction");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "Something went wrong"})),
                )
                    .into_response();
            }
            let _ = send_already_subscribed_email(&email_client, &new_subscriber).await;
            return (
                StatusCode::OK,
                Json(serde_json::json!({"status": "subscribed"})),
            )
                .into_response();
        }
        Ok(Some((subscriber_id, _))) => {
            let token = SubscriptionToken::generate();
            if let Err(e) = store_token(&mut transaction, subscriber_id, token.as_ref()).await {
                tracing::error!(error.cause_chain = ?e, "Failed to store token");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "Something went wrong"})),
                )
                    .into_response();
            }
            if let Err(e) = transaction.commit().await {
                tracing::error!(error.cause_chain = ?e, "Failed to commit transaction");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "Something went wrong"})),
                )
                    .into_response();
            }
            let _ =
                send_confirmation_email(&email_client, new_subscriber, &base_url.0, token.as_ref())
                    .await;
            return (
                StatusCode::OK,
                Json(serde_json::json!({"status": "confirmation_resent"})),
            )
                .into_response();
        }
        Ok(None) => {}
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to check existing subscriber");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Something went wrong"})),
            )
                .into_response();
        }
    }

    let subscriber_id = match insert_subscriber(&mut transaction, &new_subscriber).await {
        Ok(id) => id,
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to insert subscriber");
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Something went wrong"})),
            )
                .into_response();
        }
    };

    let token = SubscriptionToken::generate();
    if let Err(e) = store_token(&mut transaction, subscriber_id, token.as_ref()).await {
        tracing::error!(error.cause_chain = ?e, "Failed to store token");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Something went wrong"})),
        )
            .into_response();
    }

    if let Err(e) = transaction.commit().await {
        tracing::error!(error.cause_chain = ?e, "Failed to commit transaction");
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": "Something went wrong"})),
        )
            .into_response();
    }

    let _ =
        send_confirmation_email(&email_client, new_subscriber, &base_url.0, token.as_ref()).await;

    (
        StatusCode::OK,
        Json(serde_json::json!({"status": "confirmation_sent"})),
    )
        .into_response()
}
