use chrono::{DateTime, Utc};
use pgvector::Vector;
use secrecy::{ExposeSecret, Secret};
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::configuration::MemorySettings;
use crate::domain::{MemoryConflictAction, MemoryFact};

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Core memory engine that handles LLM-based fact extraction, embedding,
/// vector storage, and semantic retrieval.
///
/// NOTE: Database queries use `sqlx::query()` (runtime-checked) instead of
/// `sqlx::query!()` (compile-time-checked) because the `pgvector::Vector`
/// type is not representable in sqlx's offline metadata cache (`.sqlx/`).
/// Once pgvector is installed on the dev database, `cargo sqlx prepare`
/// can be re-run to upgrade these to compile-time-checked queries.
#[derive(Clone)]
pub struct MemoryEngine {
    pool: PgPool,
    http: reqwest::Client,
    api_base_url: String,
    api_key: Secret<String>,
    embedding_model: String,
    extraction_model: String,
    similarity_threshold: f64,
    search_limit: i64,
    enabled: bool,
}

#[derive(Debug, serde::Serialize)]
pub struct Memory {
    pub id: Uuid,
    pub user_id: String,
    pub fact: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, serde::Serialize)]
pub struct MemoryMatch {
    pub id: Uuid,
    pub fact: String,
    pub similarity: f64,
    pub created_at: DateTime<Utc>,
}

// ---------------------------------------------------------------------------
// LLM API response types
// ---------------------------------------------------------------------------

#[derive(serde::Deserialize)]
struct ChatResponse {
    choices: Vec<ChatChoice>,
}

#[derive(serde::Deserialize)]
struct ChatChoice {
    message: ChatChoiceMessage,
}

#[derive(serde::Deserialize)]
struct ChatChoiceMessage {
    content: String,
}

#[derive(serde::Deserialize)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(serde::Deserialize)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

#[derive(serde::Deserialize)]
struct ConflictResolution {
    action: String,
    #[serde(default)]
    merged_fact: Option<String>,
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// MemoryEngine implementation
// ---------------------------------------------------------------------------

impl MemoryEngine {
    pub fn new(pool: PgPool, settings: &MemorySettings) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to build HTTP client for memory engine");

        Self {
            pool,
            http,
            api_base_url: settings.api_base_url.clone(),
            api_key: settings.api_key.clone(),
            embedding_model: settings.embedding_model.clone(),
            extraction_model: settings.extraction_model.clone(),
            similarity_threshold: settings
                .similarity_threshold()
                .expect("invalid memory similarity threshold")
                .get(),
            search_limit: settings
                .search_limit()
                .expect("invalid memory search limit")
                .get(),
            enabled: settings.enabled,
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    // -- Public API ---------------------------------------------------------

    /// Extracts atomic facts from raw text and stores them as memories.
    /// Designed to be called from a spawned task (out-of-band).
    #[tracing::instrument(name = "memory::add_memory", skip(self, raw_text))]
    pub async fn add_memory(
        &self,
        user_id: &str,
        raw_text: &str,
    ) -> Result<Vec<Uuid>, anyhow::Error> {
        let facts = self.extract_facts(raw_text).await?;
        let mut ids = Vec::with_capacity(facts.len());

        for fact in &facts {
            let embedding = self.embed(fact.as_ref()).await?;
            let vector = Vector::from(embedding);
            if let Some(id) = self.upsert_memory(user_id, fact.as_ref(), &vector).await? {
                ids.push(id);
            }
        }

        tracing::info!(
            user_id = user_id,
            facts_extracted = facts.len(),
            memories_stored = ids.len(),
            "Memory extraction complete"
        );

        Ok(ids)
    }

    /// Performs semantic vector search to retrieve relevant context.
    #[tracing::instrument(name = "memory::get_context", skip(self, query))]
    pub async fn get_context(
        &self,
        user_id: &str,
        query: &str,
    ) -> Result<Vec<MemoryMatch>, anyhow::Error> {
        let embedding = self.embed(query).await?;
        let vector = Vector::from(embedding);

        let rows = sqlx::query(
            r#"
            SELECT id, fact, 1 - (embedding <=> $1) AS similarity, created_at
            FROM memories
            WHERE user_id = $2 AND is_active = TRUE
            ORDER BY embedding <=> $1
            LIMIT $3
            "#,
        )
        .bind(&vector)
        .bind(user_id)
        .bind(self.search_limit)
        .fetch_all(&self.pool)
        .await?;

        let matches = rows
            .into_iter()
            .map(|row| MemoryMatch {
                id: row.get("id"),
                fact: row.get("fact"),
                similarity: row.get("similarity"),
                created_at: row.get("created_at"),
            })
            .collect();

        Ok(matches)
    }

    /// Lists all active memories for a user, ordered by most recently updated.
    #[tracing::instrument(name = "memory::list_memories", skip(self))]
    pub async fn list_memories(&self, user_id: &str) -> Result<Vec<Memory>, anyhow::Error> {
        let rows = sqlx::query(
            r#"
            SELECT id, user_id, fact, created_at, updated_at
            FROM memories
            WHERE user_id = $1 AND is_active = TRUE
            ORDER BY updated_at DESC
            "#,
        )
        .bind(user_id)
        .fetch_all(&self.pool)
        .await?;

        let memories = rows
            .into_iter()
            .map(|row| Memory {
                id: row.get("id"),
                user_id: row.get("user_id"),
                fact: row.get("fact"),
                created_at: row.get("created_at"),
                updated_at: row.get("updated_at"),
            })
            .collect();

        Ok(memories)
    }

    // -- Embedding ----------------------------------------------------------

    async fn embed(&self, text: &str) -> Result<Vec<f32>, anyhow::Error> {
        let url = format!("{}/v1/embeddings", self.api_base_url);

        let body = serde_json::json!({
            "model": &self.embedding_model,
            "input": text,
        });

        let resp = self
            .http
            .post(&url)
            .header(
                "Authorization",
                format!("Bearer {}", self.api_key.expose_secret()),
            )
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<EmbeddingResponse>()
            .await?;

        resp.data
            .into_iter()
            .next()
            .map(|d| d.embedding)
            .ok_or_else(|| anyhow::anyhow!("Empty embedding response from API"))
    }

    // -- Fact extraction via LLM --------------------------------------------

    async fn extract_facts(&self, text: &str) -> Result<Vec<MemoryFact>, anyhow::Error> {
        let system_prompt = concat!(
            "You are a memory extraction assistant. Given user text, extract atomic factual ",
            "statements worth remembering for future conversations.\n\n",
            "Rules:\n",
            "- Each fact must be a single, self-contained statement\n",
            "- Focus on preferences, personal details, work context, and technical choices\n",
            "- Skip greetings, filler, procedural language, and questions\n",
            "- If no meaningful facts can be extracted, return an empty array\n\n",
            "Return ONLY a JSON array of strings, no other text. Example:\n",
            "[\"User prefers Rust over Python\", \"User works at a startup\"]"
        );

        let url = format!("{}/v1/chat/completions", self.api_base_url);

        let body = serde_json::json!({
            "model": &self.extraction_model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": text },
            ],
            "temperature": 0.0,
        });

        let resp = self
            .http
            .post(&url)
            .header(
                "Authorization",
                format!("Bearer {}", self.api_key.expose_secret()),
            )
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<ChatResponse>()
            .await?;

        let content = resp
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No choices in extraction response"))?
            .message
            .content;

        let cleaned = strip_code_block(&content);
        let facts: Vec<String> = serde_json::from_str(cleaned).map_err(|e| {
            anyhow::anyhow!(
                "Failed to parse extraction response as JSON array: {e} — raw: {cleaned}"
            )
        })?;

        facts
            .into_iter()
            .map(MemoryFact::parse)
            .collect::<Result<Vec<_>, _>>()
            .map_err(anyhow::Error::msg)
    }

    // -- Upsert with conflict resolution ------------------------------------

    async fn upsert_memory(
        &self,
        user_id: &str,
        fact: &str,
        embedding: &Vector,
    ) -> Result<Option<Uuid>, anyhow::Error> {
        // Find the closest existing memory for this user
        let existing = sqlx::query(
            r#"
            SELECT id, fact, 1 - (embedding <=> $1) AS similarity, created_at
            FROM memories
            WHERE user_id = $2 AND is_active = TRUE
            ORDER BY embedding <=> $1
            LIMIT 1
            "#,
        )
        .bind(embedding)
        .bind(user_id)
        .fetch_optional(&self.pool)
        .await?;

        if let Some(row) = existing {
            let similarity: f64 = row.get("similarity");

            if similarity > self.similarity_threshold {
                let existing_id: Uuid = row.get("id");
                let existing_fact: String = row.get("fact");

                tracing::debug!(
                    existing_fact = %existing_fact,
                    new_fact = %fact,
                    similarity = similarity,
                    "High similarity detected, resolving conflict"
                );

                let action = match self.resolve_conflict(&existing_fact, fact).await {
                    Ok(a) => a,
                    Err(e) => {
                        tracing::warn!(
                            error = %e,
                            "Conflict resolution failed, defaulting to keep_both"
                        );
                        MemoryConflictAction::KeepBoth
                    }
                };

                match action {
                    MemoryConflictAction::Update(merged) => {
                        let new_embedding = self.embed(merged.as_ref()).await?;
                        let new_vector = Vector::from(new_embedding);
                        sqlx::query(
                            "UPDATE memories SET fact = $1, embedding = $2, updated_at = NOW() \
                             WHERE id = $3",
                        )
                        .bind(merged.as_ref())
                        .bind(&new_vector)
                        .bind(existing_id)
                        .execute(&self.pool)
                        .await?;
                        return Ok(Some(existing_id));
                    }
                    MemoryConflictAction::KeepExisting => return Ok(None),
                    MemoryConflictAction::KeepBoth => { /* fall through to insert */ }
                }
            }
        }

        let id = self.insert_memory(user_id, fact, embedding).await?;
        Ok(Some(id))
    }

    async fn insert_memory(
        &self,
        user_id: &str,
        fact: &str,
        embedding: &Vector,
    ) -> Result<Uuid, anyhow::Error> {
        let id = Uuid::new_v4();
        sqlx::query("INSERT INTO memories (id, user_id, fact, embedding) VALUES ($1, $2, $3, $4)")
            .bind(id)
            .bind(user_id)
            .bind(fact)
            .bind(embedding)
            .execute(&self.pool)
            .await?;
        Ok(id)
    }

    // -- Conflict resolution via LLM ----------------------------------------

    async fn resolve_conflict(
        &self,
        existing_fact: &str,
        new_fact: &str,
    ) -> Result<MemoryConflictAction, anyhow::Error> {
        let system_prompt = concat!(
            "You are resolving a memory conflict. Given an existing stored fact and a new fact, ",
            "determine the correct action.\n\n",
            "Rules:\n",
            "- If the new fact updates or supersedes the old one (e.g., a preference changed), ",
            "return \"update\" with the merged/updated fact\n",
            "- If both facts are distinct and complementary, return \"keep_both\"\n",
            "- If the existing fact already covers the new information, return \"keep_existing\"\n\n",
            "Return ONLY a JSON object, no other text:\n",
            "{\"action\": \"update\"|\"keep_both\"|\"keep_existing\", \"merged_fact\": \"...\"}\n",
            "The merged_fact field is required when action is \"update\", optional otherwise."
        );

        let user_msg = format!("Existing fact: \"{existing_fact}\"\nNew fact: \"{new_fact}\"");

        let url = format!("{}/v1/chat/completions", self.api_base_url);

        let body = serde_json::json!({
            "model": &self.extraction_model,
            "messages": [
                { "role": "system", "content": system_prompt },
                { "role": "user", "content": user_msg },
            ],
            "temperature": 0.0,
        });

        let resp = self
            .http
            .post(&url)
            .header(
                "Authorization",
                format!("Bearer {}", self.api_key.expose_secret()),
            )
            .json(&body)
            .send()
            .await?
            .error_for_status()?
            .json::<ChatResponse>()
            .await?;

        let content = resp
            .choices
            .into_iter()
            .next()
            .ok_or_else(|| anyhow::anyhow!("No choices in conflict resolution response"))?
            .message
            .content;

        let cleaned = strip_code_block(&content);
        let resolution: ConflictResolution = serde_json::from_str(cleaned).map_err(|e| {
            anyhow::anyhow!("Failed to parse conflict resolution response: {e} — raw: {cleaned}")
        })?;

        match resolution.action.as_str() {
            "update" => {
                let merged = resolution
                    .merged_fact
                    .ok_or_else(|| anyhow::anyhow!("Update action requires merged_fact field"))?;
                Ok(MemoryConflictAction::Update(
                    MemoryFact::parse(merged).map_err(anyhow::Error::msg)?,
                ))
            }
            "keep_existing" => Ok(MemoryConflictAction::KeepExisting),
            other => {
                if other != "keep_both" {
                    tracing::warn!(
                        action = other,
                        "Unknown conflict action, treating as keep_both"
                    );
                }
                Ok(MemoryConflictAction::KeepBoth)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Strips markdown code-block fencing that LLMs sometimes wrap around JSON.
fn strip_code_block(s: &str) -> &str {
    let s = s.trim();
    if let Some(rest) = s.strip_prefix("```") {
        // Skip optional language tag on the first line (e.g. ```json)
        let rest = rest.split_once('\n').map(|(_, r)| r).unwrap_or(rest);
        rest.strip_suffix("```").unwrap_or(rest).trim()
    } else {
        s
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_code_block_plain() {
        let input = r#"["fact one", "fact two"]"#;
        assert_eq!(strip_code_block(input), input);
    }

    #[test]
    fn strip_code_block_fenced() {
        let input = "```json\n[\"fact one\"]\n```";
        assert_eq!(strip_code_block(input), "[\"fact one\"]");
    }

    #[test]
    fn strip_code_block_no_lang() {
        let input = "```\n{\"action\": \"update\"}\n```";
        assert_eq!(strip_code_block(input), "{\"action\": \"update\"}");
    }
}
