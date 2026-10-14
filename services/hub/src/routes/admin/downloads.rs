use anyhow::Context;
use axum::extract::{Query, State};
use axum::response::Json;
use sqlx::SqlitePool;

use crate::authentication::AuthenticatedUser;
use crate::utils::e500;

#[derive(serde::Deserialize)]
pub struct ListParams {
    page: Option<i64>,
    per_page: Option<i64>,
    search: Option<String>,
    app: Option<String>,
}

#[derive(serde::Serialize)]
pub struct DownloadContactResponse {
    email: String,
    apps: Vec<String>,
    downloads: i64,
    first_downloaded_at: String,
    last_downloaded_at: String,
    subscription_status: Option<String>,
}

#[derive(serde::Serialize)]
pub struct AppDownloadStats {
    app: String,
    downloads: i64,
    contacts: i64,
}

#[derive(serde::Serialize)]
pub struct ListDownloadsResponse {
    apps: Vec<AppDownloadStats>,
    contacts: Vec<DownloadContactResponse>,
    total: i64,
    page: i64,
    per_page: i64,
    total_pages: i64,
}

/// One row per email address that has downloaded something, newest activity first.
#[tracing::instrument(name = "List download contacts", skip_all)]
pub async fn list_downloads(
    _user: AuthenticatedUser,
    State(pool): State<SqlitePool>,
    Query(params): Query<ListParams>,
) -> Result<Json<ListDownloadsResponse>, crate::utils::AppError> {
    let page = params.page.unwrap_or(1).max(1);
    let per_page = params.per_page.unwrap_or(25).clamp(1, 100);
    let offset = (page - 1) * per_page;
    let search_pattern = params.search.as_deref().map(|s| format!("%{s}%"));

    let apps = sqlx::query!(
        r#"
        SELECT app, COUNT(*) as "downloads!: i64", COUNT(DISTINCT email) as "contacts!: i64"
        FROM downloads
        GROUP BY app
        ORDER BY 2 DESC
        "#
    )
    .fetch_all(&pool)
    .await
    .context("Failed to aggregate downloads by app")
    .map_err(e500)?
    .into_iter()
    .map(|r| AppDownloadStats {
        app: r.app,
        downloads: r.downloads,
        contacts: r.contacts,
    })
    .collect();

    let total = sqlx::query_scalar!(
        r#"
        SELECT COUNT(DISTINCT email) as "count!: i64"
        FROM downloads
        WHERE (? IS NULL OR app = ?)
          AND (? IS NULL OR email LIKE ?)
        "#,
        params.app,
        params.app,
        search_pattern,
        search_pattern,
    )
    .fetch_one(&pool)
    .await
    .context("Failed to count download contacts")
    .map_err(e500)?;

    let rows = sqlx::query!(
        r#"
        SELECT
            d.email as "email!",
            GROUP_CONCAT(DISTINCT d.app) as "apps!: String",
            COUNT(*) as "downloads!: i64",
            MIN(d.downloaded_at) as "first_downloaded_at!: String",
            MAX(d.downloaded_at) as "last_downloaded_at!: String",
            s.status as "subscription_status?: String"
        FROM downloads d
        LEFT JOIN subscriptions s ON s.email = d.email
        WHERE (? IS NULL OR d.app = ?)
          AND (? IS NULL OR d.email LIKE ?)
        GROUP BY d.email
        ORDER BY MAX(d.downloaded_at) DESC
        LIMIT ? OFFSET ?
        "#,
        params.app,
        params.app,
        search_pattern,
        search_pattern,
        per_page,
        offset,
    )
    .fetch_all(&pool)
    .await
    .context("Failed to fetch download contacts")
    .map_err(e500)?;

    let contacts = rows
        .into_iter()
        .map(|r| DownloadContactResponse {
            email: r.email,
            apps: r.apps.split(',').map(str::to_string).collect(),
            downloads: r.downloads,
            first_downloaded_at: r.first_downloaded_at,
            last_downloaded_at: r.last_downloaded_at,
            subscription_status: r.subscription_status,
        })
        .collect();

    let total_pages = (total + per_page - 1) / per_page;

    Ok(Json(ListDownloadsResponse {
        apps,
        contacts,
        total,
        page,
        per_page,
        total_pages,
    }))
}
