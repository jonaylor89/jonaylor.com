use askama::Template;
use axum::http::StatusCode;
use axum::response::{Html, IntoResponse, Response};

use crate::vault::search::SearchResult;

pub struct HtmlTemplate<T>(pub T);

impl<T> IntoResponse for HtmlTemplate<T>
where
    T: Template,
{
    fn into_response(self) -> Response {
        match self.0.render() {
            Ok(html) => Html(html).into_response(),
            Err(error) => {
                tracing::error!(?error, "failed to render template");
                (StatusCode::INTERNAL_SERVER_ERROR, "template error").into_response()
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct ThreadSummary {
    pub id: String,
    pub title: Option<String>,
    pub repo_remote: Option<String>,
    pub repo_branch: Option<String>,
    pub repo_head: Option<String>,
    pub default_visibility: String,
    pub updated_at: String,
    pub updated_at_display: String,
    pub event_count: i64,
}

#[derive(Debug, Clone)]
pub struct ThreadDetail {
    pub id: String,
    pub external_session_id: String,
    pub title: Option<String>,
    pub cwd: Option<String>,
    pub repo_remote: Option<String>,
    pub repo_branch: Option<String>,
    pub repo_head: Option<String>,
    pub default_visibility: String,
    pub created_at: String,
    pub created_at_display: String,
    pub updated_at: String,
    pub updated_at_display: String,
}

#[derive(Debug, Clone)]
pub struct EventDetail {
    pub id: String,
    pub external_event_id: Option<String>,
    pub parent_external_event_id: Option<String>,
    pub role: String,
    pub kind: String,
    pub content: Option<String>,
    pub display_content: Option<String>,
    pub tool_label: Option<String>,
    pub metadata_json: String,
    pub created_at: Option<String>,
    pub inserted_at: String,
    pub timestamp_display: String,
    pub tool_result_content: Option<String>,
    pub tool_result_metadata_json: Option<String>,
    pub tool_result_is_error: bool,
}

#[derive(Debug, Clone)]
pub struct EventView {
    pub event: EventDetail,
    pub is_thought_group: bool,
    pub thought_duration: Option<String>,
    pub thought_summary: Option<String>,
    pub children: Vec<EventDetail>,
}

#[derive(Debug, Clone)]
pub struct ToolSummary {
    pub name: String,
    pub count: usize,
}

#[derive(Debug, Clone)]
pub struct ShareDetail {
    pub id: String,
    pub share_kind: String,
    pub url: Option<String>,
    pub revoked_at: Option<String>,
    pub revoked_at_display: Option<String>,
    pub created_at: String,
    pub created_at_display: String,
}

#[derive(Debug, Clone)]
pub struct HandoffDetail {
    pub id: String,
    pub source_thread_id: String,
    pub target_thread_id: Option<String>,
    pub target_external_session_id: Option<String>,
    pub goal: String,
    pub created_at: String,
    pub created_at_display: String,
}

#[derive(Template)]
#[template(path = "web/vault/index.html")]
pub struct IndexTemplate {
    pub threads: Vec<ThreadSummary>,
}

#[derive(Template)]
#[template(path = "web/vault/thread.html")]
pub struct ThreadTemplate {
    pub thread: ThreadDetail,
    pub page_url: String,
    pub events: Vec<EventView>,
    pub total_events: usize,
    pub system_prompt: Option<String>,
    pub available_tools: Vec<ToolSummary>,
    pub shares: Vec<ShareDetail>,
    pub handoffs: Vec<HandoffDetail>,
    pub base_url: String,
    pub can_share_publicly: bool,
}

#[derive(Template)]
#[template(path = "web/vault/tree.html")]
pub struct TreeTemplate {
    pub thread: ThreadDetail,
    pub events: Vec<EventDetail>,
}

#[derive(Template)]
#[template(path = "web/vault/search.html")]
pub struct SearchTemplate {
    pub query: String,
    pub thread_id: Option<String>,
    pub results: Vec<SearchResult>,
}

#[derive(Template)]
#[template(path = "web/vault/share_password.html")]
pub struct SharePasswordTemplate {
    pub share_token: String,
    pub error: Option<String>,
}

#[derive(Template)]
#[template(path = "web/vault/admin.html")]
pub struct AdminTemplate {
    pub clients: Vec<ClientDetail>,
    pub shares: Vec<AdminShareDetail>,
    pub public_sharing: bool,
}

#[derive(Debug, Clone)]
pub struct ClientDetail {
    pub id: String,
    pub name: String,
    pub token_prefix: Option<String>,
    pub created_at: String,
    pub created_at_display: String,
    pub last_seen_at: Option<String>,
    pub last_seen_at_display: Option<String>,
    pub revoked_at: Option<String>,
    pub revoked_at_display: Option<String>,
}

#[derive(Template)]
#[template(path = "web/vault/key_created.html")]
pub struct KeyCreatedTemplate {
    pub client_id: String,
    pub name: String,
    pub plaintext_token: String,
    pub token_prefix: String,
}

#[derive(Debug, Clone)]
pub struct AdminShareDetail {
    pub id: String,
    pub thread_id: String,
    pub share_kind: String,
    pub revoked_at: Option<String>,
    pub revoked_at_display: Option<String>,
    pub created_at: String,
    pub created_at_display: String,
}
