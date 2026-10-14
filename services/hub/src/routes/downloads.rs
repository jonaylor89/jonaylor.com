use askama::Template;
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use chrono::Utc;
use sqlx::{Sqlite, SqlitePool, Transaction};
use uuid::Uuid;

use crate::domain::{NewSubscriber, SubscriberEmail, SubscriptionToken};
use crate::email_client::EmailClient;
use crate::email_templates::{DownloadThanksEmailHtml, DownloadThanksEmailText};
use crate::routes::subscriptions::{get_subscriber_by_email, insert_subscriber, store_token};
use crate::startup::ApplicationBaseUrl;

pub struct DownloadableApp {
    pub slug: &'static str,
    pub name: &'static str,
    pub download_url: &'static str,
}

/// Apps whose download pages collect an email. Unknown slugs are rejected so the
/// endpoint can't be used to send arbitrary text to arbitrary inboxes.
pub const DOWNLOADABLE_APPS: &[DownloadableApp] = &[
    DownloadableApp {
        slug: "paperclock",
        name: "Paper Clock",
        download_url: "https://downloads.jonaylor.com/paperclock.apk",
    },
    DownloadableApp {
        slug: "parlo",
        name: "Parlo",
        download_url: "https://downloads.jonaylor.com/parlo.apk",
    },
    DownloadableApp {
        slug: "saintjohn",
        name: "Saint John",
        download_url: "https://downloads.jonaylor.com/saintjohn.apk",
    },
    DownloadableApp {
        slug: "fuego",
        name: "Fuego",
        download_url: "https://github.com/jonaylor89/Fuego/releases/latest/download/Fuego.dmg",
    },
];

/// Repeat downloads of the same app inside this window are recorded but don't
/// trigger another email, which keeps the endpoint from being used to spam an inbox.
const EMAIL_COOLDOWN_HOURS: i64 = 24;

#[derive(serde::Deserialize)]
pub struct RecordDownloadRequest {
    pub email: String,
    pub app: String,
    /// Honeypot: hidden on the form, so only bots fill it in.
    #[serde(default)]
    pub website: Option<String>,
}

fn json_error(status: StatusCode, message: &str) -> Response {
    (status, Json(serde_json::json!({ "error": message }))).into_response()
}

fn header_value(headers: &HeaderMap, name: header::HeaderName) -> Option<String> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .map(|v| v.chars().take(512).collect())
}

#[tracing::instrument(
    name = "API: Record download",
    skip(pool, email_client, base_url, headers, body),
    fields(app = %body.app)
)]
pub async fn api_record_download(
    State(pool): State<SqlitePool>,
    State(email_client): State<EmailClient>,
    State(base_url): State<ApplicationBaseUrl>,
    headers: HeaderMap,
    Json(body): Json<RecordDownloadRequest>,
) -> Response {
    if body.website.as_deref().is_some_and(|w| !w.is_empty()) {
        return (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({"status": "recorded"})),
        )
            .into_response();
    }

    let Some(app) = DOWNLOADABLE_APPS.iter().find(|a| a.slug == body.app) else {
        return json_error(StatusCode::BAD_REQUEST, "Unknown app");
    };

    let email = match SubscriberEmail::parse(body.email.trim().to_lowercase()) {
        Ok(email) => email,
        Err(e) => return json_error(StatusCode::BAD_REQUEST, &e),
    };

    let mut transaction = match pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to begin transaction");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong");
        }
    };

    let result = record_download(
        &mut transaction,
        &email,
        app,
        header_value(&headers, header::REFERER),
        header_value(&headers, header::USER_AGENT),
        &base_url.0,
    )
    .await;

    let email_to_send = match result {
        Ok(email_to_send) => email_to_send,
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to record download");
            return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong");
        }
    };

    if let Err(e) = transaction.commit().await {
        tracing::error!(error.cause_chain = ?e, "Failed to commit transaction");
        return json_error(StatusCode::INTERNAL_SERVER_ERROR, "Something went wrong");
    }

    // The download page navigates away right after posting, so send the email off
    // the request path where a dropped connection can't cancel it.
    if let Some(subscribe_link) = email_to_send {
        tokio::spawn(async move {
            if let Err(e) =
                send_download_thanks_email(&email_client, &email, app, subscribe_link).await
            {
                tracing::error!(error.cause_chain = ?e, "Failed to send download thank-you email");
            }
        });
    }

    (
        StatusCode::ACCEPTED,
        Json(serde_json::json!({"status": "recorded"})),
    )
        .into_response()
}

/// Inserts the download row. Returns `None` when no email should go out, or
/// `Some(subscribe_link)` where the link is `None` for confirmed subscribers.
async fn record_download(
    transaction: &mut Transaction<'_, Sqlite>,
    email: &SubscriberEmail,
    app: &DownloadableApp,
    referrer: Option<String>,
    user_agent: Option<String>,
    base_url: &str,
) -> Result<Option<Option<String>>, sqlx::Error> {
    let now = Utc::now();
    let now_str = now.to_rfc3339();
    let cutoff = (now - chrono::Duration::hours(EMAIL_COOLDOWN_HOURS)).to_rfc3339();
    let email_str = email.as_ref();

    let recently_emailed = sqlx::query_scalar!(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM downloads WHERE email = ? AND app = ? AND downloaded_at > ?
        ) as "exists!: bool"
        "#,
        email_str,
        app.slug,
        cutoff,
    )
    .fetch_one(transaction.as_mut())
    .await?;

    let id = Uuid::new_v4().to_string();
    sqlx::query!(
        r#"
        INSERT INTO downloads (id, email, app, downloaded_at, referrer, user_agent)
        VALUES (?, ?, ?, ?, ?, ?)
        "#,
        id,
        email_str,
        app.slug,
        now_str,
        referrer,
        user_agent,
    )
    .execute(transaction.as_mut())
    .await?;

    if recently_emailed {
        return Ok(None);
    }

    // Reuse the newsletter's double opt-in: downloaders who aren't subscribed get a
    // pending subscription whose confirm link doubles as the "subscribe" button.
    let subscriber_id = match get_subscriber_by_email(transaction, email).await? {
        Some((_, status)) if status == "confirmed" => return Ok(Some(None)),
        Some((subscriber_id, _)) => subscriber_id,
        None => {
            let new_subscriber = NewSubscriber {
                email: email.clone(),
                name: None,
            };
            insert_subscriber(transaction, &new_subscriber).await?
        }
    };

    let token = SubscriptionToken::generate();
    store_token(transaction, subscriber_id, token.as_ref()).await?;

    Ok(Some(Some(format!(
        "{}/subscriptions/confirm?subscription_token={}",
        base_url,
        token.as_ref()
    ))))
}

#[tracing::instrument(name = "Send download thank-you email", skip_all, fields(app = %app.slug))]
async fn send_download_thanks_email(
    email_client: &EmailClient,
    recipient: &SubscriberEmail,
    app: &DownloadableApp,
    subscribe_link: Option<String>,
) -> Result<(), reqwest::Error> {
    let html_body = DownloadThanksEmailHtml {
        app_name: app.name.to_string(),
        download_url: app.download_url.to_string(),
        subscribe_link: subscribe_link.clone(),
    }
    .render()
    .expect("Failed to render HTML email template");

    let plain_body = DownloadThanksEmailText {
        app_name: app.name.to_string(),
        download_url: app.download_url.to_string(),
        subscribe_link,
    }
    .render()
    .expect("Failed to render text email template");

    email_client
        .send_email(
            recipient,
            &format!("Thanks for downloading {}", app.name),
            &html_body,
            &plain_body,
            None,
        )
        .await
}
