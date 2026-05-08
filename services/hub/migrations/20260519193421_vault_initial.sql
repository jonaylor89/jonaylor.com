-- pi-thread-vault tables ported from SQLite.
-- Timestamps remain RFC3339 TEXT to minimise churn in the ported Rust code; a
-- follow-up migration can convert them to TIMESTAMPTZ if needed.

CREATE TABLE IF NOT EXISTS vault_clients (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    api_token_hash  TEXT NOT NULL UNIQUE,
    created_at      TEXT NOT NULL,
    last_seen_at    TEXT
);

CREATE TABLE IF NOT EXISTS vault_threads (
    id                  TEXT PRIMARY KEY,
    external_session_id TEXT NOT NULL UNIQUE,
    title               TEXT,
    cwd                 TEXT,
    repo_remote         TEXT,
    repo_branch         TEXT,
    repo_head           TEXT,
    status              TEXT NOT NULL DEFAULT 'active',
    default_visibility  TEXT NOT NULL DEFAULT 'private',
    created_at          TEXT NOT NULL,
    updated_at          TEXT NOT NULL
);

-- inserted_seq replaces SQLite's rowid for stable insertion-order tie-breaking.
CREATE TABLE IF NOT EXISTS vault_thread_events (
    id                       TEXT PRIMARY KEY,
    inserted_seq             BIGSERIAL NOT NULL,
    thread_id                TEXT NOT NULL REFERENCES vault_threads(id) ON DELETE CASCADE,
    external_event_id        TEXT,
    parent_external_event_id TEXT,
    event_hash               TEXT NOT NULL,
    role                     TEXT NOT NULL,
    kind                     TEXT NOT NULL,
    content                  TEXT,
    redacted                 BOOLEAN NOT NULL DEFAULT TRUE,
    metadata_json            TEXT NOT NULL DEFAULT '{}',
    created_at               TEXT,
    inserted_at              TEXT NOT NULL,
    content_tsv              tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('english', coalesce(content, '')), 'A') ||
        setweight(to_tsvector('english', coalesce(role, '')),    'B') ||
        setweight(to_tsvector('english', coalesce(kind, '')),    'C')
    ) STORED,
    UNIQUE(thread_id, event_hash)
);

CREATE INDEX IF NOT EXISTS vault_thread_events_thread_id_idx
    ON vault_thread_events (thread_id);
CREATE INDEX IF NOT EXISTS vault_thread_events_content_tsv_idx
    ON vault_thread_events USING GIN (content_tsv);

CREATE TABLE IF NOT EXISTS vault_shares (
    id            TEXT PRIMARY KEY,
    thread_id     TEXT NOT NULL REFERENCES vault_threads(id) ON DELETE CASCADE,
    share_kind    TEXT NOT NULL,
    token_hash    TEXT,
    password_hash TEXT,
    is_public     BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at    TEXT,
    revoked_at    TEXT,
    created_at    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_shares_thread_id_idx
    ON vault_shares (thread_id);
CREATE INDEX IF NOT EXISTS vault_shares_token_hash_idx
    ON vault_shares (token_hash)
    WHERE token_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS vault_handoffs (
    id                         TEXT PRIMARY KEY,
    source_thread_id           TEXT NOT NULL REFERENCES vault_threads(id),
    target_thread_id           TEXT REFERENCES vault_threads(id),
    target_external_session_id TEXT,
    goal                       TEXT NOT NULL,
    generated_prompt           TEXT NOT NULL,
    source_event_ids_json      TEXT NOT NULL DEFAULT '[]',
    created_at                 TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_handoffs_source_thread_id_idx
    ON vault_handoffs (source_thread_id);
CREATE INDEX IF NOT EXISTS vault_handoffs_target_thread_id_idx
    ON vault_handoffs (target_thread_id);
