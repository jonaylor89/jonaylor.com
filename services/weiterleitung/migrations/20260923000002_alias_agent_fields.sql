-- Agent-facing fields on aliases: expiry for the janitor and an optional
-- webhook the inbound worker posts deliveries to.

ALTER TABLE aliases ADD COLUMN expires_at TEXT;
ALTER TABLE aliases ADD COLUMN webhook_url TEXT;
