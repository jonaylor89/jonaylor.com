-- Add lifecycle columns to vault_clients so API keys can be revoked and
-- recognised in the admin UI without ever showing their full plaintext again.
--
-- token_prefix stores the first ~12 chars of the issued token (e.g. "ptv_aBcDeFgH")
-- so the user can match a row against the secret they saved at creation time.
-- For pre-existing rows it stays NULL; the admin UI surfaces these as "(unknown)"
-- and encourages rotation.

ALTER TABLE vault_clients ADD COLUMN revoked_at  TEXT;
ALTER TABLE vault_clients ADD COLUMN token_prefix TEXT;

CREATE INDEX IF NOT EXISTS vault_clients_active_idx
    ON vault_clients (api_token_hash)
    WHERE revoked_at IS NULL;
