-- Consolidated SQLite schema. All tables are created here;
-- subsequent migration files are no-ops (their changes are baked in).

-- Subscriptions
CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL UNIQUE,
    name TEXT,
    subscribed_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'confirmed'
);

-- Subscription tokens
CREATE TABLE IF NOT EXISTS subscription_tokens (
    subscription_token TEXT NOT NULL,
    subscriber_id TEXT NOT NULL REFERENCES subscriptions(id),
    PRIMARY KEY (subscription_token)
);

-- Users
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
);

-- Seed admin user
INSERT OR IGNORE INTO users (user_id, username, password_hash)
VALUES (
    'ddf8994f-d522-4659-8d02-c1d479057be6',
    'admin',
    '$argon2id$v=19$m=15000,t=2,p=1$P66edN3mzaFAJnb86Jd0zg$obEKgIFboRdvlwcFhdEMtfn34REvNtcs2MsAkJGVp6I'
);

-- Idempotency (headers stored as JSON TEXT instead of Postgres composite type)
CREATE TABLE IF NOT EXISTS idempotency (
    user_id TEXT NOT NULL REFERENCES users(user_id),
    idempotency_key TEXT NOT NULL,
    response_status_code INTEGER,
    response_headers TEXT,
    response_body BLOB,
    created_at TEXT NOT NULL,
    PRIMARY KEY (user_id, idempotency_key)
);

-- Newsletter issues
CREATE TABLE IF NOT EXISTS newsletter_issues (
    newsletter_issue_id TEXT PRIMARY KEY NOT NULL,
    title TEXT NOT NULL,
    text_content TEXT NOT NULL,
    html_content TEXT NOT NULL,
    published_at TEXT NOT NULL
);

-- Issue delivery queue
CREATE TABLE IF NOT EXISTS issue_delivery_queue (
    newsletter_issue_id TEXT NOT NULL REFERENCES newsletter_issues(newsletter_issue_id),
    subscriber_email TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempted_at TEXT,
    error_message TEXT,
    PRIMARY KEY (newsletter_issue_id, subscriber_email)
);

-- Dead letter queue
CREATE TABLE IF NOT EXISTS dead_letter_queue (
    newsletter_issue_id TEXT NOT NULL,
    subscriber_email TEXT NOT NULL,
    last_error TEXT NOT NULL,
    failed_at TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (newsletter_issue_id, subscriber_email)
);

-- RSS feed entries
CREATE TABLE IF NOT EXISTS rss_feed_entries (
    id TEXT PRIMARY KEY NOT NULL,
    guid TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    url TEXT NOT NULL,
    published_at TEXT,
    processed_at TEXT NOT NULL,
    newsletter_issue_id TEXT REFERENCES newsletter_issues(newsletter_issue_id)
);

-- Vault clients
CREATE TABLE IF NOT EXISTS vault_clients (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    api_token_hash TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    revoked_at TEXT,
    token_prefix TEXT
);

CREATE INDEX IF NOT EXISTS vault_clients_active_idx
    ON vault_clients (api_token_hash)
    WHERE revoked_at IS NULL;

-- Vault threads
CREATE TABLE IF NOT EXISTS vault_threads (
    id TEXT PRIMARY KEY,
    external_session_id TEXT NOT NULL UNIQUE,
    title TEXT,
    cwd TEXT,
    repo_remote TEXT,
    repo_branch TEXT,
    repo_head TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    default_visibility TEXT NOT NULL DEFAULT 'private',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

-- Vault thread events (without tsvector; FTS5 virtual table below)
CREATE TABLE IF NOT EXISTS vault_thread_events (
    id TEXT PRIMARY KEY,
    inserted_seq INTEGER NOT NULL DEFAULT 0,
    thread_id TEXT NOT NULL REFERENCES vault_threads(id) ON DELETE CASCADE,
    external_event_id TEXT,
    parent_external_event_id TEXT,
    event_hash TEXT NOT NULL,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    content TEXT,
    redacted INTEGER NOT NULL DEFAULT 1,
    metadata_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT,
    inserted_at TEXT NOT NULL,
    UNIQUE(thread_id, event_hash)
);

CREATE INDEX IF NOT EXISTS vault_thread_events_thread_id_idx
    ON vault_thread_events (thread_id);

-- FTS5 virtual table for vault full-text search
CREATE VIRTUAL TABLE IF NOT EXISTS vault_thread_events_fts USING fts5(
    content, role, kind,
    content='vault_thread_events',
    content_rowid='rowid'
);

-- Triggers to keep FTS5 index in sync
CREATE TRIGGER IF NOT EXISTS vault_events_ai AFTER INSERT ON vault_thread_events BEGIN
    INSERT INTO vault_thread_events_fts(rowid, content, role, kind)
    VALUES (new.rowid, new.content, new.role, new.kind);
END;

CREATE TRIGGER IF NOT EXISTS vault_events_ad AFTER DELETE ON vault_thread_events BEGIN
    INSERT INTO vault_thread_events_fts(vault_thread_events_fts, rowid, content, role, kind)
    VALUES('delete', old.rowid, old.content, old.role, old.kind);
END;

CREATE TRIGGER IF NOT EXISTS vault_events_au AFTER UPDATE ON vault_thread_events BEGIN
    INSERT INTO vault_thread_events_fts(vault_thread_events_fts, rowid, content, role, kind)
    VALUES('delete', old.rowid, old.content, old.role, old.kind);
    INSERT INTO vault_thread_events_fts(rowid, content, role, kind)
    VALUES (new.rowid, new.content, new.role, new.kind);
END;

-- Vault shares
CREATE TABLE IF NOT EXISTS vault_shares (
    id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL REFERENCES vault_threads(id) ON DELETE CASCADE,
    share_kind TEXT NOT NULL,
    token_hash TEXT,
    password_hash TEXT,
    is_public INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT,
    revoked_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_shares_thread_id_idx
    ON vault_shares (thread_id);
CREATE INDEX IF NOT EXISTS vault_shares_token_hash_idx
    ON vault_shares (token_hash)
    WHERE token_hash IS NOT NULL;

-- Vault handoffs
CREATE TABLE IF NOT EXISTS vault_handoffs (
    id TEXT PRIMARY KEY,
    source_thread_id TEXT NOT NULL REFERENCES vault_threads(id),
    target_thread_id TEXT REFERENCES vault_threads(id),
    target_external_session_id TEXT,
    goal TEXT NOT NULL,
    generated_prompt TEXT NOT NULL,
    source_event_ids_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS vault_handoffs_source_thread_id_idx
    ON vault_handoffs (source_thread_id);
CREATE INDEX IF NOT EXISTS vault_handoffs_target_thread_id_idx
    ON vault_handoffs (target_thread_id);

-- Pastes
CREATE TABLE IF NOT EXISTS pastes (
    id TEXT PRIMARY KEY NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS pastes_created_at_idx ON pastes (created_at DESC);

-- Memory extraction queue (memories themselves live in LanceDB)
CREATE TABLE IF NOT EXISTS memory_extraction_queue (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    raw_text TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempt_count INTEGER NOT NULL DEFAULT 0,
    last_attempted_at TEXT,
    last_error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS memory_extraction_queue_status_idx
    ON memory_extraction_queue (status)
    WHERE status IN ('pending', 'failed');
