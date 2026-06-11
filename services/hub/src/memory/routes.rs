use axum::Json;
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use uuid::Uuid;

use crate::startup::AppState;
use crate::vault::auth::require_api_token;

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
pub struct AddMemoryRequest {
    pub user_id: String,
    pub text: String,
}

#[derive(serde::Deserialize)]
pub struct SearchMemoryRequest {
    pub user_id: String,
    pub query: String,
}

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

const MAX_USER_ID_LEN: usize = 256;
const MAX_TEXT_LEN: usize = 102_400; // 100 KB
const MAX_QUERY_LEN: usize = 10_240; // 10 KB

fn validate_user_id(user_id: &str) -> Result<(), &'static str> {
    if user_id.is_empty() {
        return Err("user_id must not be empty");
    }
    if user_id.len() > MAX_USER_ID_LEN {
        return Err("user_id must not exceed 256 characters");
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/// POST /api/memory — queue asynchronous fact extraction from raw text.
#[tracing::instrument(name = "API: Add memory", skip_all, fields(user_id = %body.user_id))]
pub async fn add_memory_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<AddMemoryRequest>,
) -> Response {
    if require_api_token(&headers, &state.db_pool).await.is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid or missing bearer token"})),
        )
            .into_response();
    }

    if !state.memory.is_enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Memory engine is not enabled"})),
        )
            .into_response();
    }

    if let Err(msg) = validate_user_id(&body.user_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        )
            .into_response();
    }
    if body.text.is_empty() || body.text.len() > MAX_TEXT_LEN {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "text must be between 1 and 100KB"})),
        )
            .into_response();
    }

    let job_id = Uuid::new_v4();
    let result = sqlx::query(
        "INSERT INTO memory_extraction_queue (id, user_id, raw_text) VALUES ($1, $2, $3)",
    )
    .bind(job_id)
    .bind(&body.user_id)
    .bind(&body.text)
    .execute(&state.db_pool)
    .await;

    match result {
        Ok(_) => (
            StatusCode::ACCEPTED,
            Json(serde_json::json!({
                "status": "accepted",
                "job_id": job_id,
                "message": "Memory extraction queued"
            })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to enqueue memory extraction");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to enqueue extraction"})),
            )
                .into_response()
        }
    }
}

/// POST /api/memory/search — semantic vector search over a user's memories.
#[tracing::instrument(name = "API: Search memories", skip_all, fields(user_id = %body.user_id))]
pub async fn search_memory_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    Json(body): Json<SearchMemoryRequest>,
) -> Response {
    if require_api_token(&headers, &state.db_pool).await.is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid or missing bearer token"})),
        )
            .into_response();
    }

    if !state.memory.is_enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Memory engine is not enabled"})),
        )
            .into_response();
    }

    if let Err(msg) = validate_user_id(&body.user_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        )
            .into_response();
    }
    if body.query.is_empty() || body.query.len() > MAX_QUERY_LEN {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "query must be between 1 and 10KB"})),
        )
            .into_response();
    }

    match state.memory.get_context(&body.user_id, &body.query).await {
        Ok(matches) => (
            StatusCode::OK,
            Json(serde_json::json!({ "memories": matches })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Memory search failed");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Memory search failed"})),
            )
                .into_response()
        }
    }
}

/// GET /api/memory/:user_id — list all active memories for a user.
#[tracing::instrument(name = "API: List memories", skip_all, fields(user_id = %user_id))]
pub async fn list_memories_handler(
    headers: HeaderMap,
    State(state): State<AppState>,
    Path(user_id): Path<String>,
) -> Response {
    if require_api_token(&headers, &state.db_pool).await.is_err() {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid or missing bearer token"})),
        )
            .into_response();
    }

    if !state.memory.is_enabled() {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(serde_json::json!({"error": "Memory engine is not enabled"})),
        )
            .into_response();
    }

    if let Err(msg) = validate_user_id(&user_id) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": msg})),
        )
            .into_response();
    }

    match state.memory.list_memories(&user_id).await {
        Ok(memories) => (
            StatusCode::OK,
            Json(serde_json::json!({ "memories": memories })),
        )
            .into_response(),
        Err(e) => {
            tracing::error!(error.cause_chain = ?e, "Failed to list memories");
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Failed to list memories"})),
            )
                .into_response()
        }
    }
}
