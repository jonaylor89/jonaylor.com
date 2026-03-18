use anyhow::Context;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::authentication::AuthenticatedUser;
use crate::utils::e500;

#[derive(serde::Deserialize)]
pub struct ListParams {
    page: Option<i64>,
    per_page: Option<i64>,
    search: Option<String>,
    status: Option<String>,
}

#[derive(serde::Serialize)]
pub struct SubscriberResponse {
    id: Uuid,
    email: String,
    name: Option<String>,
    status: String,
    subscribed_at: String,
}

#[derive(serde::Serialize)]
pub struct ListSubscribersResponse {
    subscribers: Vec<SubscriberResponse>,
    total: i64,
    page: i64,
    per_page: i64,
    total_pages: i64,
}

#[tracing::instrument(name = "List subscribers", skip_all)]
pub async fn list_subscribers(
    _user: AuthenticatedUser,
    State(pool): State<PgPool>,
    Query(params): Query<ListParams>,
) -> Result<Json<ListSubscribersResponse>, crate::utils::AppError> {
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(25).clamp(1, 100);
    let offset = (page - 1) * per_page;
    let search_pattern = params.search.as_deref().map(|s| format!("%{s}%"));

    let total = sqlx::query_scalar!(
        r#"
        SELECT COUNT(*) as "count!"
        FROM subscriptions
        WHERE ($1::TEXT IS NULL OR status = $1)
          AND ($2::TEXT IS NULL OR email ILIKE $2 OR name ILIKE $2)
        "#,
        params.status,
        search_pattern,
    )
    .fetch_one(&pool)
    .await
    .context("Failed to count subscribers")
    .map_err(e500)?;

    let rows = sqlx::query!(
        r#"
        SELECT id, email, name, status as "status!", subscribed_at
        FROM subscriptions
        WHERE ($1::TEXT IS NULL OR status = $1)
          AND ($2::TEXT IS NULL OR email ILIKE $2 OR name ILIKE $2)
        ORDER BY subscribed_at DESC
        LIMIT $3 OFFSET $4
        "#,
        params.status,
        search_pattern,
        per_page,
        offset,
    )
    .fetch_all(&pool)
    .await
    .context("Failed to fetch subscribers")
    .map_err(e500)?;

    let subscribers = rows
        .into_iter()
        .map(|r| SubscriberResponse {
            id: r.id,
            email: r.email,
            name: r.name,
            status: r.status,
            subscribed_at: r.subscribed_at.to_rfc3339(),
        })
        .collect();

    let total_pages = (total + per_page - 1) / per_page;

    Ok(Json(ListSubscribersResponse {
        subscribers,
        total,
        page,
        per_page,
        total_pages,
    }))
}

#[tracing::instrument(name = "Delete subscriber", skip(pool))]
pub async fn delete_subscriber(
    _user: AuthenticatedUser,
    State(pool): State<PgPool>,
    Path(subscriber_id): Path<Uuid>,
) -> Result<impl IntoResponse, crate::utils::AppError> {
    // Delete associated tokens first
    sqlx::query!(
        "DELETE FROM subscription_tokens WHERE subscriber_id = $1",
        subscriber_id,
    )
    .execute(&pool)
    .await
    .context("Failed to delete subscription tokens")
    .map_err(e500)?;

    let result = sqlx::query!("DELETE FROM subscriptions WHERE id = $1", subscriber_id,)
        .execute(&pool)
        .await
        .context("Failed to delete subscriber")
        .map_err(e500)?;

    if result.rows_affected() == 0 {
        return Err(crate::utils::AppError::new(
            anyhow::anyhow!("Subscriber not found"),
            StatusCode::NOT_FOUND,
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}
