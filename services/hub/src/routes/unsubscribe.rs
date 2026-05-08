use askama::Template;
use axum::extract::{Query, State};
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};
use hmac::{Hmac, Mac};
use sha2::Sha256;
use sqlx::PgPool;

use crate::startup::AppState;
use crate::web_templates::UnsubscribeTemplate;

#[derive(Debug, serde::Deserialize)]
pub struct UnsubscribeParams {
    pub email: String,
    pub token: String,
}

pub fn generate_unsubscribe_url(base_url: &str, email: &str, hmac_secret: &str) -> String {
    let token = generate_token(email, hmac_secret);
    format!(
        "{}/subscriptions/unsubscribe?email={}&token={}",
        base_url,
        urlencoding::encode(email),
        token
    )
}

fn generate_token(email: &str, secret: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(email.as_bytes());
    hex::encode(mac.finalize().into_bytes())
}

fn verify_token(email: &str, token: &str, secret: &str) -> bool {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(secret.as_bytes()).expect("HMAC can take key of any size");
    mac.update(email.as_bytes());
    let token_bytes = match hex::decode(token) {
        Ok(bytes) => bytes,
        Err(_) => return false,
    };
    mac.verify_slice(&token_bytes).is_ok()
}

#[tracing::instrument(name = "Unsubscribe (GET)", skip(state))]
pub async fn unsubscribe_get(
    Query(params): Query<UnsubscribeParams>,
    State(state): State<AppState>,
) -> Response {
    process_unsubscribe(&state.db_pool, &state.hmac_secret, &params).await
}

#[tracing::instrument(name = "Unsubscribe (POST)", skip(state))]
pub async fn unsubscribe_post(
    Query(params): Query<UnsubscribeParams>,
    State(state): State<AppState>,
) -> Response {
    process_unsubscribe(&state.db_pool, &state.hmac_secret, &params).await
}

async fn process_unsubscribe(
    pool: &PgPool,
    hmac_secret: &str,
    params: &UnsubscribeParams,
) -> Response {
    if !verify_token(&params.email, &params.token, hmac_secret) {
        let template = UnsubscribeTemplate {
            heading: "Invalid Link".to_string(),
            message: "This unsubscribe link is invalid or has expired.".to_string(),
        };
        return (StatusCode::BAD_REQUEST, Html(template.render().unwrap())).into_response();
    }

    match mark_as_unsubscribed(pool, &params.email).await {
        Ok(true) => {
            let template = UnsubscribeTemplate {
                heading: "You've Been Unsubscribed".to_string(),
                message: "You will no longer receive newsletter emails. If this was a mistake, you can re-subscribe at any time.".to_string(),
            };
            Html(template.render().unwrap()).into_response()
        }
        Ok(false) => {
            let template = UnsubscribeTemplate {
                heading: "Already Unsubscribed".to_string(),
                message: "This email address is not currently subscribed.".to_string(),
            };
            Html(template.render().unwrap()).into_response()
        }
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to process unsubscribe");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                "Something went wrong. Please try again later.",
            )
                .into_response()
        }
    }
}

#[tracing::instrument(skip(pool))]
async fn mark_as_unsubscribed(pool: &PgPool, email: &str) -> Result<bool, sqlx::Error> {
    let result = sqlx::query(
        "UPDATE subscriptions SET status = 'unsubscribed' WHERE email = $1 AND status = 'confirmed'",
    )
    .bind(email)
    .execute(pool)
    .await?;

    Ok(result.rows_affected() > 0)
}
