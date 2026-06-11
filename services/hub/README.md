# Hub

Personal services hub built with Rust, Axum, and PostgreSQL. Hosts the email newsletter, a pastebin for shareable text snippets, the pi-thread-vault (captured coding-agent sessions), and the unified admin portal.

## Setup

```bash
# Start PostgreSQL and Redis
./scripts/init_db.sh
./scripts/init_redis.sh

# Run migrations
sqlx migrate run

# Run the application
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

The container image does not include the `configuration/` directory. Mount it at runtime so the application can read `/app/configuration`.

Example `docker compose` service:

```yaml
services:
  app:
    build: .
    environment:
      APP_ENVIRONMENT: production
    volumes:
      - ./configuration:/app/configuration:ro
```

Example `docker run`:

```bash
docker run \
  -e APP_ENVIRONMENT=production \
  -v "$(pwd)/configuration:/app/configuration:ro" \
  <image-name>
```

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
