use std::sync::Arc;

use arrow_array::types::Float32Type;
use arrow_array::{
    BooleanArray, FixedSizeListArray, Float64Array, RecordBatch, RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema};
use chrono::{DateTime, Utc};
use futures_util::TryStreamExt;
use lancedb::query::{ExecutableQuery, QueryBase};
use secrecy::{ExposeSecret, Secret};
use tokio::sync::OnceCell;
use uuid::Uuid;

use crate::configuration::MemorySettings;
use crate::domain::{MemoryConflictAction, MemoryFact};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EMBEDDING_DIM: i32 = 1536;
const TABLE_NAME: &str = "memories";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// Core memory engine that handles LLM-based fact extraction, embedding,
/// vector storage via LanceDB, and semantic retrieval.
#[derive(Clone)]
pub struct MemoryEngine {
    db: Arc<lancedb::Connection>,
    table: Arc<OnceCell<lancedb::Table>>,
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
// MemoryEngine implementation
// ---------------------------------------------------------------------------

impl MemoryEngine {
    pub async fn new(settings: &MemorySettings) -> Self {
        let http = reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .expect("Failed to build HTTP client for memory engine");

        let db = if settings.enabled {
            let conn = lancedb::connect(&settings.data_dir)
                .execute()
                .await
                .expect("Failed to connect to LanceDB");
            Arc::new(conn)
        } else {
            // Create a throwaway in-memory connection when disabled; it will
            // never be used but avoids wrapping everything in Option.
            let conn = lancedb::connect("memory://disabled")
                .execute()
                .await
                .expect("Failed to create placeholder LanceDB connection");
            Arc::new(conn)
        };

        Self {
            db,
            table: Arc::new(OnceCell::new()),
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

    // -- Table management ------------------------------------------------------

    async fn table(&self) -> Result<&lancedb::Table, anyhow::Error> {
        self.table
            .get_or_try_init(|| async {
                // Check if table already exists.
                let tables = self.db.table_names().execute().await?;
                if tables.iter().any(|t| t == TABLE_NAME) {
                    let table = self.db.open_table(TABLE_NAME).execute().await?;
                    return Ok(table);
                }

                // Create with an empty batch that defines the schema.
                let schema = memory_schema();
                let batch = RecordBatch::new_empty(schema.clone());
                let batches: Box<dyn arrow_array::RecordBatchReader + Send> =
                    Box::new(RecordBatchIterator::new(std::iter::once(Ok(batch)), schema));
                let table = self.db.create_table(TABLE_NAME, batches).execute().await?;
                Ok(table)
            })
            .await
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
            if let Some(id) = self
                .upsert_memory(user_id, fact.as_ref(), &embedding)
                .await?
            {
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
        let table = self.table().await?;

        let filter = format!("user_id = '{user_id}' AND is_active = true");
        let batches: Vec<RecordBatch> = table
            .vector_search(embedding.as_slice())
            .map_err(|e| anyhow::anyhow!("vector search setup failed: {e}"))?
            .distance_type(lancedb::DistanceType::Cosine)
            .only_if(filter)
            .limit(self.search_limit as usize)
            .execute()
            .await?
            .try_collect()
            .await?;

        let mut matches = Vec::new();
        for batch in &batches {
            let ids = batch
                .column_by_name("id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing id column"))?;
            let facts = batch
                .column_by_name("fact")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing fact column"))?;
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float64Array>())
                .ok_or_else(|| anyhow::anyhow!("missing _distance column"))?;
            let created_dates = batch
                .column_by_name("created_at")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing created_at column"))?;

            for i in 0..batch.num_rows() {
                let id_str = ids.value(i);
                let id = Uuid::parse_str(id_str)
                    .map_err(|e| anyhow::anyhow!("invalid UUID in LanceDB: {e}"))?;
                let distance = distances.value(i);
                let similarity = 1.0 - distance;
                let created_at = created_dates
                    .value(i)
                    .parse::<DateTime<Utc>>()
                    .unwrap_or_else(|_| Utc::now());

                matches.push(MemoryMatch {
                    id,
                    fact: facts.value(i).to_string(),
                    similarity,
                    created_at,
                });
            }
        }

        Ok(matches)
    }

    /// Lists all active memories for a user, ordered by most recently updated.
    #[tracing::instrument(name = "memory::list_memories", skip(self))]
    pub async fn list_memories(&self, user_id: &str) -> Result<Vec<Memory>, anyhow::Error> {
        let table = self.table().await?;

        let filter = format!("user_id = '{user_id}' AND is_active = true");
        let batches: Vec<RecordBatch> = table
            .query()
            .only_if(filter)
            .select(lancedb::query::Select::Columns(vec![
                "id".into(),
                "user_id".into(),
                "fact".into(),
                "created_at".into(),
                "updated_at".into(),
            ]))
            .execute()
            .await?
            .try_collect()
            .await?;

        let mut memories = Vec::new();
        for batch in &batches {
            let ids = batch
                .column_by_name("id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing id column"))?;
            let user_ids = batch
                .column_by_name("user_id")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing user_id column"))?;
            let facts = batch
                .column_by_name("fact")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing fact column"))?;
            let created_dates = batch
                .column_by_name("created_at")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing created_at column"))?;
            let updated_dates = batch
                .column_by_name("updated_at")
                .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                .ok_or_else(|| anyhow::anyhow!("missing updated_at column"))?;

            for i in 0..batch.num_rows() {
                let id = Uuid::parse_str(ids.value(i))?;
                let created_at = created_dates
                    .value(i)
                    .parse::<DateTime<Utc>>()
                    .unwrap_or_else(|_| Utc::now());
                let updated_at = updated_dates
                    .value(i)
                    .parse::<DateTime<Utc>>()
                    .unwrap_or_else(|_| Utc::now());

                memories.push(Memory {
                    id,
                    user_id: user_ids.value(i).to_string(),
                    fact: facts.value(i).to_string(),
                    created_at,
                    updated_at,
                });
            }
        }

        // Sort by updated_at descending (LanceDB doesn't guarantee ordering on non-vector queries).
        memories.sort_by_key(|m| std::cmp::Reverse(m.updated_at));

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
        embedding: &[f32],
    ) -> Result<Option<Uuid>, anyhow::Error> {
        let table = self.table().await?;

        // Find the closest existing memory for this user.
        let filter = format!("user_id = '{user_id}' AND is_active = true");
        let batches: Vec<RecordBatch> = table
            .vector_search(embedding)
            .map_err(|e| anyhow::anyhow!("vector search setup failed: {e}"))?
            .distance_type(lancedb::DistanceType::Cosine)
            .only_if(filter)
            .limit(1)
            .execute()
            .await?
            .try_collect()
            .await?;

        if let Some(batch) = batches.first()
            && batch.num_rows() > 0
        {
            let distances = batch
                .column_by_name("_distance")
                .and_then(|c| c.as_any().downcast_ref::<Float64Array>())
                .ok_or_else(|| anyhow::anyhow!("missing _distance column"))?;
            let distance = distances.value(0);
            let similarity = 1.0 - distance;

            if similarity > self.similarity_threshold {
                let ids = batch
                    .column_by_name("id")
                    .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                    .ok_or_else(|| anyhow::anyhow!("missing id column"))?;
                let facts = batch
                    .column_by_name("fact")
                    .and_then(|c| c.as_any().downcast_ref::<StringArray>())
                    .ok_or_else(|| anyhow::anyhow!("missing fact column"))?;

                let existing_id = Uuid::parse_str(ids.value(0))?;
                let existing_fact = facts.value(0);

                tracing::debug!(
                    existing_fact = %existing_fact,
                    new_fact = %fact,
                    similarity = similarity,
                    "High similarity detected, resolving conflict"
                );

                let action = match self.resolve_conflict(existing_fact, fact).await {
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
                        self.update_memory(&existing_id, merged.as_ref(), &new_embedding)
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
        embedding: &[f32],
    ) -> Result<Uuid, anyhow::Error> {
        let table = self.table().await?;
        let id = Uuid::new_v4();
        let now = Utc::now().to_rfc3339();

        let batch = make_memory_batch(&id, user_id, fact, embedding, true, &now, &now)?;
        table.add(vec![batch]).execute().await?;

        Ok(id)
    }

    async fn update_memory(
        &self,
        id: &Uuid,
        fact: &str,
        embedding: &[f32],
    ) -> Result<(), anyhow::Error> {
        let table = self.table().await?;
        let now = Utc::now().to_rfc3339();
        let id_str = id.to_string();

        // LanceDB update: delete old row then insert updated row.
        // We need to read the existing row first to preserve user_id and created_at.
        let filter = format!("id = '{id_str}'");
        let batches: Vec<RecordBatch> = table
            .query()
            .only_if(filter.clone())
            .execute()
            .await?
            .try_collect()
            .await?;

        let batch = batches
            .first()
            .filter(|b| b.num_rows() > 0)
            .ok_or_else(|| anyhow::anyhow!("memory {id} not found for update"))?;

        let user_ids = batch
            .column_by_name("user_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or_else(|| anyhow::anyhow!("missing user_id column"))?;
        let created_dates = batch
            .column_by_name("created_at")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>())
            .ok_or_else(|| anyhow::anyhow!("missing created_at column"))?;

        let user_id = user_ids.value(0);
        let created_at = created_dates.value(0);

        // Delete old row, insert updated row.
        table.delete(&filter).await?;
        let new_batch = make_memory_batch(id, user_id, fact, embedding, true, created_at, &now)?;
        table.add(vec![new_batch]).execute().await?;

        Ok(())
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
// Arrow helpers
// ---------------------------------------------------------------------------

fn memory_schema() -> Arc<Schema> {
    Arc::new(Schema::new(vec![
        Field::new("id", DataType::Utf8, false),
        Field::new("user_id", DataType::Utf8, false),
        Field::new("fact", DataType::Utf8, false),
        Field::new(
            "embedding",
            DataType::FixedSizeList(
                Arc::new(Field::new("item", DataType::Float32, true)),
                EMBEDDING_DIM,
            ),
            true,
        ),
        Field::new("is_active", DataType::Boolean, false),
        Field::new("created_at", DataType::Utf8, false),
        Field::new("updated_at", DataType::Utf8, false),
    ]))
}

fn make_memory_batch(
    id: &Uuid,
    user_id: &str,
    fact: &str,
    embedding: &[f32],
    is_active: bool,
    created_at: &str,
    updated_at: &str,
) -> Result<RecordBatch, anyhow::Error> {
    let ids = StringArray::from(vec![id.to_string()]);
    let user_ids = StringArray::from(vec![user_id.to_string()]);
    let facts = StringArray::from(vec![fact.to_string()]);
    let active = BooleanArray::from(vec![is_active]);
    let created = StringArray::from(vec![created_at.to_string()]);
    let updated = StringArray::from(vec![updated_at.to_string()]);

    let embedding_array = FixedSizeListArray::from_iter_primitive::<Float32Type, _, _>(
        vec![Some(embedding.iter().map(|v| Some(*v)).collect::<Vec<_>>())],
        EMBEDDING_DIM,
    );

    let batch = RecordBatch::try_new(
        memory_schema(),
        vec![
            Arc::new(ids),
            Arc::new(user_ids),
            Arc::new(facts),
            Arc::new(embedding_array),
            Arc::new(active),
            Arc::new(created),
            Arc::new(updated),
        ],
    )?;

    Ok(batch)
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
