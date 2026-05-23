# Hub

Personal services hub built with Rust, Axum, and PostgreSQL. Hosts the email newsletter, the pi-thread-vault (captured coding-agent sessions), and the unified admin portal.

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
PI_THREAD_VAULT_API_TOKEN=<token> scripts/backfill_pi_sessions.sh --server-url https://example.com
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

## Architecture

- **API Server**: Subscription and newsletter endpoints
- **Email Delivery Worker**: Background queue with retry logic
- **Idempotency Cleanup Worker**: Daily cleanup of expired keys

## Templates

Email and web templates use Askama and are located in `templates/`.
