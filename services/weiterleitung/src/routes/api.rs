use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use chrono::{DateTime, Utc};

use crate::alias::{self, Alias, AliasUpdate, AliasWithMailbox};
use crate::contact::{self, Contact};
use crate::delivery::{self, QueuedMessage};
use crate::domain::EmailAddress;
use crate::mailbox::{self, Mailbox};
use crate::startup::AppState;

const RECENT_MESSAGE_LIMIT: i64 = 50;

/// The machine-facing JSON API. Bearer-token auth is layered on by the caller.
pub fn api_routes() -> Router<AppState> {
    Router::new()
        .route("/mailboxes", get(list_mailboxes).post(create_mailbox))
        .route("/mailboxes/{mailbox_id}", delete(delete_mailbox))
        .route("/aliases", get(list_aliases).post(create_alias))
        .route(
            "/aliases/{alias_id}",
            get(get_alias).patch(update_alias).delete(delete_alias),
        )
        .route("/messages", get(list_messages))
}

#[derive(serde::Serialize)]
struct MailboxBody {
    mailbox_id: String,
    email: String,
    is_default: bool,
    created_at: String,
}

impl From<Mailbox> for MailboxBody {
    fn from(mailbox: Mailbox) -> Self {
        Self {
            mailbox_id: mailbox.mailbox_id,
            email: mailbox.email,
            is_default: mailbox.is_default,
            created_at: mailbox.created_at.to_rfc3339(),
        }
    }
}

#[derive(serde::Serialize)]
struct AliasBody {
    alias_id: String,
    address: String,
    mailbox_id: String,
    mailbox_email: String,
    note: Option<String>,
    enabled: bool,
    forward_count: i64,
    reply_count: i64,
    blocked_count: i64,
    expires_at: Option<String>,
    webhook_url: Option<String>,
    created_at: String,
    last_used_at: Option<String>,
}

impl AliasBody {
    fn new(alias: Alias, mailbox_email: String) -> Self {
        Self {
            alias_id: alias.alias_id,
            address: alias.address,
            mailbox_id: alias.mailbox_id,
            mailbox_email,
            note: alias.note,
            enabled: alias.enabled,
            forward_count: alias.forward_count,
            reply_count: alias.reply_count,
            blocked_count: alias.blocked_count,
            expires_at: alias.expires_at.map(|t| t.to_rfc3339()),
            webhook_url: alias.webhook_url,
            created_at: alias.created_at.to_rfc3339(),
            last_used_at: alias.last_used_at.map(|t| t.to_rfc3339()),
        }
    }
}

impl From<AliasWithMailbox> for AliasBody {
    fn from(row: AliasWithMailbox) -> Self {
        Self::new(row.alias, row.mailbox_email)
    }
}

#[derive(serde::Serialize)]
struct ContactBody {
    contact_id: String,
    email: String,
    name: Option<String>,
    reverse_alias: String,
    created_at: String,
}

impl From<Contact> for ContactBody {
    fn from(contact: Contact) -> Self {
        Self {
            contact_id: contact.contact_id,
            email: contact.email,
            name: contact.name,
            reverse_alias: contact.reverse_alias,
            created_at: contact.created_at.to_rfc3339(),
        }
    }
}

#[derive(serde::Serialize)]
struct AliasDetailBody {
    #[serde(flatten)]
    alias: AliasBody,
    contacts: Vec<ContactBody>,
}

#[derive(serde::Serialize)]
struct MessageBody {
    message_id: String,
    direction: String,
    envelope_from: String,
    envelope_to: String,
    subject: Option<String>,
    status: String,
    attempts: i64,
    last_error: Option<String>,
    created_at: String,
}

impl From<QueuedMessage> for MessageBody {
    fn from(message: QueuedMessage) -> Self {
        Self {
            message_id: message.message_id,
            direction: message.direction,
            envelope_from: message.envelope_from,
            envelope_to: message.envelope_to,
            subject: message.subject,
            status: message.status,
            attempts: message.attempts,
            last_error: message.last_error,
            created_at: message.created_at.to_rfc3339(),
        }
    }
}

#[tracing::instrument(name = "List mailboxes", skip(state))]
async fn list_mailboxes(State(state): State<AppState>) -> Response {
    match mailbox::list_mailboxes(&state.db_pool).await {
        Ok(mailboxes) => Json(
            mailboxes
                .into_iter()
                .map(MailboxBody::from)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => internal_error(e, "Failed to list the mailboxes"),
    }
}

#[derive(serde::Deserialize)]
struct CreateMailboxBody {
    email: String,
    #[serde(default)]
    is_default: bool,
}

#[tracing::instrument(name = "Create mailbox", skip(state, body))]
async fn create_mailbox(
    State(state): State<AppState>,
    Json(body): Json<CreateMailboxBody>,
) -> Response {
    let email = match EmailAddress::parse(&body.email) {
        Ok(email) => email,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };

    match mailbox::insert_mailbox(&state.db_pool, &email, body.is_default).await {
        Ok(mailbox) => (StatusCode::CREATED, Json(MailboxBody::from(mailbox))).into_response(),
        Err(e) => internal_error(e, "Failed to add the mailbox"),
    }
}

#[tracing::instrument(name = "Delete mailbox", skip(state))]
async fn delete_mailbox(State(state): State<AppState>, Path(mailbox_id): Path<String>) -> Response {
    match mailbox::delete_mailbox(&state.db_pool, &mailbox_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal_error(e, "Failed to delete the mailbox"),
    }
}

#[tracing::instrument(name = "List aliases", skip(state))]
async fn list_aliases(State(state): State<AppState>) -> Response {
    match alias::list_aliases(&state.db_pool).await {
        Ok(aliases) => {
            Json(aliases.into_iter().map(AliasBody::from).collect::<Vec<_>>()).into_response()
        }
        Err(e) => internal_error(e, "Failed to list the aliases"),
    }
}

#[derive(serde::Deserialize)]
struct CreateAliasBody {
    local_part: Option<String>,
    mailbox_id: String,
    note: Option<String>,
    expires_at: Option<String>,
    webhook_url: Option<String>,
}

#[tracing::instrument(name = "Create alias", skip(state, body))]
async fn create_alias(
    State(state): State<AppState>,
    Json(body): Json<CreateAliasBody>,
) -> Response {
    let local_part = match body.local_part {
        Some(local_part) if !local_part.trim().is_empty() => local_part.trim().to_string(),
        _ => alias::random_local_part(),
    };
    let address = format!("{local_part}@{}", state.aliases.default_domain());
    let address = match EmailAddress::parse(&address) {
        Ok(address) => address,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };

    let expires_at = match body.expires_at.as_deref().map(parse_rfc3339).transpose() {
        Ok(expires_at) => expires_at,
        Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
    };

    let mailbox = match mailbox::get_mailbox(&state.db_pool, &body.mailbox_id).await {
        Ok(Some(mailbox)) => mailbox,
        Ok(None) => return api_error(StatusCode::NOT_FOUND, "No such mailbox"),
        Err(e) => return internal_error(e, "Failed to look up the mailbox"),
    };

    match alias::find_alias_by_address(&state.db_pool, &address).await {
        Ok(Some(_)) => {
            return api_error(StatusCode::CONFLICT, format!("{address} already exists"));
        }
        Ok(None) => {}
        Err(e) => return internal_error(e, "Failed to check for an existing alias"),
    }

    let note = body
        .note
        .map(|note| note.trim().to_string())
        .filter(|note| !note.is_empty());
    match alias::insert_alias(
        &state.db_pool,
        &address,
        &mailbox.mailbox_id,
        note,
        expires_at,
        body.webhook_url,
    )
    .await
    {
        Ok(alias) => (
            StatusCode::CREATED,
            Json(AliasBody::new(alias, mailbox.email)),
        )
            .into_response(),
        Err(e) => internal_error(e, "Failed to create the alias"),
    }
}

#[tracing::instrument(name = "Get alias", skip(state))]
async fn get_alias(State(state): State<AppState>, Path(alias_id): Path<String>) -> Response {
    let alias = match alias::get_alias(&state.db_pool, &alias_id).await {
        Ok(Some(alias)) => alias,
        Ok(None) => return api_error(StatusCode::NOT_FOUND, "No such alias"),
        Err(e) => return internal_error(e, "Failed to look up the alias"),
    };
    let contacts = match contact::list_contacts_for_alias(&state.db_pool, &alias_id).await {
        Ok(contacts) => contacts,
        Err(e) => return internal_error(e, "Failed to list the contacts"),
    };

    Json(AliasDetailBody {
        alias: AliasBody::from(alias),
        contacts: contacts.into_iter().map(ContactBody::from).collect(),
    })
    .into_response()
}

/// Deserializes a "nullable" JSON field as `Option<Option<T>>` while keeping
/// the three cases apart: absent -> `None`, explicit `null` -> `Some(None)`,
/// a value -> `Some(Some(v))`.
fn nullable<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::Deserialize<'de>,
{
    <Option<T> as serde::Deserialize>::deserialize(deserializer).map(Some)
}

#[derive(serde::Deserialize)]
struct UpdateAliasBody {
    /// `None` leaves the flag alone.
    #[serde(default)]
    enabled: Option<bool>,
    /// `None` leaves the column alone, `Some(None)` clears it, `Some(Some(v))`
    /// sets it.
    #[serde(default, deserialize_with = "nullable")]
    note: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    webhook_url: Option<Option<String>>,
    #[serde(default, deserialize_with = "nullable")]
    expires_at: Option<Option<String>>,
}

#[tracing::instrument(name = "Update alias", skip(state, body))]
async fn update_alias(
    State(state): State<AppState>,
    Path(alias_id): Path<String>,
    Json(body): Json<UpdateAliasBody>,
) -> Response {
    match alias::get_alias(&state.db_pool, &alias_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return api_error(StatusCode::NOT_FOUND, "No such alias"),
        Err(e) => return internal_error(e, "Failed to look up the alias"),
    }

    let mut update = AliasUpdate {
        enabled: body.enabled,
        ..AliasUpdate::default()
    };
    match body.note {
        None => {}
        Some(None) => update.clear_note = true,
        Some(Some(note)) => update.note = Some(note),
    }
    match body.webhook_url {
        None => {}
        Some(None) => update.clear_webhook_url = true,
        Some(Some(webhook_url)) => update.webhook_url = Some(webhook_url),
    }
    match body.expires_at {
        None => {}
        Some(None) => update.clear_expires_at = true,
        Some(Some(raw)) => match parse_rfc3339(&raw) {
            Ok(expires_at) => update.expires_at = Some(expires_at),
            Err(e) => return api_error(StatusCode::BAD_REQUEST, e),
        },
    }

    if let Err(e) = alias::update_alias(&state.db_pool, &alias_id, update).await {
        return internal_error(e, "Failed to update the alias");
    }
    match alias::get_alias(&state.db_pool, &alias_id).await {
        Ok(Some(alias)) => Json(AliasBody::from(alias)).into_response(),
        Ok(None) => api_error(StatusCode::NOT_FOUND, "No such alias"),
        Err(e) => internal_error(e, "Failed to look up the alias"),
    }
}

#[tracing::instrument(name = "Delete alias", skip(state))]
async fn delete_alias(State(state): State<AppState>, Path(alias_id): Path<String>) -> Response {
    match alias::delete_alias(&state.db_pool, &alias_id).await {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => internal_error(e, "Failed to delete the alias"),
    }
}

#[tracing::instrument(name = "List recent messages", skip(state))]
async fn list_messages(State(state): State<AppState>) -> Response {
    match delivery::list_recent(&state.db_pool, RECENT_MESSAGE_LIMIT).await {
        Ok(messages) => Json(
            messages
                .into_iter()
                .map(MessageBody::from)
                .collect::<Vec<_>>(),
        )
        .into_response(),
        Err(e) => internal_error(e, "Failed to list the recent messages"),
    }
}

fn parse_rfc3339(raw: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(raw)
        .map(|value| value.with_timezone(&Utc))
        .map_err(|_| format!("`{raw}` is not a valid RFC 3339 timestamp"))
}

fn api_error(status: StatusCode, message: impl Into<String>) -> Response {
    let message = message.into();
    (status, Json(serde_json::json!({"error": message}))).into_response()
}

fn internal_error(error: anyhow::Error, context: &str) -> Response {
    tracing::error!(error.cause_chain = ?error, error.message = %error, "{context}");
    api_error(StatusCode::INTERNAL_SERVER_ERROR, context)
}
