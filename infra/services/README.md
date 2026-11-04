# Shared services

Docker Compose for Hub, Redis sessions, Gitea, and Uptime Kuma, with an optional
Cloudflare Tunnel. The [media stack](../media) is deployed independently.

No OS provisioning, machine inventory, or remote deployment framework. Install
Docker Engine and the Compose plugin using the Linux distribution's instructions.
All service images are pinned by digest; upgrades are deliberate, separate changes.
These pins reproduce the selected service versions, not a promise of newest releases.

## Configuration

1. Copy `.env.example` to `.env` and replace the placeholder settings and credentials.
   Generate a strong Hub HMAC secret, for example with `openssl rand -hex 32`.
2. Set `APPDATA_DIR` to persistent storage outside the checkout. Create its `hub`,
   `redis`, `gitea`, and `uptime` subdirectories and prepare ownership for the selected
   images. Gitea's `PUID` and `PGID` must match its data owner. Do not recursively
   change ownership of existing storage without inspecting it first.
3. Confirm `.env` contains the correct public application URLs and email sender.
   The Hub image reads the versioned base configuration from `services/hub` and the
   production settings in `hub.yaml`; secrets are supplied through the environment.

The Compose file refuses missing bind-mount paths instead of creating empty data
folders silently. It uses a fixed `services` project name; migrating an existing
project requires explicitly stopping the old instances before starting these.

```bash
docker compose --env-file .env -f compose.yml config --quiet
docker compose --env-file .env -f compose.yml up -d
docker compose --env-file .env -f compose.yml ps
```

## Storage

| Service | Persistent directory | Contents |
| --- | --- | --- |
| Hub | `APPDATA_DIR/hub` | SQLite database, vault blobs, optional memory embeddings |
| Redis | `APPDATA_DIR/redis` | Append-only session persistence |
| Gitea | `APPDATA_DIR/gitea` | SQLite database, repositories, attachments, configuration |
| Uptime Kuma | `APPDATA_DIR/uptime` | Monitor configuration and history |

Hub uses SQLite; it does not require a Postgres server. Redis is internal-only and
is health-checked before Hub starts. Hub's memory integration is off by default;
enable it with a local override and provide credentials privately if needed.
See [`services/hub`](../../services/hub) for application details.

## Access

Published ports bind to loopback by default: Hub `8000`, Gitea HTTP `3000`, Gitea SSH
`2222`, and Uptime Kuma `3001`. Use private forwarding or a reverse proxy, or choose
a private bind address locally. Configure application accounts before allowing
other devices access. Never expose Redis or mount the Docker socket into the stack.

The optional `tunnel` profile requires a non-empty `CLOUDFLARE_TUNNEL_TOKEN` in `.env`:

```bash
docker compose --env-file .env -f compose.yml --profile tunnel up -d
```

Configure tunnel origins using service DNS names such as `http://hub:8000` or
`http://gitea:3000`, not `localhost`. Protect administrative routes with application
authentication and appropriate access policies. Enabling a tunnel does not secure
an application automatically. Keep real URLs and tunnel configuration out of source.

## Deploying existing data

Before deploying, privately inspect the current images, mounts, configuration,
project name, and database types. Back up persistent data and use consistent database
backups or stop affected services before copying. Do not overwrite configuration or
initialize empty databases over existing data.

Move Hub's SQLite files, vault blobs, and optional memory files into the layout in
`hub.yaml`, or preserve their paths in an ignored `*.local.yml` override. Preserve
Gitea's actual database type and settings when restoring; this Compose file defaults
to SQLite for a new deployment. Use the same override files on every Compose command.
Do not run duplicate instances against the same data.

Validate a restored copy, application health (`/health_check` for Hub), repository
access, monitors, and public routes before removing source data. Keep migration and
image upgrades separate. A repository update alone does not change running services.

## Operations

```bash
docker compose --env-file .env -f compose.yml logs --tail=100
docker compose --env-file .env -f compose.yml stop
```

Back up `.env` privately, SQLite consistently (including any active WAL state), vault
blobs, repositories, uploads, and monitoring data. Redis persistence is not a backup.
Test restores. Configure storage mounts to be available before Docker starts, then
verify restart recovery on the chosen host.

## Validation

```bash
docker compose --env-file .env.example -f compose.yml config --quiet
docker compose --env-file .env.example -f compose.yml --profile tunnel config --quiet
python3 test_compose.py
```

These checks validate configuration and deployment invariants; they do not start
containers or replace runtime and restore testing.
