# Scan a QR, sync both ways over Bluetooth

No HTTP endpoint, Tailscale setup, or cloud service is needed. Your Mac temporarily
opens one temporary classic Bluetooth RFCOMM session. MyPeople on Android scans the
private QR, sends queued edits, and receives a freshly published snapshot plus edit
receipts through the same connection. No files to select or manual import command.
The raw SQLite file is not copied. The **complete versioned graph is transferred**, including
raw conversation records, full-size assets, source originals and history. Every peer is trusted.

Contact edits/merges now reconcile [local-first causal history](contact-replication.md)
rather than waiting for Mac approval. The [whole object graph](versioned-graph.md), not only
contact cards, is now authoritative. Updated peers exchange missing commits/blobs and derived
UI/inference records. Upgrade both clients and restart the Mac listener.

## Mac

```sh
uv sync --extra bluetooth
uv run --extra bluetooth mypeople transfer qr
```

A private QR image opens on the Mac. Leave the command running, keep both devices
nearby, and approve any normal OS Bluetooth access/pairing prompts. The command
prevents idle sleep during the session, but do not close the laptop lid until import
has finished. QR pairing expires after 10 minutes; `--minutes 30` changes that window.
An already authenticated transfer may finish after the pairing window closes.

The Mac re-arms its incoming listener while waiting for a connection. On newer macOS
versions, the Bluetooth API can return a notification before its asynchronous manager
is ready, silently dropping the initial registration. Re-arming also accepts pending
connections that were not delivered to the original observer. Duplicate notifications for
an already accepted native channel are ignored: reassigning its delegate or closing that
same channel can lose authentication bytes or the final acknowledgment. Protocol v3 waits
for `SHRD0003` after the delegate is installed before sending authentication. Once a socket
is open, the listener is left untouched through authentication and transfer. Short main-run-loop
slices keep callbacks, pairing expiry, and Ctrl-C responsive.

## Android

1. Open MyPeople → **Settings → Scan Mac QR**.
2. Scan the image on your Mac, review the queued-edit count, and tap **Sync with Mac**.
3. Allow **Nearby devices** access and approve OS pairing on both devices if asked.
4. MyPeople shows connecting, sending edits, Mac processing, receiving updated memory,
   importing, and final confirmation as separate stages. Wait for **Sync complete**.
   Memory and photos remain available after the Mac sleeps or leaves Bluetooth range.

The in-app CameraX scanner explicitly requests Camera permission before opening.
Its QR detector is bundled in the APK: scanning and Bluetooth transfer work without
internet or a Google Play services scanner download. If camera access was denied,
MyPeople explains how to enable it in App settings. Android 29–30 uses the normal
Bluetooth permission; Android 31+ requests Bluetooth Connect, not discovery or location
access. QR credentials are not put in Intents or logs.

The Mac prints transfer progress and reports success only after the phone acknowledges
its import. A received encrypted file is not yet an imported book. During import,
authenticated `WAIT` messages renew the Mac's two-minute **idle** timeout, bounded
by the twenty-minute total session limit. Android's local import watchdog allows
up to twenty minutes rather than closing the radio after two; final confirmation
still has a short timeout. Keepalives never acknowledge a receipt or clear edits.

If an older client says “Sent memory but the phone did not confirm import,” the
phone may have committed after its old two-minute radio deadline. Keep both
stores, update both clients, cancel the old QR session and generate a fresh QR.
Retrying joins the same UUID history; do not reset either device or force an ACK.

Native indexed imports reuse an unchanged contact view and project only affected
owners for small graph/relationship-hint deltas. They no longer eagerly rebuild
the full book for ID adoption or the obsolete outbox converter on every sync.
A production-shaped synthetic 152,547-operation book measured 19 ms for an
unchanged import, 285 ms for one hint update and 167 ms for one field update on
the disposable emulator. These are local import timings, not radio transfer
benchmarks or a guarantee for full first-time migrations. The temporary RFCOMM service and QR credentials are removed on exit. Run the
command again for a new QR. Do not share the QR or screenshots of it: it contains a
short-lived transfer capability and the private transfer passphrase.

## Edits return automatically

Each QR session uploads the encrypted outbox first. The Mac validates the complete upload,
applies operations by UUID, then builds the return snapshot from the updated database.
There is no separate reverse-transfer action. Uploading alone never clears the queue:
only receipts imported atomically with the returned memory acknowledge operations.
A lost download can safely be retried without applying an edit twice. Peer-specific replies
include receipts for that uploaded outbox, not unrelated historical operation payloads. Edits created after
the upload snapshot remain queued for the next session.

Phones no longer send model-backed requests, but one queued by an older version still applies.
The CLI runs it with the Mac’s normal configuration. `--no-enrich` defers it, the Mac app always
passes that flag so the app never calls a model, and retryable model/network failures also remain
queued. The phone reports remaining requests rather than claiming they were all applied.

### Optional manual reverse-transfer fallback

**Share queued edits** still creates an encrypted `.sherloq` file for Android’s share
sheet. Choose Bluetooth or USB if direct QR sync is unavailable. Enable macOS Bluetooth
Sharing to receive it, then:

```sh
uv run mypeople transfer import ~/Downloads/MyPeople-edits-….sherloq
uv run --extra bluetooth mypeople transfer qr
```

The return snapshot acknowledges applied/rejected edits by UUID. Exporting or sharing
an edits file never clears the phone’s queue. Reimporting the same edits on the Mac is
idempotent. `--no-enrich` defers model-backed requests instead of rejecting them; retryable
model/network failures also remain queued for a later import.

## Legacy-phone upgrade: “Unknown graph frontier”

A phone upgraded from contact-history replication does **not** activate graph storage merely
by installing a new APK. It needs a successful graph snapshot from the Mac. Until then,
its pending edits and legacy history remain authoritative locally, including the legacy
reducer's performance costs.

The Mac handoff previously validated wire-v1 `contact_heads` against native graph commit
UUIDs after translating the upload. Those are different namespaces, so valid legacy
uploads failed with “Unknown graph frontier” and never reached the graph-download step.
The compatibility receiver now validates the full legacy causal frontier against its
retained v1 receipt history **before** translation. Invalid native graph frontiers still
fail; they are not silently ignored. List translation preserves native ContactPoint UUIDs,
compares omitted legacy defaults consistently, and respects surviving addition tags.

Update/restart the Mac CLI engine, reopen MyPeople, and generate a fresh QR offer. Retry
with the existing phone store; **do not clear, reset or uninstall either side**. The first
successful handoff can take longer because it sends the full graph and acknowledges old
queued edits. The phone activates graph storage only when that snapshot is committed.
A shared synthetic Python/JVM fixture covers six pending edits, acknowledgments, graph
activation, phone-safety flags, complete message retention and restart durability.

## File fallback

```sh
uv run mypeople transfer export --send
```

This opens macOS Bluetooth File Exchange with an encrypted memory file. Receive it on
the phone, then choose **Import memory file**. Enter the transfer passphrase once from
`~/.mypeople/transfer.key` (owner-only permissions); MyPeople remembers it in app-private,
backup-excluded storage for later encrypted exports. `--password-file PATH` selects a
different shared passphrase. The QR flow supplies this automatically.

QR transfers resize the optional UI avatars to at most 384 pixels and strip unnecessary
avatar metadata. This does **not** shrink or omit authoritative graph assets: a complete
first graph transfer still includes original images/history and may need Wi-Fi or USB. The Mac caches these
avatars beside the database under `transfer-avatars/`; the phone advertises hashes it
already has, avoiding unchanged retransmission. Originals on the Mac are unchanged.
`--no-photos` omits only redundant UI avatars; complete graph assets and originals still travel.

## Large complete graphs: Wi-Fi/USB migration

A complete graph can exceed the legacy 128 MiB encrypted / 256 MiB expanded bounds.
`--no-photos` cannot fix that: it omits UI avatars, not original assets or conversations.
File exports automatically use the streamed format when graph blobs total at least 64 MiB.
Transfer the encrypted `.sherloq` file over Wi-Fi/USB and choose **Import memory file**.
Keep the phone on the updated APK; older readers reject the new format.

Streamed archives keep JSON metadata and individually hashed **raw** blobs in separate ZIP
entries. The authenticated `SHERLOQ2` envelope uses independent AES-GCM frames of at most
1 MiB, bound to their counter, length and header, plus a required authenticated terminal
frame. Truncation, reordering, trailing data, bad inventories, unsafe names, hash failures,
invalid graph references and causal failures reject the import before a Store transaction.
The total file/expanded bound is 4 GiB; metadata and individual blobs are bounded at
128 MiB. Blobs are never accumulated as one Base64 document in the phone heap.
Legacy encrypted files remain readable; Bluetooth's existing size bounds are unchanged.

For a particularly large **legacy** store, use the explicit maintenance cutover rather
than holding the old reducer and complete incoming graph in one process:

1. Close both apps. Save and verify an encrypted phone backup before changing authority.
2. Export an initialized, clean Mac graph without starting the engine or migrating its DB:
   ```sh
   uv run --project cli/mypeople python cli/mypeople/scripts/export-wifi-migration.py \
     --db "$HOME/.mypeople/mypeople.db" \
     --output "$HOME/Downloads/MyPeople-wifi-migration.sherloq" \
     --password-file "$HOME/.mypeople/transfer.key"
   ```
   The exporter opens SQLite read-only, refuses dirty/unprojected state and existing output
   paths, retains every commit/blob and receipt, and includes only small derived hints.
   Relationship hints use the same `relationships.infer` heuristic/overrides and published
   precision as normal sync; closeness/cadence/trend are calculated, not `people` columns.
   A normal Mac sync refreshes these hints after a phone-side merge.
3. The debug-only `app.mypeople.data.GraphMigration` command provides `backup`,
   `verify-backup`, `prepare`, `verify`, `commit`, and `check`. Run as the app UID, with the
   normal app stopped. Prepare the legacy context, verify the incoming archive, and commit
   in **separate VM processes**. Keep passwords/context in app-private storage, not shell
   arguments or logs; remove the temporary key, tool APK and staging files afterward.
4. Install the updated APK **in place before commit**. The maintenance command requires
   the same source/publisher, a non-stale revision and matching successful/rejected receipts
   for every pending UUID/payload. It preserves failures and preferred person IDs, archives
   the entire old Store as a referenced blob, and rechecks the source fingerprint before
   encoding and immediately before atomic checkpoint rename. Never force acknowledgments,
   reset the store, uninstall, or clear Contacts Provider to bypass a failed preflight.
5. Check a fresh process before normal use. Contact-point UUIDs, full blobs/messages and
   old causal history remain present; first-time provider reconciliation is a separate step.

Local checkpoint v8 stores durable hash inventories backed by `memory/graph-blobs/`.
**Do not copy `store.bin` alone as a backup.** Use the complete encrypted in-app backup;
its streamed ZIP contains the typed state, every raw blob and required UI photos. Old
checkpoint/archive formats remain readable. Contact cards carry `photo_hash`, so opening
or saving unrelated fields does not decode and copy original images into every card.

All large-load fixtures are wholly synthetic and emulator-only. Tests cover a 272 MiB
raw-blob import/edit/restart/backup/restore within a 192 MiB heap, a separate 2,600-person /
329,000-message graph, Python/JVM interoperability, photo lifecycle and actual Provider
UUID preservation. They must never be seeded into a personal phone.

## Safety and format

- A stable collection UUID prevents mixing address books. Separate publisher UUIDs and
  publisher-local revision counters validate incremental views without assuming a global
  master clock. Contact histories are joined across peers; switching collections/transports
  is blocked while there are unacknowledged edits.
- Canonical records, revision, pending operations, and receipts are persisted in one atomic
  phone transaction.
- Encrypted files use `SHERLOQ1`, 16-byte salt, 12-byte nonce, PBKDF2-HMAC-SHA256
  (200,000 iterations), and AES-256-GCM with the magic as authenticated associated data.
  Authenticated plaintext is a bounded ZIP containing `manifest.json`, a separate `graph.json`
  bundle, and optional content-addressed UI photos. Wrong passphrases, tampering, invalid record types, unsafe archive paths, and
  oversized files are rejected before canonical memory is replaced.
- The QR creates a random RFCOMM service UUID and a separate 192-bit capability. The phone
  authenticates before receiving an encrypted file; a bounded length and SHA-256 frame
  checksum protect the transport, followed by AES-GCM verification and source validation.
  Protocol v3 starts with `SHRD0003`, then authenticates with `SHERLOQ3 TOKEN` and uses
  the bounded `SHUP0002` encrypted upload (maximum 128 MiB), `SHBT0001` return,
  matching-digest acknowledgment, and `SHOK0002` finish. Authenticated `WAIT` lines keep
  the radio alive during durable import; they never acknowledge or clear edits. Callback
  coalescing is bounded by session size, not an assumed 64 KiB native packet size.
  Updated Android still reads v1/v2 offers; older APKs reject v3 instead of misreading it.
  Legacy v1 QRs remain download-only. Generate a fresh QR after upgrading both clients.
- On the Mac, an edit and its UUID receipt commit together, even when the underlying edit
  implementation calls `commit()`. Exporting a snapshot does not touch operation IDs.

Repeated bootstrap parent arrays use a checksummed `contact_frontiers` table in transfer
manifest format 2. Readers expand shared arrays directly, without materializing a giant
expanded JSON document. UUIDs, causal edges, list tags, and retry payloads are unchanged.
Legacy manifest/ZIP/encrypted-file limits are unchanged, and no history is truncated.
The separate streamed format above handles larger file transfers without whole-archive buffers.
Updated peers advertise `contact_wire=1`; plain format-1 transfers remain readable.

Tests cover Python↔JVM encrypted-file compatibility, queue retention/acknowledgment,
restart persistence, stale/foreign snapshots, UUID retries/collisions, transaction rollback,
QR expiry/validation, fragmented/coalesced upload frames, incomplete/corrupt uploads,
source isolation, matching digest acknowledgments, and worker-thread database access.
Listener lifecycle tests cover delayed native readiness, re-arming after a pre-auth
disconnect, preserving accepted sockets, failed refreshes, deadlines, and interruption.
The startup fix was also checked with five consecutive cold-start Mac↔Pixel connections,
each exchanging a synthetic encrypted upload, a 256 KiB snapshot, a digest acknowledgment,
and final confirmation without touching the personal database.
The physical Mac↔Pixel 10 workflow was verified with the replicated address book active,
normal app-private Store/Provider data, real encrypted uploads/returns, and both digest and
final radio confirmation. The final observed outbox was empty. Backups were saved before
in-place upgrades; no personal data was cleared or synthetic contacts inserted. A cold
instrumented run took about one minute; this is not an instantaneous-sync claim. The
explicit opt-in `BluetoothLiveSyncTest` only syncs an already-paired collection from an
app-private current offer; destructive/synthetic tests remain disposable-emulator-only.
