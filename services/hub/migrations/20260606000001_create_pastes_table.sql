CREATE TABLE pastes (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX pastes_created_at_idx ON pastes (created_at DESC);
