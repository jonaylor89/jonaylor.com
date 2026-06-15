CREATE TABLE memory_extraction_queue (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           TEXT NOT NULL,
    raw_text          TEXT NOT NULL,
    status            TEXT NOT NULL DEFAULT 'pending',
    attempt_count     INTEGER NOT NULL DEFAULT 0,
    last_attempted_at TIMESTAMPTZ,
    last_error        TEXT,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX memory_extraction_queue_status_idx
    ON memory_extraction_queue (status) WHERE status IN ('pending', 'failed');
