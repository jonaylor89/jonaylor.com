use askama::Template;
use axum::body::Bytes;
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Redirect, Response};

use chrono::{DateTime, Local, Utc};
use serde::Deserialize;
use sqlx::{PgPool, Row};

use crate::domain::{MAX_PASTE_BYTES, PasteContent, PasteContentError, PasteId};
use crate::startup::AppState;
use crate::vault::auth::require_api_token;
use crate::vault::templates::HtmlTemplate;

#[derive(Debug, Clone)]
pub struct PasteSummary {
    pub id: String,
    pub public_url: String,
    pub created_at: String,
    pub created_at_display: String,
    pub size_bytes: usize,
    pub line_count: usize,
    pub preview: String,
}

#[derive(Debug, Clone)]
pub struct PasteDetail {
    pub id: String,
    pub public_url: String,
    pub raw_url: String,
    pub created_at: String,
    pub created_at_display: String,
    pub size_bytes: usize,
    pub line_count: usize,
    pub content: String,
}

#[derive(Template)]
#[template(path = "web/pastebin/admin.html")]
pub struct PastebinAdminTemplate {
    pub pastes: Vec<PasteSummary>,
    pub max_paste_kb: usize,
}

#[derive(Template)]
#[template(path = "web/pastebin/paste.html")]
pub struct PasteTemplate {
    pub paste: PasteDetail,
}

#[derive(Deserialize)]
pub struct CreatePasteForm {
    pub content: String,
}

#[derive(Default, Deserialize)]
pub struct PasteQuery {
    pub raw: Option<String>,
}

pub async fn pastebin_admin(State(state): State<AppState>) -> Response {
    match list_pastes(&state.db_pool, &state.vault.base_url).await {
        Ok(pastes) => HtmlTemplate(PastebinAdminTemplate {
            pastes,
            max_paste_kb: MAX_PASTE_BYTES / 1024,
        })
        .into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load pastes");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn create_paste_from_form(
    State(state): State<AppState>,
    Form(form): Form<CreatePasteForm>,
) -> Response {
    let content = match PasteContent::parse(form.content) {
        Ok(content) => content,
        Err(PasteContentError::Empty) => {
            return (StatusCode::BAD_REQUEST, "paste content is required").into_response();
        }
        Err(PasteContentError::TooLarge { max_bytes, .. }) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                format!("paste must be at most {} KiB", max_bytes / 1024),
            )
                .into_response();
        }
    };

    match insert_paste(&state.db_pool, &content).await {
        Ok(id) => Redirect::to(&format!("/p/{id}")).into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to create paste");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn delete_paste(State(state): State<AppState>, Path(paste_id): Path<String>) -> Response {
    let paste_id = match PasteId::parse(paste_id) {
        Ok(paste_id) => paste_id,
        Err(_) => return StatusCode::BAD_REQUEST.into_response(),
    };
    match sqlx::query("DELETE FROM pastes WHERE id = $1")
        .bind(paste_id.as_ref())
        .execute(&state.db_pool)
        .await
    {
        Ok(_) => Redirect::to("/admin/pastebin").into_response(),
        Err(error) => {
            tracing::error!(?error, paste_id = %paste_id, "failed to delete paste");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn api_create_paste(
    headers: HeaderMap,
    State(state): State<AppState>,
    body: Bytes,
) -> Response {
    if require_api_token(&headers, &state.db_pool).await.is_err() {
        return (StatusCode::UNAUTHORIZED, "invalid or missing bearer token").into_response();
    }
    let content = match String::from_utf8(body.to_vec()) {
        Ok(content) => match PasteContent::parse(content) {
            Ok(content) => content,
            Err(PasteContentError::Empty) => {
                return (StatusCode::BAD_REQUEST, "paste content is required").into_response();
            }
            Err(PasteContentError::TooLarge { max_bytes, .. }) => {
                return (
                    StatusCode::PAYLOAD_TOO_LARGE,
                    format!("paste must be at most {} KiB", max_bytes / 1024),
                )
                    .into_response();
            }
        },
        Err(_) => return (StatusCode::BAD_REQUEST, "paste content must be UTF-8").into_response(),
    };

    match insert_paste(&state.db_pool, &content).await {
        Ok(id) => {
            let url = format!("{}/p/{id}\n", state.vault.base_url.trim_end_matches('/'));
            ([(header::CONTENT_TYPE, "text/plain; charset=utf-8")], url).into_response()
        }
        Err(error) => {
            tracing::error!(?error, "failed to create paste via api");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn show_paste(
    State(state): State<AppState>,
    Path(paste_path): Path<String>,
    Query(query): Query<PasteQuery>,
    headers: HeaderMap,
) -> Response {
    let paste_id = paste_path
        .split_once('.')
        .map_or(paste_path.as_str(), |(id, _)| id);
    let paste_id = match PasteId::parse(paste_id.to_string()) {
        Ok(paste_id) => paste_id,
        Err(_) => return StatusCode::NOT_FOUND.into_response(),
    };
    let paste = match load_paste(&state.db_pool, paste_id.as_ref(), &state.vault.base_url).await {
        Ok(Some(paste)) => paste,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, paste_id = %paste_id, "failed to load paste");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if query.raw.is_some() || wants_plaintext(&headers) {
        return (
            [(header::CONTENT_TYPE, "text/plain; charset=utf-8")],
            paste.content,
        )
            .into_response();
    }

    HtmlTemplate(PasteTemplate { paste }).into_response()
}

async fn list_pastes(pool: &PgPool, base_url: &str) -> anyhow::Result<Vec<PasteSummary>> {
    let rows = sqlx::query(
        "SELECT id, content, created_at FROM pastes ORDER BY created_at DESC LIMIT 100",
    )
    .fetch_all(pool)
    .await?;

    Ok(rows
        .into_iter()
        .map(|row| {
            let id: String = row.get("id");
            let content: String = row.get("content");
            let created_at: DateTime<Utc> = row.get("created_at");
            PasteSummary {
                public_url: public_url(base_url, &id),
                id,
                created_at: created_at.to_rfc3339(),
                created_at_display: display_datetime(created_at),
                size_bytes: content.len(),
                line_count: line_count(&content),
                preview: preview(&content),
            }
        })
        .collect())
}

async fn load_paste(
    pool: &PgPool,
    paste_id: &str,
    base_url: &str,
) -> anyhow::Result<Option<PasteDetail>> {
    let Some(row) = sqlx::query("SELECT id, content, created_at FROM pastes WHERE id = $1")
        .bind(paste_id)
        .fetch_optional(pool)
        .await?
    else {
        return Ok(None);
    };

    let id: String = row.get("id");
    let content: String = row.get("content");
    let created_at: DateTime<Utc> = row.get("created_at");
    Ok(Some(PasteDetail {
        public_url: public_url(base_url, &id),
        raw_url: format!("/p/{id}?raw=1"),
        id,
        created_at: created_at.to_rfc3339(),
        created_at_display: display_datetime(created_at),
        size_bytes: content.len(),
        line_count: line_count(&content),
        content,
    }))
}

async fn insert_paste(pool: &PgPool, content: &PasteContent) -> anyhow::Result<String> {
    for _ in 0..16 {
        let id = PasteId::generate();
        let inserted = sqlx::query(
            "INSERT INTO pastes (id, content) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING RETURNING id",
        )
        .bind(id.as_ref())
        .bind(content.as_ref())
        .fetch_optional(pool)
        .await?;
        if inserted.is_some() {
            return Ok(id.to_string());
        }
    }

    anyhow::bail!("failed to allocate a unique paste id")
}

fn wants_plaintext(headers: &HeaderMap) -> bool {
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split('/').next());
    if matches!(user_agent, None | Some("curl" | "Wget" | "HTTPie")) {
        return true;
    }

    headers
        .get(header::ACCEPT)
        .and_then(|value| value.to_str().ok())
        .is_some_and(|accept| accept.contains("text/plain"))
}

fn public_url(base_url: &str, id: &str) -> String {
    format!("{}/p/{id}", base_url.trim_end_matches('/'))
}

fn display_datetime(value: DateTime<Utc>) -> String {
    value
        .with_timezone(&Local)
        .format("%b %-d, %Y %-I:%M %p")
        .to_string()
}

fn line_count(content: &str) -> usize {
    content.lines().count().max(1)
}

fn preview(content: &str) -> String {
    let normalized = content.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut chars = normalized.chars();
    let preview: String = chars.by_ref().take(120).collect();
    if chars.next().is_some() {
        format!("{preview}…")
    } else if preview.is_empty() {
        "(blank paste)".to_string()
    } else {
        preview
    }
}
