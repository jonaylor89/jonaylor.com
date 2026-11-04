# Hub

Personal services hub built with Rust, Axum, and SQLite, with Redis-backed sessions and optional LanceDB memory storage. Hosts the email newsletter, a pastebin for shareable text snippets, the pi-thread-vault (captured coding-agent sessions), and the unified admin portal.

## Setup

```bash
# Start Redis for sessions
./scripts/init_redis.sh

# Prepare local embedded storage
mkdir -p data

# Run the application; SQLite is created and migrated at startup
cargo run
```

## Testing

```bash
cargo test
```

## Vault backfill

Backfill existing pi-coding-agent JSONL sessions from the machine that has the session files:

```bash
JONAYLOR_TOKEN=<token> scripts/backfill_pi_sessions.sh --server-url https://example.com
```

The script scans `~/.pi/agent/sessions` by default, or accepts explicit JSONL files/directories.
Use `--dry-run` to preview counts. Requires `bash`, `jq`, `curl`, and `shasum`/`sha256sum`.

## Container Usage

Use the maintained [`infra/services`](../../infra/services) Compose stack for deployment, persistent storage, Redis, and optional tunnel access.

The container reads `/app/configuration/base.yaml` and `/app/configuration/production.yaml` at runtime. The stack mounts both read-only, supplies secrets through local environment variables, and persists SQLite, vault blobs, and optional memory data under `/app/data`. No Postgres server is required.

## Jonaylor CLI

This repo includes a personal Hub CLI:

```bash
cargo run --bin jonaylor -- --help
cargo install --path . --bin jonaylor
jonaylor login
jonaylor vault share-current-thread
jonaylor github pi-threads-block
```

`jonaylor login` opens the Hub in your browser, asks you to sign in as admin if needed, and writes the unified config to `~/.config/jonaylor/config.toml`. pi-thread-vault reads the same file for `base_url`, `token`, and `[pi_thread_vault]` settings, including memory settings. The vault share commands create reviewer-openable `/s/...` pi-thread links for use in PR descriptions.

## Pastebin

Create snippets from `/admin/pastebin` after signing in, or from scripts with a Hub API token issued by `jonaylor auth issue-token`:

```bash
curl -X PUT \
  -H "Authorization: Bearer $JONAYLOR_TOKEN" \
  --data-binary @snippet.txt \
  https://hub.example.com/api/pastes
```

Paste URLs are public to anyone with the secret link. Append `?raw=1`, send `Accept: text/plain`, or use `curl` to retrieve plain text.

## Architecture

- **API Server**: Subscription, newsletter, pastebin, and vault endpoints
- **Email Delivery Worker**: Background queue with retry logic
- **Idempotency Cleanup Worker**: Daily cleanup of expired keys

## Templates

Email and web templates use Askama and are located in `templates/`.
