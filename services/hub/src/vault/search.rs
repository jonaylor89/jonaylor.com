use serde::Serialize;
use sqlx::{PgPool, Row};

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub thread_id: String,
    pub thread_title: Option<String>,
    pub role: String,
    pub kind: String,
    pub content: Option<String>,
    pub created_at: Option<String>,
}

/// Full-text search across vault thread events using Postgres `tsvector`.
/// Empty queries return an empty result set rather than every row.
pub async fn search_events(
    pool: &PgPool,
    query: &str,
    thread_id: Option<&str>,
) -> Result<Vec<SearchResult>, sqlx::Error> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    match search_tsvector(pool, query, thread_id).await {
        Ok(results) => Ok(results),
        Err(error) => {
            tracing::warn!(?error, "tsvector search failed; falling back to ILIKE");
            search_ilike(pool, query, thread_id).await
        }
    }
}

async fn search_tsvector(
    pool: &PgPool,
    query: &str,
    thread_id: Option<&str>,
) -> Result<Vec<SearchResult>, sqlx::Error> {
    let rows = if let Some(thread_id) = thread_id {
        sqlx::query(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at,
                      ts_rank(te.content_tsv, websearch_to_tsquery('english', $1)) AS rank
                 FROM vault_thread_events te
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE te.content_tsv @@ websearch_to_tsquery('english', $1)
                  AND te.thread_id = $2
                ORDER BY rank DESC LIMIT 100"#,
        )
        .bind(query)
        .bind(thread_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at,
                      ts_rank(te.content_tsv, websearch_to_tsquery('english', $1)) AS rank
                 FROM vault_thread_events te
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE te.content_tsv @@ websearch_to_tsquery('english', $1)
                ORDER BY rank DESC LIMIT 100"#,
        )
        .bind(query)
        .fetch_all(pool)
        .await?
    };
    Ok(map_rows(rows))
}

async fn search_ilike(
    pool: &PgPool,
    query: &str,
    thread_id: Option<&str>,
) -> Result<Vec<SearchResult>, sqlx::Error> {
    let needle = format!("%{}%", query);
    let rows = if let Some(thread_id) = thread_id {
        sqlx::query(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at
                 FROM vault_thread_events te
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE te.content ILIKE $1 AND te.thread_id = $2
                ORDER BY COALESCE(te.created_at, te.inserted_at) DESC LIMIT 100"#,
        )
        .bind(needle)
        .bind(thread_id)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at
                 FROM vault_thread_events te
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE te.content ILIKE $1
                ORDER BY COALESCE(te.created_at, te.inserted_at) DESC LIMIT 100"#,
        )
        .bind(needle)
        .fetch_all(pool)
        .await?
    };
    Ok(map_rows(rows))
}

fn map_rows(rows: Vec<sqlx::postgres::PgRow>) -> Vec<SearchResult> {
    rows.into_iter()
        .map(|row| SearchResult {
            thread_id: row.get("thread_id"),
            thread_title: row.get("thread_title"),
            role: row.get("role"),
            kind: row.get("kind"),
            content: row.get("content"),
            created_at: row.get("created_at"),
        })
        .collect()
}
