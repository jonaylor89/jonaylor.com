# Contributing

Contributions welcome! `hub` is a Rust + Axum service hosting the email newsletter, the pi-thread-vault, the memory layer, and the unified admin portal. Data is stored in **SQLite** (relational) and **LanceDB** (vector embeddings). Sessions use **Redis**.

## Development Setup

```bash
# Clone the repository
git clone <repo-url>
cd services/hub

# Start Redis (sessions)
./scripts/init_redis.sh

# Build the project
cargo build

# Run the application (SQLite DB + LanceDB directory created automatically)
cargo run
```

No database server needed — SQLite and LanceDB are embedded. The SQLite database is created at `./data/hub.db` and LanceDB stores memory embeddings in `./data/memories/`. Both are configured in `configuration/base.yaml`.

## Database Changes

If you modify database queries:

```bash
# Regenerate SQLx metadata for offline compilation against the dev SQLite DB
DATABASE_URL="sqlite://data/dev.db?mode=rwc" cargo sqlx prepare

# Create a new migration (add SQLite-compatible DDL)
sqlx migrate add <migration_name>
```

All migrations are consolidated in the first migration file. New migrations should use SQLite DDL syntax (`TEXT` for UUIDs/timestamps, `INTEGER` for booleans, `?` parameter placeholders).

## Testing

Integration tests use a temp-file SQLite database and a Redis Testcontainer. Docker must be running for Redis.

```bash
# Run all tests
cargo test

# Run with logging output
TEST_LOG=1 cargo test

# Run a specific test
cargo test test_subscribe

# Run integration tests
cargo test --test api
```

## Checks

Before submitting a PR:

```bash
# Format code
cargo fmt

# Run linter
cargo clippy --all-targets -- -D warnings

# Check compilation
cargo check --all-targets

# Build release to catch any issues
cargo build --release
```

## Project Structure

```
src/
├── routes/              # HTTP endpoints
│   ├── subscriptions.rs       # Subscription management
│   ├── subscriptions_confirm.rs # Email confirmation
│   └── admin/                 # Admin routes (newsletters, dashboard)
├── domain/              # Domain types with validation
├── authentication/      # Auth middleware and password hashing
├── idempotency/        # Idempotency key handling (JSON headers in SQLite)
├── memory/             # LanceDB-backed fact extraction and vector search
│   ├── engine.rs             # LanceDB connection, embedding, upsert, search
│   ├── routes.rs             # HTTP handlers for memory API
│   └── worker.rs             # Background extraction queue processor
├── vault/              # Pi-thread-vault (FTS5 full-text search)
├── pastebin/           # Simple paste service
├── email_client.rs     # Postmark email integration
├── email_templates.rs  # Askama templates
├── issue_delivery_queue.rs # Background email worker
├── idempotency_cleanup.rs  # Background cleanup worker
├── rss_worker.rs       # Blog RSS feed → newsletter bridge
├── configuration.rs    # Settings management
└── startup.rs          # Application initialization
```

## Architecture

The application runs four concurrent workers:
- **API Server**: HTTP endpoints for subscriptions, newsletter publishing, vault, memory, and pastebin
- **Email Delivery Worker**: Processes newsletter delivery queue with retry logic
- **Idempotency Cleanup Worker**: Daily cleanup of expired idempotency keys
- **Memory Extraction Worker**: Processes queued text through LLM fact extraction into LanceDB

### Storage

| Store | Purpose | Location |
|---|---|---|
| SQLite | All relational data (subscriptions, users, vault, idempotency, queues) | `./data/hub.db` |
| LanceDB | Memory embeddings + vector search | `./data/memories/` |
| Redis | HTTP sessions (30-day expiry) | External service |

## Email Templates

Email templates use Askama and are located in `templates/emails/`:
- `confirmation.html/txt` - New subscriber confirmation
- `already_subscribed.html/txt` - Duplicate subscription notification

After modifying templates, rebuild to recompile them.

## Database Schema

SQLite tables (see `migrations/20220707150811_create_subscriptions_table.sql`):
- `subscriptions` - Subscriber emails and confirmation status
- `subscription_tokens` - Email confirmation tokens
- `users` - Admin users with Argon2 hashed passwords
- `newsletter_issues` - Newsletter content
- `issue_delivery_queue` - Delivery tasks with retry tracking
- `dead_letter_queue` - Permanently failed deliveries
- `idempotency` - Request deduplication (30-day retention, JSON headers)
- `vault_threads`, `vault_thread_events`, `vault_shares`, `vault_handoffs`, `vault_clients` - Thread vault
- `vault_thread_events_fts` - FTS5 virtual table for full-text search (synced via triggers)
- `pastes` - Pastebin entries
- `memory_extraction_queue` - Async memory extraction jobs
- `rss_feed_entries` - Tracked RSS feed items

LanceDB table:
- `memories` - Fact embeddings (id, user_id, fact, embedding[1536], is_active, timestamps)

## Commit Messages

Use conventional commits with descriptive details:

```
feat: add parallel email sending with tokio JoinSet
fix: handle duplicate subscription attempts gracefully
docs: update installation instructions
test: add integration tests for confirmation flow
refactor: extract email template rendering
```

For multi-file changes, each commit should be self-contained and focused on one logical change.

## Version Control

This project uses `jj` (Jujutsu) for version control. Common commands:

```bash
# See changes
jj status

# Create a commit
jj commit -m "description"

# View commit history
jj log

# Create a pull request (requires gh CLI)
gh pr create
```

## AI Assistance

If using AI assistance (Claude, GitHub Copilot, etc.), please:
- Disclose it in your PR description
- Review generated code carefully for correctness and security
- Ensure all tests pass and code follows project patterns
- Verify database queries are safe from SQL injection
