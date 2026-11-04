#!/usr/bin/env bash
set -euo pipefail

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[[ "$#" -le 1 ]] || die "Usage: $0 [--check|--start]"
case "${1:---check}" in
  --check|--start) action="${1:---check}" ;;
  *) die "Usage: $0 [--check|--start]" ;;
esac

cd "$(dirname "$0")"
[[ "$(uname -s)" == Linux ]] || die "Run on the Linux server."
for cmd in docker findmnt mountpoint realpath; do
  command -v "$cmd" >/dev/null || die "Install prerequisite: $cmd"
done
docker compose version >/dev/null || die "Install the Docker Compose plugin."
[[ -f .env ]] || die "Copy .env.example to .env and edit it first."

# Parse a deliberately small dotenv subset; never execute or source configuration.
# Reject duplicates and unknown keys to catch mistakes and keep Compose consistent.
seen=" "
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  [[ "$line" =~ ^([A-Z_]+)=([a-zA-Z0-9_./:@+-]+)$ ]] ||
    die "Use literal KEY=value entries without whitespace or quotes in .env."
  key="${BASH_REMATCH[1]}"
  value="${BASH_REMATCH[2]}"
  case "$key" in
    APPDATA_DIR|MEDIA_DIR|MEDIA_MOUNT|PUID|PGID|TZ|BIND_ADDRESS) ;;
    *) die "Unknown configuration key: $key" ;;
  esac
  [[ "$seen" != *" $key "* ]] || die "Duplicate configuration key: $key"
  seen+="$key "
  export "$key=$value"
done < .env

for key in APPDATA_DIR MEDIA_DIR MEDIA_MOUNT PUID PGID TZ BIND_ADDRESS; do
  [[ "$seen" == *" $key "* ]] || die "Missing configuration key: $key"
done
[[ "$PUID" =~ ^[0-9]+$ && "$PGID" =~ ^[0-9]+$ ]] || die "PUID and PGID must be numeric."
for key in APPDATA_DIR MEDIA_DIR MEDIA_MOUNT; do
  value="${!key}"
  [[ "$value" == /* && "$value" != *"/../"* && "$value" != */.. ]] ||
    die "$key must be an absolute path without parent traversal."
done
appdata_path="$(realpath -m "$APPDATA_DIR")" || die "Cannot resolve APPDATA_DIR."
media_path="$(realpath -m "$MEDIA_DIR")" || die "Cannot resolve MEDIA_DIR."
[[ "$appdata_path" != / && "$media_path" != / ]] || die "Data directories cannot resolve to /."
case "$appdata_path/" in
  "$media_path/"*) die "Application data cannot be inside the media directory." ;;
esac
case "$media_path/" in
  "$appdata_path/"*) die "Media cannot be inside the application data directory." ;;
esac
mountpoint -q "$MEDIA_MOUNT" || die "Expected storage is not mounted at MEDIA_MOUNT."
actual_mount="$(findmnt -n -o TARGET -T "$MEDIA_DIR")" ||
  die "Create MEDIA_DIR on the mounted storage first."
[[ "$(realpath "$actual_mount")" == "$(realpath "$MEDIA_MOUNT")" ]] ||
  die "MEDIA_DIR is not on the expected mount."
[[ -f "$MEDIA_DIR/.media-root" ]] ||
  die "Verify storage, then create MEDIA_DIR/.media-root manually."
[[ -w "$MEDIA_DIR" ]] || die "MEDIA_DIR is not writable by the deploying user."
[[ "$(id -u)" == "$PUID" && "$(id -g)" == "$PGID" ]] ||
  die "Run as the configured PUID/PGID; prepare ownership separately as administrator."

compose=(docker compose --env-file .env -f compose.yml)
"${compose[@]}" config --quiet
docker info >/dev/null || die "Docker daemon must be running and accessible."

if [[ "$action" == --check ]]; then
  printf 'Configuration and storage checks passed. Run with --start to create directories and deploy.\n'
  exit 0
fi

mkdir -p "$APPDATA_DIR/jellyfin/config" "$APPDATA_DIR/jellyfin/cache"
for service in transmission sonarr radarr prowlarr; do
  mkdir -p "$APPDATA_DIR/$service"
done
for directory in tv movies music downloads; do
  mkdir -p "$MEDIA_DIR/$directory"
done
"${compose[@]}" up -d
