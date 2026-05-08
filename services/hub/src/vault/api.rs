use crate::startup::AppState;
use crate::vault::auth::require_api_token;
use crate::vault::{new_id, now_rfc3339, strip_nuls, strip_nuls_json};
use axum::Json;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Deserialize, Serialize)]
pub struct BatchPayload {
    pub client_id: String,
    pub session: SessionPayload,
    pub events: Vec<EventPayload>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct SessionPayload {
    pub external_session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub repo_remote: Option<String>,
    pub repo_branch: Option<String>,
    pub repo_head: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
pub struct EventPayload {
    pub external_event_id: Option<String>,
    pub parent_external_event_id: Option<String>,
    pub event_hash: String,
    pub role: String,
    pub kind: String,
    pub content: Option<String>,
    #[serde(default)]
    pub metadata: Value,
    pub created_at: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BatchResponse {
    pub thread_id: String,
    pub thread_url: String,
    pub accepted: u64,
    pub duplicates: u64,
}

#[tracing::instrument(name = "Vault: Ingest events", skip_all)]
pub async fn ingest_events(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut payload): Json<BatchPayload>,
) -> Result<Json<BatchResponse>, StatusCode> {
    let _client_id = require_api_token(&headers, &state.db_pool).await?;
    let now = now_rfc3339();
    sanitize_batch(&mut payload);

    let existing_thread_id: Option<String> =
        sqlx::query_scalar("SELECT id FROM vault_threads WHERE external_session_id = $1")
            .bind(&payload.session.external_session_id)
            .fetch_optional(&state.db_pool)
            .await
            .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let thread_id = existing_thread_id.unwrap_or_else(|| new_id("thr"));

    let title = payload
        .session
        .title
        .clone()
        .or_else(|| derive_thread_title(&payload.events));

    sqlx::query(
        r#"INSERT INTO vault_threads (
             id, external_session_id, title, cwd, repo_remote, repo_branch, repo_head,
             default_visibility, created_at, updated_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
           ON CONFLICT (external_session_id) DO UPDATE SET
             title       = COALESCE(EXCLUDED.title,       vault_threads.title),
             cwd         = COALESCE(EXCLUDED.cwd,         vault_threads.cwd),
             repo_remote = COALESCE(EXCLUDED.repo_remote, vault_threads.repo_remote),
             repo_branch = COALESCE(EXCLUDED.repo_branch, vault_threads.repo_branch),
             repo_head   = COALESCE(EXCLUDED.repo_head,   vault_threads.repo_head),
             updated_at  = EXCLUDED.updated_at"#,
    )
    .bind(&thread_id)
    .bind(&payload.session.external_session_id)
    .bind(&title)
    .bind(&payload.session.cwd)
    .bind(&payload.session.repo_remote)
    .bind(&payload.session.repo_branch)
    .bind(&payload.session.repo_head)
    .bind(&state.vault.default_visibility)
    .bind(&now)
    .bind(&now)
    .execute(&state.db_pool)
    .await
    .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

    let mut accepted = 0;
    let mut duplicates = 0;
    for event in &payload.events {
        let result = sqlx::query(
            r#"INSERT INTO vault_thread_events (
                 id, thread_id, external_event_id, parent_external_event_id, event_hash, role,
                 kind, content, redacted, metadata_json, created_at, inserted_at
               ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, TRUE, $9, $10, $11)
               ON CONFLICT (thread_id, event_hash) DO NOTHING"#,
        )
        .bind(new_id("evt"))
        .bind(&thread_id)
        .bind(&event.external_event_id)
        .bind(&event.parent_external_event_id)
        .bind(&event.event_hash)
        .bind(&event.role)
        .bind(&event.kind)
        .bind(&event.content)
        .bind(event.metadata.to_string())
        .bind(&event.created_at)
        .bind(&now)
        .execute(&state.db_pool)
        .await
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;

        if result.rows_affected() == 0 {
            duplicates += 1;
        } else {
            accepted += 1;
        }
    }

    persist_batch_blob(&state, &thread_id, &payload)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to persist event batch blob");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    let thread_url = format!(
        "{}/admin/threads/{}",
        state.vault.base_url.trim_end_matches('/'),
        thread_id
    );
    Ok(Json(BatchResponse {
        thread_id,
        thread_url,
        accepted,
        duplicates,
    }))
}

#[derive(Debug, Deserialize, Serialize)]
pub struct HandoffPayload {
    pub source_thread_id: String,
    pub target_external_session_id: Option<String>,
    pub goal: String,
    pub generated_prompt: String,
    #[serde(default)]
    pub source_event_ids: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct HandoffResponse {
    pub handoff_id: String,
}

#[tracing::instrument(name = "Vault: Record handoff", skip_all)]
pub async fn handoff_record(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(mut payload): Json<HandoffPayload>,
) -> Result<Json<HandoffResponse>, StatusCode> {
    let _client_id = require_api_token(&headers, &state.db_pool).await?;
    let now = now_rfc3339();
    let handoff_id = new_id("hnd");
    sanitize_handoff(&mut payload);
    let target_thread_id: Option<String> = match &payload.target_external_session_id {
        Some(external_id) => {
            sqlx::query_scalar("SELECT id FROM vault_threads WHERE external_session_id = $1")
                .bind(external_id)
                .fetch_optional(&state.db_pool)
                .await
                .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?
        }
        None => None,
    };

    sqlx::query(
        r#"INSERT INTO vault_handoffs (
             id, source_thread_id, target_thread_id, target_external_session_id, goal,
             generated_prompt, source_event_ids_json, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)"#,
    )
    .bind(&handoff_id)
    .bind(&payload.source_thread_id)
    .bind(&target_thread_id)
    .bind(&payload.target_external_session_id)
    .bind(&payload.goal)
    .bind(&payload.generated_prompt)
    .bind(serde_json::to_string(&payload.source_event_ids).unwrap_or_else(|_| "[]".into()))
    .bind(&now)
    .execute(&state.db_pool)
    .await
    .map_err(|error| {
        tracing::warn!(?error, "failed to record handoff");
        StatusCode::BAD_REQUEST
    })?;

    persist_handoff_blob(&state, &handoff_id, &payload)
        .await
        .map_err(|error| {
            tracing::error!(?error, "failed to persist handoff blob");
            StatusCode::INTERNAL_SERVER_ERROR
        })?;

    Ok(Json(HandoffResponse { handoff_id }))
}

fn derive_thread_title(events: &[EventPayload]) -> Option<String> {
    let content = events
        .iter()
        .find(|event| event.role == "user" && event.content.as_deref().is_some_and(has_words))
        .and_then(|event| event.content.as_deref())
        .or_else(|| {
            events
                .iter()
                .find(|event| event.content.as_deref().is_some_and(has_words))
                .and_then(|event| event.content.as_deref())
        })?;
    Some(compact_title(content))
}

fn has_words(value: &str) -> bool {
    value
        .split_whitespace()
        .any(|word| word.chars().any(char::is_alphanumeric))
}

fn compact_title(content: &str) -> String {
    let mut text = content
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty() && !line.starts_with("```") && !line.starts_with('{'))
        .unwrap_or(content)
        .trim_start_matches('#')
        .trim()
        .to_string();

    text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if text.len() <= 80 {
        return text;
    }

    let mut end = 80;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    let truncated = &text[..end];
    let end = truncated
        .rfind(' ')
        .filter(|index| *index >= 48)
        .unwrap_or(end);
    format!(
        "{}…",
        text[..end].trim_end_matches(&['.', ',', ':', ';', '-'][..])
    )
}

async fn persist_batch_blob(
    state: &AppState,
    thread_id: &str,
    payload: &BatchPayload,
) -> anyhow::Result<()> {
    let dir = state.vault.data_dir.join("blobs/events").join(thread_id);
    tokio::fs::create_dir_all(&dir).await?;
    let hash = short_hash(&serde_json::to_vec(payload)?);
    let path = dir.join(format!("{}-{}.json", now_rfc3339().replace(':', ""), hash));
    tokio::fs::write(path, serde_json::to_vec_pretty(payload)?).await?;

    let snapshot_path = state
        .vault
        .data_dir
        .join("blobs/redacted_sessions")
        .join(format!("{}.json", thread_id));
    let rows = sqlx::query_as::<_, (String, String, Option<String>, Option<String>)>(
        r#"SELECT role, kind, content, created_at FROM vault_thread_events
           WHERE thread_id = $1
           ORDER BY COALESCE(created_at, inserted_at), inserted_seq"#,
    )
    .bind(thread_id)
    .fetch_all(&state.db_pool)
    .await?;
    let events: Vec<Value> = rows
        .into_iter()
        .map(|(role, kind, content, created_at)| {
            serde_json::json!({
                "role": role,
                "kind": kind,
                "content": content,
                "created_at": created_at,
            })
        })
        .collect();
    tokio::fs::write(snapshot_path, serde_json::to_vec_pretty(&events)?).await?;
    Ok(())
}

async fn persist_handoff_blob(
    state: &AppState,
    handoff_id: &str,
    payload: &HandoffPayload,
) -> anyhow::Result<()> {
    let path = state
        .vault
        .data_dir
        .join("blobs/handoffs")
        .join(format!("{}.json", handoff_id));
    tokio::fs::write(path, serde_json::to_vec_pretty(payload)?).await?;
    Ok(())
}

fn short_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())[..12].to_string()
}

fn sanitize_batch(payload: &mut BatchPayload) {
    let s = &mut payload.session;
    sanitize_in_place(&mut s.external_session_id);
    sanitize_opt(&mut s.title);
    sanitize_opt(&mut s.cwd);
    sanitize_opt(&mut s.repo_remote);
    sanitize_opt(&mut s.repo_branch);
    sanitize_opt(&mut s.repo_head);
    for event in &mut payload.events {
        sanitize_opt(&mut event.external_event_id);
        sanitize_opt(&mut event.parent_external_event_id);
        sanitize_in_place(&mut event.event_hash);
        sanitize_in_place(&mut event.role);
        sanitize_in_place(&mut event.kind);
        sanitize_opt(&mut event.content);
        sanitize_opt(&mut event.created_at);
        strip_nuls_json(&mut event.metadata);
    }
}

fn sanitize_handoff(payload: &mut HandoffPayload) {
    sanitize_in_place(&mut payload.source_thread_id);
    sanitize_opt(&mut payload.target_external_session_id);
    sanitize_in_place(&mut payload.goal);
    sanitize_in_place(&mut payload.generated_prompt);
    for id in &mut payload.source_event_ids {
        sanitize_in_place(id);
    }
}

fn sanitize_in_place(value: &mut String) {
    if value.contains('\0') {
        *value = strip_nuls(value);
    }
}

fn sanitize_opt(value: &mut Option<String>) {
    if let Some(inner) = value.as_mut() {
        sanitize_in_place(inner);
    }
}
