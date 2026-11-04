# Self-hosted media

A small Docker Compose stack for a Linux server: Jellyfin, Transmission, Sonarr,
Radarr, and Prowlarr. No host inventory, remote deployment system, or OS provisioning.
Machine identities, addresses, credentials, and real paths belong only in local files.
Do not commit rendered Compose output, logs, databases, or media.

## Requirements

- Linux with Bash, util-linux (`findmnt`, `mountpoint`), and GNU coreutils (`realpath -m`).
- Docker Engine and the Docker Compose plugin, installed using your distribution's
  instructions. The deploying user must be able to access the daemon (Docker access
  is effectively root access).
- Persistent storage mounted and writable by the deploying user's UID/GID.
- For these pinned images, an x86-64 or ARM64 host supported by the images.

The script does not install packages, change power settings, configure networking,
format disks, recursively change ownership, or copy any media.

## Setup

1. Mount storage persistently using your distribution's tools. Prepare ownership as
   administrator. Keep downloads, TV, movies, and music on the same filesystem for
   hardlinks and atomic moves; put application data on an SSD if available.
   Application data and media must be separate, non-overlapping directory trees.
2. Copy `.env.example` to `.env`. Set paths, timezone, and the deploying user's
   numeric IDs (`id -u`, `id -g`). Use literal values without quotes, spaces,
   substitutions, or inline comments. Do not use `sudo ./bootstrap.sh`.
3. Create `MEDIA_DIR` yourself. After verifying its storage is mounted, create an
   empty `.media-root` file inside it. `MEDIA_MOUNT` must be the exact mountpoint
   containing `MEDIA_DIR`; set it to `/` explicitly if using root-disk storage.
4. Run:

   ```bash
   ./bootstrap.sh --check
   ./bootstrap.sh --start
   ```

The default is check-only. `--start` creates application and media subdirectories,
then starts the stack. It refuses missing/unexpected media mounts and missing
storage markers. Bind mounts never create missing host paths automatically.

**Reboot safety:** bootstrap checks do not run when Docker restarts containers.
Configure your host so storage mounts before Docker starts, and so Docker does not
start if required storage fails (for example, a systemd Docker service drop-in with
`RequiresMountsFor=` and `AssertPathIsMountPoint=` for the local mountpoint). Do not
use an optional mount without a corresponding service dependency. Those local
paths/settings should not be committed here. Verify this with a reboot before
relying on the server. Do not unplug storage while services are running.

The services bind to loopback by default, with no discovery or public torrent
listener ports exposed. Use SSH forwarding, a private reverse proxy, or set
`BIND_ADDRESS` locally to a private interface address. Do not expose the admin UIs
to the internet. Configure authentication before allowing other devices access.
Transmission runs on the host's normal internet connection; this stack does not
provide a VPN or anonymous downloading.

### Optional private access with Tailscale

Keep `BIND_ADDRESS=127.0.0.1`. With Tailscale already installed and connected, an
administrator can grant the deploying user permission to configure its private proxy:

```bash
sudo tailscale set --operator="$USER"
tailscale serve --bg --http=8096 http://127.0.0.1:8096
tailscale serve status
```

Use the URL printed by Tailscale in Jellyfin and Finamp, with Tailscale enabled on
clients. This is tailnet-only access, not public Funnel access; Tailscale encrypts
the connection between devices even though this private endpoint uses HTTP. Keep
actual server URLs out of the repository. The background proxy survives restarts.
To remove it: `tailscale serve --http=8096 off`.

## Paths and first-run configuration

| Host path | Container path | Purpose |
| --- | --- | --- |
| `APPDATA_DIR/jellyfin/config` | `/config` | Jellyfin database and settings |
| `APPDATA_DIR/jellyfin/cache` | `/cache` | Regenerable cache/transcodes |
| `APPDATA_DIR/<other-service>` | `/config` | Other service settings/databases |
| `MEDIA_DIR` | `/data` | Shared media and downloads for automation services |
| `MEDIA_DIR/music` | `/data/music` | Read-only Jellyfin music library |
| `MEDIA_DIR/tv` | `/data/tv` | Read-only Jellyfin TV library |
| `MEDIA_DIR/movies` | `/data/movies` | Read-only Jellyfin movie library |

- Configure Transmission's completed downloads under `/data/downloads`.
- Set Sonarr/Radarr roots to `/data/tv` and `/data/movies`.
- Connect services using Compose DNS names and their internal ports, for example
  `transmission:9091`, `sonarr:8989`, and `radarr:7878`, not `localhost`.
- Add `/data/music` as a Music library in Jellyfin. Media is read-only in Jellyfin;
  metadata/artwork are stored in its configuration directory rather than alongside files.
- Hardware transcoding is intentionally not assumed. Configure it separately in an
  ignored `*.local.yml` override, passing that override to Compose explicitly.
  The bootstrap script only starts the base file.

## Migration

1. Record the running stack's **actual** bind mounts, container paths, configuration,
   image digests, and user IDs locally. Do not assume an older Compose file matches
   the running deployment. Verify image versions against the source before migrating;
   adjust the pinned digests first if needed to avoid an unintended upgrade.
2. Prepare the destination storage and run the check. Copy bulk media while the
   source remains available, using `rsync -a --partial --progress` over SSH.
3. Stop source media/download/automation services. Perform a final media sync and
   copy their configuration directories while stopped; do not copy live SQLite
   databases. Keep an independent backup before starting the destination.
4. Map the copied configuration to the paths above. Preserve existing Jellyfin
   library paths. If existing download clients use `/downloads` or other paths,
   update their saved paths and the automation settings deliberately; this stack
   standardizes shared storage under `/data`. Alternatively, preserve the old mounts
   in an ignored `*.local.yml` override while migrating. Pass the same override with
   `-f` to every Compose command; do not run the base-only bootstrap against that
   deployment. Resume a small test download first.
5. Start the destination. Check users, watch history, playback, music scanning,
   download paths, completed-download imports, and permissions. Avoid simultaneous
   source and destination download/automation services.
6. Update client endpoints locally. Keep the source stopped and intact for rollback.
   If rolling back, stop the destination first; do not overwrite the source backup
   with a database modified by a newer image.

Do not combine migration with software upgrades. Other unrelated services can remain
on the original host.

## Importing music from a laptop

Copy actual audio files and artwork, not just a music application's library database.
On macOS, downloaded audio can live beneath `~/Music/Music/Media.localized/Music/`;
other collections may be separate directories under `~/Music`. Cloud-only tracks
must be downloaded first; DRM-protected subscription files may not play in Jellyfin.
Keep the original library as a backup. Jellyfin does not import Apple Music playlists,
ratings, or play counts automatically.

Set these variables **locally in your terminal**, not in committed files:

```bash
read -r -p 'SSH destination: ' DEST
read -r -p 'Absolute server music directory: ' MUSIC_DEST
read -r -p 'Local directory containing audio: ' MUSIC_SOURCE

# Quote paths with spaces. Use separate destination subfolders for separate collections.
# Preview first; remove --dry-run after reviewing. No --delete.
rsync -av --partial --progress --dry-run \
  --exclude='.DS_Store' --exclude='._*' --exclude='*.musiclibrary/' \
  "$MUSIC_SOURCE/" "$DEST:$MUSIC_DEST/"
```

The destination must exist and be writable. The trailing slash copies the contents.
Choose a simple absolute remote path without spaces or shell metacharacters.
Repeat for each audio collection, review duplicates, then scan `/data/music` in Jellyfin.
For a content verification pass, rerun with `--checksum --dry-run` (reads all files
on both ends). Do not delete laptop originals merely because the first copy finished.

## Operations and backups

Run commands from this directory, always with the same local environment file:

```bash
docker compose --env-file .env -f compose.yml ps
docker compose --env-file .env -f compose.yml logs --tail=100
docker compose --env-file .env -f compose.yml stop
```

Back up `.env` privately and back up application configuration while services are
stopped (or use an application-supported consistent backup). Back up irreplaceable
music separately; another directory on the same disk is not a backup. Cache can be
regenerated. Test restoring configuration and media before deleting old copies.

Image digests are immutable. To upgrade, back up first, review release notes, update
one digest deliberately, and recreate that service. Database upgrades may prevent
rolling back without restoring the pre-upgrade backup.

## Validation

```bash
bash -n bootstrap.sh
shellcheck bootstrap.sh
docker compose --env-file .env.example -f compose.yml config --quiet
python3 test_bootstrap.py
```

Tests use fake host/Docker commands and temporary directories; no daemon or real
media is modified. Python is only needed for these tests, not deployment.
