-- One row per download-page email capture. Contacts are derived by grouping on email.
CREATE TABLE IF NOT EXISTS downloads (
    id TEXT PRIMARY KEY NOT NULL,
    email TEXT NOT NULL,
    app TEXT NOT NULL,
    downloaded_at TEXT NOT NULL,
    referrer TEXT,
    user_agent TEXT
);

CREATE INDEX IF NOT EXISTS downloads_email_app_idx ON downloads (email, app, downloaded_at);
CREATE INDEX IF NOT EXISTS downloads_app_idx ON downloads (app);
