-- Memory layer for AI fact extraction and semantic search.
-- Requires the pgvector extension. If pgvector is not installed on the
-- PostgreSQL server, this migration completes gracefully with a notice
-- and the memory API endpoints will return 503 (Service Unavailable).
DO $$
BEGIN
    CREATE EXTENSION IF NOT EXISTS vector;

    CREATE TABLE IF NOT EXISTS memories (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id TEXT NOT NULL,
        fact TEXT NOT NULL,
        embedding vector(1536) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        is_active BOOLEAN NOT NULL DEFAULT TRUE
    );

    CREATE INDEX IF NOT EXISTS memories_user_id_active_idx
        ON memories (user_id) WHERE is_active = TRUE;

    CREATE INDEX IF NOT EXISTS memories_embedding_idx
        ON memories USING hnsw (embedding vector_cosine_ops);

EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pgvector extension not available — memory tables not created. Install pgvector to enable the memory feature.';
END
$$;
