CREATE TABLE webhook_deliveries (
    delivery_id TEXT PRIMARY KEY NOT NULL,
    alias_id TEXT REFERENCES aliases (alias_id) ON DELETE SET NULL,
    url TEXT NOT NULL,
    payload TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT
);

CREATE INDEX idx_webhook_deliveries_status ON webhook_deliveries (status, next_attempt_at);
