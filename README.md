# Email Newsletter

Email newsletter service built with Rust, Axum, and PostgreSQL.

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
