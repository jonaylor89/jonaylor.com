# MyPeople's versioned object graph

## Application architecture

The CLI, Mac app and Android app use the graph as their authoritative domain model.
Contact cards are derived views for editing and export, not authoritative documents.
All peers are trusted and receive **all** graph history, original source data, raw
conversation records, evidence, decisions, full-size assets and unresolved alternatives.
There is no phone-safe privacy subset. Use encrypted files and trusted pairing only.

- **Python:** `graph.py` reduces immutable commits. `graph_runtime.py` maintains the
  SQLite query projection and records application/import/Google/extraction mutations
  through transactional dirty-row triggers and `GraphConnection.commit`. SQL row IDs
  and bridge indexes are local; graph entities and operations use portable UUIDs.
- **Mac:** the existing SwiftUI shell calls the Python engine. New split selection,
  review and stale-snapshot checks use `contact.associations` / `contact.split`.
  Swift has wire/view models, never a third mutation/reconciliation implementation.
- **Android:** `VersionedGraph.kt` and `GraphStore.kt` reduce the same protocol and
  project native `Records`. Contacts, notes, facts, review decisions, preferences,
  lifecycle and identity changes commit locally, not as requests for Mac approval.
  The original outbox is retained during upgrade; unresolved legacy requests are
  never silently discarded. The Mac still runs imports, models and inference jobs.
- Relationship scores/trends are disposable inference hints, refreshed by the Mac.
  Native graph preferences override them; clearing an override to Automatic uses
  the last published inference until the next sync.

The SQL compatibility bridge is intentional: existing importers and queries stay
usable without a second authoritative mutable database. Their changes and graph
commits share a transaction. Remote graph projection suppresses the dirty triggers.
Immutable commits/blobs, not a copied SQLite file, reconcile across peers.

## First upgrade

Update the CLI, Mac app and APK together. Quit an old Mac app/listener before replacing
its engine. Keep a separate recoverable backup, and do not uninstall the phone app.

On first upgraded CLI/Mac open, the engine uses SQLite's backup API to create an
owner-only, uniquely named `mypeople.db.pre-graph-<timestamp>-<suffix>.sqlite3` **before**
cutover. Its path is recorded in `graph_meta.pre_graph_backup`. Existing photo source
files are left intact. Graph migration is transactional; a missing referenced photo
aborts rather than claiming to preserve an incomplete collection.

Android reads older checkpoints/journals, retains pending and failed operations, and
activates graph state when it receives an upgraded snapshot (fresh standalone books
use the graph immediately). Before activation it keeps an atomic, non-overwritten
`files/memory/pre-graph-backup` containing the previous checkpoint/journal. It also
retains a recovery copy before an explicit standalone first-pairing collection join.
Use encrypted full-phone backup for off-device recovery; do not copy one cache file.

The phone and CLI retain original UUIDs and provenance. Pre-cutover SQL merges may
already have destroyed original ownership. Migration marks surviving attribution as
`legacy_current_owner`; it does not invent which Cameron owned an ambiguous note.

## Schema (wire v1)

```text
Commit
  id: UUID
  collection: UUID
  peer: UUID
  recorded_at: timezone-qualified ISO timestamp (display only)
  version: 1
  parents: Commit UUID[]
  operations: Operation[]

Operation
  id: UUID
  kind: create_object | create_edge | set_property | set_lifecycle
  target: Object/Edge UUID
  payload: typed JSON object
  replaces: Operation UUID[]

Blob
  hash: SHA-256(content)
  content: bytes
```

Commits are immutable atomic transactions. Reused UUIDs with different content,
unobserved replacements/endpoints, missing parents, cycles and missing/damaged blobs
are refused. Parents describe causality, not domain/provenance relationships.
Different-property edits combine. Concurrent versions of one property remain explicit;
a provisional UUID-selected value is display only. Resolving replaces exactly the
observed versions. Clocks never decide winners. Undo appends compensating operations.
Lifecycle is `active`, `trashed` or `retracted`, and can itself conflict; concurrent
property edits remain in history and deletion conflicts are exposed.

Object types:

```text
Person, Name, ContactPoint, Note, Claim, SourceRecord, Evidence,
Interaction, InteractionBatch, Conversation, Asset, Relationship,
RelationshipPreferences, Decision, ProcessingRun, Moment
```

Edges:

```text
has_name, has_contact_point, has_note, subject_of, has_asset, has_preferences,
same_person, distinct_person, participant, in_conversation, drawn_from,
supported_by, contradicted_by, originated_from, generated_by, targets, about
```

Edges have stable UUIDs, immutable endpoints, versioned properties and lifecycle.
Changing attribution retracts an edge and creates another, rather than rewriting the
object or its source evidence. Phone/email values are non-unique matching indexes,
not identity constraints. Derived card fields carry `object_id`, so editing a phone's
label and number concurrently revises the same ContactPoint.

SQLite authority lives in `graph_meta`, `graph_commits`, `graph_blobs`. Current SQL
rows, dirty/child/interaction indexes, search and native views are rebuildable.
Contact-card defaults are absence/display defaults, not authority to erase another
identity's information during merging. Unknown source properties and originals remain
in graph metadata/source evidence and portable exports.

### Conversation storage

Raw messages are losslessly stored in `InteractionBatch` objects: at most 256 records,
grouped by original owner, channel and thread, with stable `source_ref` for each record.
The content-addressed blob is a deterministic gzip-compressed JSON array, marked
`encoding = gzip-json`. Plain JSON batches and individual Interaction objects remain
readable. Batch properties include count, channel, thread, first/last times and original
owner; raw records omit only local SQL IDs. All bytes and previous content versions
replicate. Individual Interaction overrides can supersede a matching batch source_ref.

This keeps hundreds of thousands of raw messages out of the hot graph reducer while
retaining their complete contents. SQL projection expands only changed batches;
unrelated edits do not rewrite all conversation rows. Decoding is bounded and a
payload limit errors rather than truncates.

## Identity and splitting

Active `same_person` assertions define identity components. They never physically
coalesce graph message/fact ownership. `distinct_person` inside one component is an
explicit contradiction. A canonical UUID is deterministic; a local SQL representative
and preferred display name are not portable row identities.

Both apps expose **Split into separate contact** (Android: person's More menu; Mac:
More → Split into Separate Contact…). Enter a name and select exact association edges.
Nothing is preselected. The review describes the selected scope and remaining data;
stale heads refuse the write and require fresh review. Successful splitting creates a
new Person/Name, records distinct-person assertions, and moves only selected edges in
one local commit. The explicitly entered new name stays primary even if an old Name
association is also moved. Originals and previous edges remain in history.

Message batches are explicitly labelled with message count, channel, thread and time
range: selecting one moves that whole labelled chunk, not an inferred subset. Selecting
a phone number never silently selects messages or notes. Ambiguous unselected items
stay with the original contact for manual review. No algorithm can recover attribution
that earlier destructive SQL merges already discarded.

Retracting merge assertions separates original identities without rewinding later edits.
New post-merge data keeps its explicit attribution; it is not automatically guessed onto
a different original identity. The advanced graph workbench can inspect/retract specific
edges; app undo retracts the component's merge assertions.

## Sync, backups and bounds

The ordinary `.sherloq` archive carries a small UI/inference `manifest.json` and a separate
`graph.json` bundle `{collection, heads, commits, blobs}`. Blobs are base64 values keyed
by SHA-256. UI cards omit duplicate full photos/source originals; those are in the graph.
The existing authenticated AES-GCM/PBKDF2 envelope remains in use. `--no-photos` omits
only redundant UI avatars, never authoritative graph assets or history.

Known Bluetooth peers exchange frontier deltas; self-contained file exports include
complete history/blobs. Receipts only acknowledge old queued requests; graph heads
acknowledge graph delivery, not permission to edit. Retrying a lost reply is idempotent.
The QR advertises the graph collection separately from the transport source/publisher.
An explicit first pairing can join an unpublished standalone phone book: original
commit bytes are archived, rebased commits get new deterministic UUIDs, and a recovery
copy is retained. An established foreign collection is never silently joined.

Android checkpoints use typed binary version 7, streaming directly into an fsynced,
checksummed atomic file without duplicating the graph as a JSON tree. Incremental
journal frames retain new commits/blobs. Older checkpoint versions remain readable.
Cached reducers/views and startup indexes are disposable, not authority. Full encrypted
phone backups include graph, blobs, conflicts, unsent work and source metadata.

Current bounds: 100,000 commits, 1,000,000 operations; 128 MiB encrypted transfer,
256 MiB expanded archive/checkpoint, 32 MiB UI manifest and 256 MiB graph document
(subject to the total archive bound). Oversize collections fail explicitly; no messages,
assets or history are silently omitted. There is no unbounded/chunk-resumable transfer
or permanent-erasure/garbage-collection protocol yet. Trash/retraction is not erasure.

## Build and verification

```sh
pnpm mypeople:check
pnpm macos:mypeople:check
pnpm macos:mypeople:build
# JDK 25 runtime, JDK 17 toolchain, SDK 37.0:
(cd android/mypeople && ./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug :app:assembleDebugAndroidTest)
# Build local CLI wheel, ad-hoc signed Mac app/ZIP and debug APK after all checks:
cli/mypeople/scripts/build-installers.sh
```

Shared synthetic Python/Kotlin/Swift fixtures cover wire shapes. Tests exercise
migration/rollback/backups, native editing, concurrent values/resolution, stable field
identity, merge retraction/split, full-data cloning, encrypted round trips, rejected facts,
legacy-outbox recovery, and source/publisher isolation. Swift tests include real-engine
split/stale/delta-before-reply behavior. Native split UI, Android Contacts Provider and
restart are exercised only on a fresh opted-in disposable emulator.

A representative synthetic regression uses 2,600 people and 329,000 messages. Host
migration/rename, full encrypted export, Android import/edit, and a fresh-process restart
are measured separately. This is not a claim about real-device Bluetooth throughput.
Never run synthetic/provider tests on a personal phone or open a Mac app test against
real HOME/credentials. Builds and installers contain no personal data.
