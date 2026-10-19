-- SQLite / D1. No PostgreSQL functions, RLS, or separate database credentials.
PRAGMA foreign_keys = ON;
CREATE TABLE user (
  id TEXT PRIMARY KEY NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0, image TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE session (
  id TEXT PRIMARY KEY NOT NULL, expires_at INTEGER NOT NULL, token TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ip_address TEXT, user_agent TEXT,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX session_user_idx ON session(user_id);
CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER,
  refresh_token_expires_at INTEGER, scope TEXT, password TEXT,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX account_user_idx ON account(user_id);
CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL,
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE INDEX verification_identifier_idx ON verification(identifier);
CREATE TABLE rate_limit (
  id TEXT PRIMARY KEY NOT NULL, key TEXT NOT NULL UNIQUE, count INTEGER NOT NULL, last_request INTEGER NOT NULL
);
-- Only populated by a localhost-guarded development mail transport. Never a public inbox.
CREATE TABLE local_mail (
  id INTEGER PRIMARY KEY AUTOINCREMENT, recipient TEXT NOT NULL, subject TEXT NOT NULL,
  url TEXT NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE game_saves (
  owner TEXT PRIMARY KEY NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK (revision > 0),
  payload TEXT CHECK (payload IS NULL OR length(CAST(payload AS BLOB)) <= 1048576),
  device TEXT NOT NULL CHECK (length(device) <= 80), updated_at TEXT NOT NULL
);
CREATE TABLE game_save_versions (
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
  payload TEXT, device TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (owner, revision)
);
CREATE TABLE game_save_requests (
  owner TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE, request_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
  payload TEXT CHECK (payload IS NULL OR length(CAST(payload AS BLOB)) <= 1048576),
  device TEXT NOT NULL CHECK (length(device) <= 80), created_at INTEGER NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (owner, request_id)
);
CREATE INDEX game_request_time_idx ON game_save_requests(owner, created_at);
-- A single INSERT is the entire atomic write boundary. D1 cannot use interactive BEGIN/COMMIT.
-- The triggers' CAS, head update, history, receipt and pruning all commit or roll back together.
CREATE TRIGGER game_save_guard BEFORE INSERT ON game_save_requests
BEGIN
  SELECT CASE WHEN COALESCE((SELECT revision FROM game_saves WHERE owner = NEW.owner), 0) != NEW.expected_revision
    THEN RAISE(ABORT, 'save_revision_conflict') END;
  SELECT CASE WHEN (SELECT count(*) FROM game_save_requests
    WHERE owner = NEW.owner AND created_at > NEW.created_at - 60000) >= 120
    THEN RAISE(ABORT, 'save_rate_limit') END;
END;
CREATE TRIGGER game_save_commit AFTER INSERT ON game_save_requests
BEGIN
  INSERT INTO game_saves(owner, revision, payload, device, updated_at)
    VALUES (NEW.owner, NEW.expected_revision + 1, NEW.payload, NEW.device, NEW.updated_at)
    ON CONFLICT(owner) DO UPDATE SET revision = excluded.revision, payload = excluded.payload,
      device = excluded.device, updated_at = excluded.updated_at;
  INSERT INTO game_save_versions(owner, revision, payload, device, updated_at)
    VALUES (NEW.owner, NEW.expected_revision + 1, NEW.payload, NEW.device, NEW.updated_at);
  DELETE FROM game_save_versions WHERE owner = NEW.owner AND revision <= NEW.expected_revision + 1 - 20;
  DELETE FROM game_save_requests WHERE owner = NEW.owner AND rowid NOT IN
    (SELECT rowid FROM game_save_requests WHERE owner = NEW.owner ORDER BY rowid DESC LIMIT 120);
END;
