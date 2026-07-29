use serde::Serialize;
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize)]
pub struct SearchResult {
    pub thread_id: String,
    pub thread_title: Option<String>,
    pub role: String,
    pub kind: String,
    pub content: Option<String>,
    pub created_at: Option<String>,
}

/// Full-text search across vault thread events using SQLite FTS5.
/// Empty queries return an empty result set rather than every row.
pub async fn search_events(
    pool: &SqlitePool,
    query: &str,
    thread_id: Option<&str>,
) -> Result<Vec<SearchResult>, sqlx::Error> {
    if query.trim().is_empty() {
        return Ok(vec![]);
    }

    match search_fts(pool, query, thread_id).await {
        Ok(results) => Ok(results),
        Err(error) => {
            tracing::warn!(?error, "FTS5 search failed; falling back to LIKE");
            search_like(pool, query, thread_id).await
        }
    }
}

async fn search_fts(
    pool: &SqlitePool,
    query: &str,
    thread_id: Option<&str>,
) -> Result<Vec<SearchResult>, sqlx::Error> {
    if let Some(thread_id) = thread_id {
        let rows = sqlx::query!(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at
                 FROM vault_thread_events_fts fts
                 JOIN vault_thread_events te ON te.id = fts.rowid
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE fts.content MATCH ?
                  AND te.thread_id = ?
                ORDER BY fts.rank LIMIT 100"#,
            query,
            thread_id,
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SearchResult {
                thread_id: row.thread_id,
                thread_title: row.thread_title,
                role: row.role,
                kind: row.kind,
                content: row.content,
                created_at: row.created_at,
            })
            .collect())
    } else {
        let rows = sqlx::query!(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at
                 FROM vault_thread_events_fts fts
                 JOIN vault_thread_events te ON te.id = fts.rowid
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE fts.content MATCH ?
                ORDER BY fts.rank LIMIT 100"#,
            query,
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SearchResult {
                thread_id: row.thread_id,
                thread_title: row.thread_title,
                role: row.role,
                kind: row.kind,
                content: row.content,
                created_at: row.created_at,
            })
            .collect())
    }
}

async fn search_like(
    pool: &SqlitePool,
    query: &str,
    thread_id: Option<&str>,
) -> Result<Vec<SearchResult>, sqlx::Error> {
    let needle = format!("%{}%", query);
    if let Some(thread_id) = thread_id {
        let rows = sqlx::query!(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at
                 FROM vault_thread_events te
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE te.content LIKE ? AND te.thread_id = ?
                ORDER BY COALESCE(te.created_at, te.inserted_at) DESC LIMIT 100"#,
            needle,
            thread_id,
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SearchResult {
                thread_id: row.thread_id,
                thread_title: row.thread_title,
                role: row.role,
                kind: row.kind,
                content: row.content,
                created_at: row.created_at,
            })
            .collect())
    } else {
        let rows = sqlx::query!(
            r#"SELECT te.thread_id, t.title AS thread_title, te.role, te.kind, te.content, te.created_at
                 FROM vault_thread_events te
                 JOIN vault_threads t ON t.id = te.thread_id
                WHERE te.content LIKE ?
                ORDER BY COALESCE(te.created_at, te.inserted_at) DESC LIMIT 100"#,
            needle,
        )
        .fetch_all(pool)
        .await?;
        Ok(rows
            .into_iter()
            .map(|row| SearchResult {
                thread_id: row.thread_id,
                thread_title: row.thread_title,
                role: row.role,
                kind: row.kind,
                content: row.content,
                created_at: row.created_at,
            })
            .collect())
    }
}
