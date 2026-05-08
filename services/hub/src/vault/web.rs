use crate::startup::AppState;
use crate::vault::auth::{sign, verify_signature};
use crate::vault::search::search_events;
use crate::vault::templates::*;
use crate::vault::{new_id, now_rfc3339, token_hash};
use argon2::password_hash::SaltString;
use argon2::{Argon2, PasswordHash, PasswordHasher, PasswordVerifier};
use axum::extract::{Form, Path, Query, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use chrono::{DateTime, Local, Utc};
use rand::RngCore;
use serde::Deserialize;
use serde_json::Value;
use sqlx::{PgPool, Row};
use std::collections::BTreeMap;

// ---------- Admin-portal vault routes (session-guarded by router layer) ----------

pub async fn threads_index(State(state): State<AppState>) -> Response {
    match list_threads(&state.db_pool).await {
        Ok(threads) => HtmlTemplate(IndexTemplate { threads }).into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load thread list");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn thread_page(State(state): State<AppState>, Path(thread_id): Path<String>) -> Response {
    let thread = match load_thread(&state.db_pool, &thread_id).await {
        Ok(Some(thread)) => thread,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load thread");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    render_thread(&state, thread).await
}

pub async fn thread_tree(State(state): State<AppState>, Path(thread_id): Path<String>) -> Response {
    let thread = match load_thread(&state.db_pool, &thread_id).await {
        Ok(Some(thread)) => thread,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load thread tree");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let events = match load_events(&state.db_pool, &thread.id).await {
        Ok(events) => events,
        Err(error) => {
            tracing::error!(?error, "failed to load events");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    HtmlTemplate(TreeTemplate { thread, events }).into_response()
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

pub async fn global_search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Response {
    render_search(&state, query.q.unwrap_or_default(), None).await
}

pub async fn thread_search(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> Response {
    let thread = match load_thread(&state.db_pool, &thread_id).await {
        Ok(Some(thread)) => thread,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load thread");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    render_search(&state, query.q.unwrap_or_default(), Some(thread.id)).await
}

#[derive(Deserialize)]
pub struct ShareForm {
    pub share_kind: String,
    pub password: Option<String>,
}

pub async fn create_share(
    State(state): State<AppState>,
    Path(thread_id): Path<String>,
    Form(form): Form<ShareForm>,
) -> Response {
    if !state.vault.public_sharing && form.share_kind != "private" {
        return (StatusCode::FORBIDDEN, "public sharing is disabled").into_response();
    }

    match form.share_kind.as_str() {
        "private" => match set_thread_visibility(&state.db_pool, &thread_id, "private").await {
            Ok(()) => Redirect::to(&format!("/admin/threads/{}", thread_id)).into_response(),
            Err(error) => share_error(error),
        },
        "public" => match create_public_share(&state.db_pool, &thread_id).await {
            Ok(()) => Redirect::to(&format!("/admin/threads/{}", thread_id)).into_response(),
            Err(error) => share_error(error),
        },
        "secret-link" => {
            match create_token_share(&state.db_pool, &thread_id, "secret-link", None).await {
                Ok(token) => render_share_created(&state, &thread_id, &token),
                Err(error) => share_error(error),
            }
        }
        "password-protected" => {
            let Some(password) = form.password.filter(|p| !p.is_empty()) else {
                return (StatusCode::BAD_REQUEST, "password is required").into_response();
            };
            let hash = match hash_password(&password) {
                Ok(hash) => hash,
                Err(error) => {
                    tracing::error!(?error, "failed to hash share password");
                    return StatusCode::INTERNAL_SERVER_ERROR.into_response();
                }
            };
            match create_token_share(&state.db_pool, &thread_id, "password-protected", Some(hash))
                .await
            {
                Ok(token) => render_share_created(&state, &thread_id, &token),
                Err(error) => share_error(error),
            }
        }
        _ => (StatusCode::BAD_REQUEST, "unknown share kind").into_response(),
    }
}

fn render_share_created(state: &AppState, thread_id: &str, token: &str) -> Response {
    let url = format!("{}/s/{}", state.vault.base_url.trim_end_matches('/'), token);
    Html(format!(
        r#"<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Share created</title></head><body><h1>Share created</h1><p>This secret URL is only shown once because only its hash is stored.</p><p><a href="{url}">{url}</a></p><p><a href="/admin/threads/{thread_id}">Back to thread</a></p></body></html>"#
    ))
    .into_response()
}

fn share_error(error: anyhow::Error) -> Response {
    tracing::error!(?error, "failed to update sharing");
    StatusCode::INTERNAL_SERVER_ERROR.into_response()
}

pub async fn vault_admin(State(state): State<AppState>) -> Response {
    let clients = match load_clients(&state.db_pool).await {
        Ok(clients) => clients,
        Err(error) => {
            tracing::error!(?error, "failed to load clients");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let shares = match sqlx::query(
        "SELECT id, thread_id, share_kind, revoked_at, created_at FROM vault_shares ORDER BY created_at DESC LIMIT 100",
    )
    .fetch_all(&state.db_pool)
    .await
    {
        Ok(rows) => rows
            .into_iter()
            .map(|row| {
                let created_at: String = row.get("created_at");
                let revoked_at: Option<String> = row.get("revoked_at");
                AdminShareDetail {
                    id: row.get("id"),
                    thread_id: row.get("thread_id"),
                    share_kind: row.get("share_kind"),
                    revoked_at_display: revoked_at.as_deref().map(display_datetime),
                    revoked_at,
                    created_at_display: display_datetime(&created_at),
                    created_at,
                }
            })
            .collect(),
        Err(error) => {
            tracing::error!(?error, "failed to load shares");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    HtmlTemplate(AdminTemplate {
        clients,
        shares,
        public_sharing: state.vault.public_sharing,
    })
    .into_response()
}

async fn load_clients(pool: &PgPool) -> anyhow::Result<Vec<ClientDetail>> {
    let rows = sqlx::query(
        "SELECT id, name, token_prefix, created_at, last_seen_at, revoked_at \
           FROM vault_clients ORDER BY created_at DESC",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let created_at: String = row.get("created_at");
            let last_seen_at: Option<String> = row.get("last_seen_at");
            let revoked_at: Option<String> = row.get("revoked_at");
            ClientDetail {
                id: row.get("id"),
                name: row.get("name"),
                token_prefix: row.get("token_prefix"),
                created_at_display: display_datetime(&created_at),
                created_at,
                last_seen_at_display: last_seen_at.as_deref().map(display_datetime),
                last_seen_at,
                revoked_at_display: revoked_at.as_deref().map(display_datetime),
                revoked_at,
            }
        })
        .collect())
}

#[derive(Deserialize)]
pub struct NewClientForm {
    pub name: String,
}

pub async fn create_api_key(
    State(state): State<AppState>,
    Form(form): Form<NewClientForm>,
) -> Response {
    let name = form.name.trim();
    if name.is_empty() {
        return (StatusCode::BAD_REQUEST, "client name is required").into_response();
    }
    match crate::vault::keys::issue_api_key(&state.db_pool, name).await {
        Ok(key) => HtmlTemplate(KeyCreatedTemplate {
            client_id: key.client_id,
            name: key.name,
            plaintext_token: key.plaintext_token,
            token_prefix: key.token_prefix,
        })
        .into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to issue api key");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn revoke_api_key(
    State(state): State<AppState>,
    Path(client_id): Path<String>,
) -> Response {
    match crate::vault::keys::revoke_api_key(&state.db_pool, &client_id).await {
        Ok(true) => Redirect::to("/admin/vault").into_response(),
        Ok(false) => StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to revoke api key");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

pub async fn revoke_share(State(state): State<AppState>, Path(share_id): Path<String>) -> Response {
    let row = match sqlx::query("SELECT thread_id, share_kind FROM vault_shares WHERE id = $1")
        .bind(&share_id)
        .fetch_optional(&state.db_pool)
        .await
    {
        Ok(Some(row)) => row,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load share for revocation");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    let thread_id: String = row.get("thread_id");
    let share_kind: String = row.get("share_kind");
    let now = now_rfc3339();
    let mut transaction = match state.db_pool.begin().await {
        Ok(transaction) => transaction,
        Err(error) => {
            tracing::error!(?error, "failed to start share revocation transaction");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if let Err(error) = sqlx::query("UPDATE vault_shares SET revoked_at = $1 WHERE id = $2")
        .bind(&now)
        .bind(&share_id)
        .execute(&mut *transaction)
        .await
    {
        tracing::error!(?error, "failed to revoke share");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if share_kind == "public"
        && let Err(error) = sqlx::query(
            "UPDATE vault_threads SET default_visibility = 'private', updated_at = $1 WHERE id = $2",
        )
        .bind(&now)
        .bind(&thread_id)
        .execute(&mut *transaction)
        .await
    {
        tracing::error!(
            ?error,
            "failed to make public thread private during revocation"
        );
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }
    if let Err(error) = transaction.commit().await {
        tracing::error!(?error, "failed to commit share revocation");
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    }

    Redirect::to("/admin/vault").into_response()
}

// ---------- Public share routes (no session required) ----------

pub async fn get_shared_thread(
    State(state): State<AppState>,
    Path(share_token): Path<String>,
    headers: HeaderMap,
) -> Response {
    let share = match load_share_by_token(&state.db_pool, &share_token).await {
        Ok(Some(share)) => share,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load share");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };

    if share.revoked_at.is_some() {
        return StatusCode::GONE.into_response();
    }
    if share.share_kind == "password-protected"
        && !has_share_cookie(&headers, &share.id, &state.vault.hmac_secret)
    {
        return HtmlTemplate(SharePasswordTemplate {
            share_token,
            error: None,
        })
        .into_response();
    }

    let thread = match load_thread(&state.db_pool, &share.thread_id).await {
        Ok(Some(thread)) => thread,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load shared thread");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    render_thread(&state, thread).await
}

#[derive(Deserialize)]
pub struct PasswordForm {
    pub password: String,
}

pub async fn password_share(
    State(state): State<AppState>,
    Path(share_token): Path<String>,
    Form(form): Form<PasswordForm>,
) -> Response {
    let share = match load_share_by_token(&state.db_pool, &share_token).await {
        Ok(Some(share)) => share,
        Ok(None) => return StatusCode::NOT_FOUND.into_response(),
        Err(error) => {
            tracing::error!(?error, "failed to load share");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let Some(password_hash) = share.password_hash else {
        return StatusCode::BAD_REQUEST.into_response();
    };
    if verify_password(&password_hash, &form.password) {
        let cookie_value = signed_share_cookie(&share.id, &state.vault.hmac_secret);
        let cookie = format!(
            "ptv_share_{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000",
            share.id, cookie_value
        );
        return (
            [(header::SET_COOKIE, cookie)],
            Redirect::to(&format!("/s/{}", share_token)),
        )
            .into_response();
    }
    HtmlTemplate(SharePasswordTemplate {
        share_token,
        error: Some("Incorrect password".into()),
    })
    .into_response()
}

// ---------- Rendering helpers ----------

async fn render_search(state: &AppState, query: String, thread_id: Option<String>) -> Response {
    match search_events(&state.db_pool, &query, thread_id.as_deref()).await {
        Ok(results) => HtmlTemplate(SearchTemplate {
            query,
            thread_id,
            results,
        })
        .into_response(),
        Err(error) => {
            tracing::error!(?error, "search failed");
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        }
    }
}

async fn render_thread(state: &AppState, thread: ThreadDetail) -> Response {
    let events = match load_events(&state.db_pool, &thread.id).await {
        Ok(events) => events,
        Err(error) => {
            tracing::error!(?error, "failed to load events");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let shares = match load_shares(&state.db_pool, &thread.id, &state.vault.base_url).await {
        Ok(shares) => shares,
        Err(error) => {
            tracing::error!(?error, "failed to load shares");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let handoffs = match load_handoffs(&state.db_pool, &thread.id).await {
        Ok(handoffs) => handoffs,
        Err(error) => {
            tracing::error!(?error, "failed to load handoffs");
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        }
    };
    let total_events = events.len();
    let system_prompt = extract_system_prompt(&events);
    let available_tools = extract_available_tools(&events);
    let events = events
        .into_iter()
        .filter(|event| !matches!(event.kind.as_str(), "system_prompt" | "tools_snapshot"))
        .collect();
    let events = merge_tool_results(events);
    HtmlTemplate(ThreadTemplate {
        thread,
        events: group_thought_events(events),
        total_events,
        system_prompt,
        available_tools,
        shares,
        handoffs,
        base_url: state.vault.base_url.clone(),
        can_share_publicly: state.vault.public_sharing,
    })
    .into_response()
}

fn extract_system_prompt(events: &[EventDetail]) -> Option<String> {
    events
        .iter()
        .find(|event| event.kind == "system_prompt")
        .and_then(|event| event.content.clone())
        .filter(|content| !content.trim().is_empty())
}

fn extract_available_tools(events: &[EventDetail]) -> Vec<ToolSummary> {
    if let Some(tools) = events
        .iter()
        .find(|event| event.kind == "tools_snapshot")
        .and_then(|event| event.content.as_deref())
        .and_then(parse_tools_snapshot)
    {
        return tools;
    }

    let mut counts = BTreeMap::<String, usize>::new();
    for event in events {
        if let Some(label) = event.tool_label.as_deref()
            && !label.trim().is_empty()
        {
            *counts.entry(label.to_string()).or_default() += 1;
        }
    }
    counts
        .into_iter()
        .map(|(name, count)| ToolSummary { name, count })
        .collect()
}

fn parse_tools_snapshot(content: &str) -> Option<Vec<ToolSummary>> {
    let value: Value = serde_json::from_str(content).ok()?;
    let tools = value.as_array()?;
    let mut out = Vec::new();
    for tool in tools {
        if let Some(name) = tool
            .get("name")
            .or_else(|| tool.get("toolName"))
            .and_then(Value::as_str)
        {
            out.push(ToolSummary {
                name: name.to_string(),
                count: 0,
            });
        }
    }
    (!out.is_empty()).then_some(out)
}

fn group_thought_events(events: Vec<EventDetail>) -> Vec<EventView> {
    let mut out = Vec::new();
    let mut pending_tools: Vec<EventDetail> = Vec::new();
    let mut last_user_at: Option<String> = None;

    for event in events {
        if event.role == "user" {
            flush_pending_tools(&mut out, &mut pending_tools, None);
            last_user_at = event_timestamp(&event);
            out.push(single_event(event));
        } else if is_toolish_event(&event) {
            pending_tools.push(event);
        } else if event.role == "assistant" {
            let duration =
                thought_duration(last_user_at.as_deref(), event_timestamp(&event).as_deref());
            flush_pending_tools(&mut out, &mut pending_tools, duration);
            out.push(single_event(event));
        } else {
            flush_pending_tools(&mut out, &mut pending_tools, None);
            out.push(single_event(event));
        }
    }
    flush_pending_tools(&mut out, &mut pending_tools, None);
    out
}

fn single_event(event: EventDetail) -> EventView {
    EventView {
        event,
        is_thought_group: false,
        thought_duration: None,
        thought_summary: None,
        children: Vec::new(),
    }
}

fn flush_pending_tools(
    out: &mut Vec<EventView>,
    pending_tools: &mut Vec<EventDetail>,
    duration: Option<String>,
) {
    if pending_tools.is_empty() {
        return;
    }
    let children = std::mem::take(pending_tools);
    let thought_summary = summarize_tool_labels(&children);
    let first = children[0].clone();
    out.push(EventView {
        event: first,
        is_thought_group: true,
        thought_duration: duration,
        thought_summary,
        children,
    });
}

fn summarize_tool_labels(events: &[EventDetail]) -> Option<String> {
    let mut counts = BTreeMap::<String, usize>::new();
    for event in events {
        let label = event
            .tool_label
            .as_deref()
            .unwrap_or(event.kind.as_str())
            .trim();
        if label.is_empty() || label == "thinking" {
            continue;
        }
        *counts.entry(label.to_string()).or_default() += 1;
    }
    if counts.is_empty() {
        return None;
    }
    Some(
        counts
            .into_iter()
            .map(|(label, count)| {
                if count == 1 {
                    label
                } else {
                    format!("{label} ×{count}")
                }
            })
            .collect::<Vec<_>>()
            .join(", "),
    )
}

fn is_toolish_event(event: &EventDetail) -> bool {
    matches!(
        event.kind.as_str(),
        "tool" | "tool_call" | "tool_result" | "thinking" | "reasoning"
    ) || matches!(event.role.as_str(), "tool" | "system")
        || (event.role == "assistant"
            && event.kind == "message"
            && event.content.as_deref().is_some_and(has_protocol_prefix)
            && event.display_content.as_deref().is_none_or(str::is_empty))
}

fn extract_tool_call_id(metadata_json: &str) -> Option<String> {
    let metadata: Value = serde_json::from_str(metadata_json).ok()?;
    metadata
        .get("toolCallId")
        .or_else(|| metadata.pointer("/block/toolCallId"))
        .or_else(|| metadata.pointer("/entry/message/toolCallId"))
        .or_else(|| metadata.pointer("/entry/toolCallId"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn extract_is_error(metadata_json: &str) -> bool {
    let Ok(metadata) = serde_json::from_str::<Value>(metadata_json) else {
        return false;
    };
    metadata
        .get("isError")
        .or_else(|| metadata.pointer("/entry/isError"))
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn merge_tool_results(events: Vec<EventDetail>) -> Vec<EventDetail> {
    let mut call_index_by_id = BTreeMap::<String, usize>::new();
    for (idx, event) in events.iter().enumerate() {
        if event.kind == "tool_call"
            && let Some(id) = extract_tool_call_id(&event.metadata_json)
        {
            call_index_by_id.entry(id).or_insert(idx);
        }
    }

    let mut events = events;
    let mut drop = vec![false; events.len()];
    for i in 0..events.len() {
        if !matches!(events[i].kind.as_str(), "tool_result" | "tool") {
            continue;
        }
        let Some(call_id) = extract_tool_call_id(&events[i].metadata_json) else {
            continue;
        };
        let Some(&call_idx) = call_index_by_id.get(&call_id) else {
            continue;
        };
        if call_idx == i {
            continue;
        }
        let result_content = events[i].content.clone();
        let result_metadata = events[i].metadata_json.clone();
        let is_error = extract_is_error(&events[i].metadata_json);
        let call = &mut events[call_idx];
        call.tool_result_content = result_content;
        call.tool_result_metadata_json = Some(result_metadata);
        call.tool_result_is_error = is_error;
        drop[i] = true;
    }

    events
        .into_iter()
        .enumerate()
        .filter_map(|(i, e)| if drop[i] { None } else { Some(e) })
        .collect()
}

fn tool_label(kind: &str, content: Option<&str>, metadata_json: &str) -> Option<String> {
    let metadata: Value = serde_json::from_str(metadata_json).ok()?;
    metadata
        .get("toolName")
        .or_else(|| metadata.pointer("/entry/message/toolName"))
        .or_else(|| metadata.pointer("/block/name"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .or_else(|| tool_label_from_content(kind, content))
}

fn tool_label_from_content(kind: &str, content: Option<&str>) -> Option<String> {
    if !matches!(kind, "tool_call" | "tool" | "tool_result") {
        return None;
    }
    let value: Value = serde_json::from_str(content?).ok()?;
    value
        .get("toolName")
        .or_else(|| value.get("name"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn display_content(role: &str, kind: &str, content: Option<&str>) -> Option<String> {
    let content = content?;
    if role == "assistant" && kind == "message" {
        let stripped = strip_protocol_prefix(content);
        if stripped.trim().is_empty() {
            return None;
        }
        return Some(stripped.trim_start().to_string());
    }
    Some(content.to_string())
}

fn has_protocol_prefix(content: &str) -> bool {
    protocol_prefix_len(content).is_some()
}

fn strip_protocol_prefix(content: &str) -> &str {
    protocol_prefix_len(content)
        .map(|offset| &content[offset..])
        .unwrap_or(content)
}

fn protocol_prefix_len(content: &str) -> Option<usize> {
    let mut stream = serde_json::Deserializer::from_str(content).into_iter::<serde_json::Value>();
    let mut offset = 0;
    let mut saw_protocol = false;

    while let Some(parsed) = stream.next() {
        let Ok(value) = parsed else {
            break;
        };
        if !is_protocol_value(&value) {
            break;
        }
        saw_protocol = true;
        offset = stream.byte_offset();
        let rest = content[offset..].trim_start();
        if rest.is_empty() || rest.starts_with('{') || rest.starts_with('[') {
            continue;
        }
        break;
    }

    saw_protocol.then_some(offset)
}

fn is_protocol_value(value: &serde_json::Value) -> bool {
    value
        .get("type")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|kind| matches!(kind, "thinking" | "reasoning" | "toolCall" | "toolResult"))
}

fn event_timestamp(event: &EventDetail) -> Option<String> {
    event
        .created_at
        .clone()
        .or_else(|| Some(event.inserted_at.clone()))
}

fn thought_duration(start: Option<&str>, end: Option<&str>) -> Option<String> {
    let start = parse_timestamp(start?)?;
    let end = parse_timestamp(end?)?;
    let seconds = end.signed_duration_since(start).num_seconds().max(0);
    Some(format_duration(seconds))
}

fn parse_timestamp(value: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(value)
        .map(|value| value.with_timezone(&Utc))
        .ok()
}

fn display_datetime(value: &str) -> String {
    DateTime::parse_from_rfc3339(value)
        .map(|datetime| {
            datetime
                .with_timezone(&Local)
                .format("%b %-d, %Y %-I:%M %p")
                .to_string()
        })
        .unwrap_or_else(|_| value.to_string())
}

fn format_duration(seconds: i64) -> String {
    if seconds < 60 {
        format!(
            "{} second{}",
            seconds.max(1),
            if seconds == 1 { "" } else { "s" }
        )
    } else if seconds < 3_600 {
        let minutes = (seconds + 30) / 60;
        format!("{} minute{}", minutes, if minutes == 1 { "" } else { "s" })
    } else {
        let hours = (seconds + 1_800) / 3_600;
        format!("{} hour{}", hours, if hours == 1 { "" } else { "s" })
    }
}

// ---------- Database loaders ----------

async fn list_threads(pool: &PgPool) -> anyhow::Result<Vec<ThreadSummary>> {
    let rows = sqlx::query(
        r#"SELECT t.id, t.title, t.repo_remote, t.repo_branch, t.repo_head,
                  t.default_visibility, t.updated_at,
                  COUNT(te.id) AS event_count
             FROM vault_threads t
             LEFT JOIN vault_thread_events te ON te.thread_id = t.id
            GROUP BY t.id
            ORDER BY t.updated_at DESC"#,
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let updated_at: String = row.get("updated_at");
            ThreadSummary {
                id: row.get("id"),
                title: row.get("title"),
                repo_remote: row.get("repo_remote"),
                repo_branch: row.get("repo_branch"),
                repo_head: row.get("repo_head"),
                default_visibility: row.get("default_visibility"),
                updated_at_display: display_datetime(&updated_at),
                updated_at,
                event_count: row.get("event_count"),
            }
        })
        .collect())
}

async fn load_thread(pool: &PgPool, thread_id: &str) -> anyhow::Result<Option<ThreadDetail>> {
    let row = sqlx::query(
        r#"SELECT id, external_session_id, title, cwd, repo_remote, repo_branch, repo_head,
                  default_visibility, created_at, updated_at
             FROM vault_threads WHERE id = $1"#,
    )
    .bind(thread_id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| {
        let created_at: String = row.get("created_at");
        let updated_at: String = row.get("updated_at");
        ThreadDetail {
            id: row.get("id"),
            external_session_id: row.get("external_session_id"),
            title: row.get("title"),
            cwd: row.get("cwd"),
            repo_remote: row.get("repo_remote"),
            repo_branch: row.get("repo_branch"),
            repo_head: row.get("repo_head"),
            default_visibility: row.get("default_visibility"),
            created_at_display: display_datetime(&created_at),
            created_at,
            updated_at_display: display_datetime(&updated_at),
            updated_at,
        }
    }))
}

async fn load_events(pool: &PgPool, thread_id: &str) -> anyhow::Result<Vec<EventDetail>> {
    let rows = sqlx::query(
        r#"SELECT id, external_event_id, parent_external_event_id, role, kind, content,
                  metadata_json, created_at, inserted_at
             FROM vault_thread_events
            WHERE thread_id = $1
            ORDER BY COALESCE(created_at, inserted_at), inserted_seq"#,
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let role: String = row.get("role");
            let kind: String = row.get("kind");
            let content: Option<String> = row.get("content");
            let metadata_json: String = row.get("metadata_json");
            let display_content = display_content(&role, &kind, content.as_deref());
            let tool_label = tool_label(&kind, content.as_deref(), &metadata_json);
            let created_at: Option<String> = row.get("created_at");
            let inserted_at: String = row.get("inserted_at");
            let timestamp_display = created_at
                .as_deref()
                .map(display_datetime)
                .unwrap_or_else(|| display_datetime(&inserted_at));
            EventDetail {
                id: row.get("id"),
                external_event_id: row.get("external_event_id"),
                parent_external_event_id: row.get("parent_external_event_id"),
                role,
                kind,
                content,
                display_content,
                tool_label,
                metadata_json,
                created_at,
                inserted_at,
                timestamp_display,
                tool_result_content: None,
                tool_result_metadata_json: None,
                tool_result_is_error: false,
            }
        })
        .collect())
}

async fn load_shares(
    pool: &PgPool,
    thread_id: &str,
    base_url: &str,
) -> anyhow::Result<Vec<ShareDetail>> {
    let rows = sqlx::query(
        r#"SELECT id, share_kind, token_hash, revoked_at, created_at
             FROM vault_shares WHERE thread_id = $1 ORDER BY created_at DESC"#,
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let share_kind: String = row.get("share_kind");
            let revoked_at: Option<String> = row.get("revoked_at");
            let created_at: String = row.get("created_at");
            ShareDetail {
                id: row.get("id"),
                share_kind: share_kind.clone(),
                url: if share_kind == "public" {
                    Some(format!(
                        "{}/admin/threads/{}",
                        base_url.trim_end_matches('/'),
                        thread_id
                    ))
                } else {
                    None
                },
                revoked_at_display: revoked_at.as_deref().map(display_datetime),
                revoked_at,
                created_at_display: display_datetime(&created_at),
                created_at,
            }
        })
        .collect())
}

async fn load_handoffs(pool: &PgPool, thread_id: &str) -> anyhow::Result<Vec<HandoffDetail>> {
    let rows = sqlx::query(
        r#"SELECT id, source_thread_id, target_thread_id, target_external_session_id,
                  goal, created_at
             FROM vault_handoffs
            WHERE source_thread_id = $1 OR target_thread_id = $1
            ORDER BY created_at DESC"#,
    )
    .bind(thread_id)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|row| {
            let created_at: String = row.get("created_at");
            HandoffDetail {
                id: row.get("id"),
                source_thread_id: row.get("source_thread_id"),
                target_thread_id: row.get("target_thread_id"),
                target_external_session_id: row.get("target_external_session_id"),
                goal: row.get("goal"),
                created_at_display: display_datetime(&created_at),
                created_at,
            }
        })
        .collect())
}

async fn set_thread_visibility(
    pool: &PgPool,
    thread_id: &str,
    visibility: &str,
) -> anyhow::Result<()> {
    sqlx::query("UPDATE vault_threads SET default_visibility = $1, updated_at = $2 WHERE id = $3")
        .bind(visibility)
        .bind(now_rfc3339())
        .bind(thread_id)
        .execute(pool)
        .await?;
    Ok(())
}

async fn create_public_share(pool: &PgPool, thread_id: &str) -> anyhow::Result<()> {
    set_thread_visibility(pool, thread_id, "public").await?;
    sqlx::query(
        r#"INSERT INTO vault_shares (id, thread_id, share_kind, is_public, created_at)
           VALUES ($1, $2, 'public', TRUE, $3)"#,
    )
    .bind(new_id("shr"))
    .bind(thread_id)
    .bind(now_rfc3339())
    .execute(pool)
    .await?;
    Ok(())
}

async fn create_token_share(
    pool: &PgPool,
    thread_id: &str,
    kind: &str,
    password_hash: Option<String>,
) -> anyhow::Result<String> {
    let token = random_token();
    sqlx::query(
        r#"INSERT INTO vault_shares
             (id, thread_id, share_kind, token_hash, password_hash, is_public, created_at)
           VALUES ($1, $2, $3, $4, $5, FALSE, $6)"#,
    )
    .bind(new_id("shr"))
    .bind(thread_id)
    .bind(kind)
    .bind(token_hash(&token))
    .bind(password_hash)
    .bind(now_rfc3339())
    .execute(pool)
    .await?;
    Ok(token)
}

struct ShareRecord {
    id: String,
    thread_id: String,
    share_kind: String,
    password_hash: Option<String>,
    revoked_at: Option<String>,
}

async fn load_share_by_token(pool: &PgPool, token: &str) -> anyhow::Result<Option<ShareRecord>> {
    let row = sqlx::query(
        r#"SELECT id, thread_id, share_kind, password_hash, revoked_at
             FROM vault_shares WHERE token_hash = $1"#,
    )
    .bind(token_hash(token))
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|row| ShareRecord {
        id: row.get("id"),
        thread_id: row.get("thread_id"),
        share_kind: row.get("share_kind"),
        password_hash: row.get("password_hash"),
        revoked_at: row.get("revoked_at"),
    }))
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    base64::encode_config(bytes, base64::URL_SAFE_NO_PAD)
}

fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut rand::thread_rng());
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|hash| hash.to_string())
        .map_err(|e| anyhow::anyhow!("argon2 hash failed: {e}"))
}

fn verify_password(hash: &str, password: &str) -> bool {
    let Ok(parsed_hash) = PasswordHash::new(hash) else {
        return false;
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

fn signed_share_cookie(share_id: &str, secret: &str) -> String {
    let value = format!(
        "{}:{}",
        share_id,
        chrono::Utc::now().timestamp() + 60 * 60 * 24 * 30
    );
    format!("{}.{}", value, sign(&value, secret))
}

fn has_share_cookie(headers: &HeaderMap, share_id: &str, secret: &str) -> bool {
    let Some(cookie_header) = headers.get(header::COOKIE).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let cookie_name = format!("ptv_share_{}=", share_id);
    for part in cookie_header.split(';').map(str::trim) {
        if let Some(value) = part.strip_prefix(&cookie_name) {
            let Some((signed_value, signature)) = value.rsplit_once('.') else {
                return false;
            };
            let Some((cookie_share_id, expires_at)) = signed_value.split_once(':') else {
                return false;
            };
            let Ok(expires_at) = expires_at.parse::<i64>() else {
                return false;
            };
            return cookie_share_id == share_id
                && expires_at > chrono::Utc::now().timestamp()
                && verify_signature(signed_value, signature, secret);
        }
    }
    false
}
