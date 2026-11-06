# Local-first graph replication

MyPeople now replicates the **whole versioned object graph**, not just contact cards.
See [the schema, implementation and upgrade procedure](versioned-graph.md).

Every peer is trusted and receives all history, raw messages, notes, claims, decisions,
evidence, original contact sources and full-size assets. The phone does not run import
or model jobs, but it holds their data and authors domain edits locally. A contact card
is a derived editing/export view; SQLite row IDs are never portable identities.

## Upgrade together

1. Keep a recoverable Mac database/photo backup, encrypted phone backup and vCard.
2. Quit an old Mac app or Bluetooth listener before replacing the CLI and Mac app.
3. Install the new APK in place. **Do not uninstall or clear phone app data.**
4. Open the upgraded Mac app/CLI. Before graph cutover it creates an owner-only SQLite
   backup beside the original database. Missing referenced assets refuse migration.
5. Generate a fresh QR and sync. Android retains its pre-graph checkpoint/journal and
   pending work before activation; queued legacy requests are reconciled or explicitly
   retained for recovery, never silently discarded.
6. Verify contacts and edits, then make a new encrypted full-phone backup off-device.

Original attribution destroyed by previous SQL merges cannot be reconstructed by an
upgrade. Surviving associations are marked as legacy current ownership, not certainty.

## Editing and reconciliation

- Every object, edge, operation and commit has a portable UUID.
- Commit parents describe causality; concurrent branches join without a master clock.
- Independent property edits combine. Same-property alternatives remain explicit until
  resolved; an unrelated edit does not resolve them. Clocks never choose a winner.
- Contact points have stable identities: concurrent label/number edits revise one phone.
- Lifecycle changes are reversible; concurrent edits and previous values remain in history.
- Identity links join displayed components without destroying the original owners of notes,
  facts or conversation records. Distinct-person contradictions are surfaced.
- Undo retracts merge assertions, not subsequent data. Splitting creates a new person and
  moves exact selected associations; it never guesses which note belongs to which Cameron.
- Raw messages are lossless bounded batches. Split rows explicitly state their count/thread;
  selecting a row moves that whole described batch, not an inferred subset.

## CLI and apps

```sh
pnpm mypeople contact create 'Ada' --add email=ada@example.test
pnpm mypeople contact edit 'Ada' --set organization='Example Co'
pnpm mypeople contact history 'Ada'
pnpm mypeople contact conflicts
pnpm mypeople contact associations 'Cameron'
pnpm mypeople contact split 'Cameron' --name 'Cameron B' --move ASSOCIATION_EDGE_UUID
```

Repeat `--move` for each exact phone, note, fact, profile or message-batch edge.
Both native apps offer a split selection/review screen, retain unselected ambiguous
items, and reject stale reviews. Selecting a phone never implicitly selects messages.

A second CLI joins through encrypted export/merge, not by copying a live SQLite file:

```sh
pnpm mypeople transfer export /tmp/memory.sherloq --password-file /private/shared.key
pnpm mypeople --db /path/to/empty-clone.db transfer merge /tmp/memory.sherloq --password-file /private/shared.key
```

Each clone has its own peer/publisher identity. Established foreign collections refuse
implicit joins. Explicit first pairing of an unpublished standalone phone book archives
its original history and retains a recovery copy before joining the advertised graph.

## Transport and safety

Bluetooth and encrypted files carry the same graph protocol. Known peers exchange
missing commits/blobs by acknowledged frontier; files remain self-contained. Publisher
revision counters apply only to disposable UI/inference snapshots. Receipts track legacy
request delivery, not approval of local graph edits.

An authenticated archive contains `manifest.json`, `graph.json`, and optional redundant UI
avatars. Original graph assets are never omitted by `--no-photos`. Current limits and
unimplemented features are explicit in [the architecture](versioned-graph.md#sync-backups-and-bounds).
There is no permanent-erasure/garbage-collection protocol; trash/removal retains history.

Shared Python/Kotlin/Swift fixtures and synthetic suites verify convergence, conflicts,
full-data cloning, backups, migration, stable field identity, splitting, retained queues,
foreign-source isolation, and native engine/UI behavior. Provider/load tests run only on
a fresh, explicitly opted-in disposable emulator—not a personal installation.
