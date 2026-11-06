# Versioned object graph

## Status: foundation implemented, application cutover NOT complete

This is the approved replacement architecture, being implemented in separate,
verifiable slices. **The installed Mac app, Android app, importers, Google sync,
and ordinary CLI commands still use the existing storage/replication model.**
Passing their regression suites does not mean they have switched to the graph.
Do not deploy this as the completed overhaul or migrate a personal installation yet.
No personal database was opened during implementation.

Implemented:

- Python immutable commit DAG, stable object/edge UUIDs, explicit property-version
  replacement, concurrent alternatives, lifecycle/deletion conflicts, and identity
  components with contradictory same/distinct-person assertions surfaced.
- SQLite persistence with nested savepoint transactions, collision checks, verified
  content-addressed blobs, collection isolation, and a separate UUID for each peer.
- A split operation that moves explicitly selected attribution edges atomically,
  preserves original objects/evidence/history, and returns unselected associations
  for human review. No automatic message attribution guesses.
- Full encrypted file export/import, clone/diverge/reconcile, and retry idempotence.
  All commits and blobs travel, not a phone-safe subset. There is no `--no-photos`
  shortcut that can silently produce an incomplete graph archive.
- Explicit read-only migration into a **separate empty database**, with original
  domain rows and legacy contact changes retained as source records. The migration
  preserves the current state; legacy causal history is archived, not translated
  into native graph operations. Missing referenced photos abort the migration.
- Matching Kotlin reducer/split planner and Swift wire models. A synthetic fixture
  is shared by Python, Kotlin, and Swift. Swift does not implement domain rules.

Not implemented yet:

1. Required-property/type validation for each domain object, source-key uniqueness
   and deterministic import deduplication, and processing-run scheduling semantics.
2. Persisted/indexed projections and incremental reduction. Current foundation
   replays history in memory; no real-address-book scalability claim is made.
3. Graph-backed contact export projection, Google mapping, and Android Provider mapping.
4. Replacing ordinary CLI/import/extraction writes with graph commits. The workbench
   is NOT an automatic dual-write bridge; legacy changes made after migration do
   not magically appear in that graph.
5. Graph RPC/view integration in the Mac engine, and native split/review UI.
6. Android graph persistence/checkpoint recovery, view/editor integration, and
   split/review UI. `VersionedGraph` is not yet connected to `Store`.
7. Full-data Bluetooth/HTTPS transport, delta inventories, chunked blob transfer,
   and Android graph backups. Existing transports still carry the legacy format.
8. Disposable-device acceptance tests, representative synthetic load tests, and
   a final migration/cutover/rollback procedure for the existing installation.

There is no requirement to keep old protocol versions working after the coordinated
cutover. Keeping the old applications operational **during development** is not a
commitment to permanent backwards compatibility.

## Authority and wire schema (v1)

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
  payload: JSON object
  replaces: Operation UUID[]

Blob
  hash: SHA-256(content)
  content: bytes
```

Commits are immutable and atomic. A reused commit UUID must name exactly the same
content. Operation UUIDs cannot be reused, even in another commit. Every referenced
entity/replaced version must be causally observed (or created earlier in the same
commit). Parents are causal links, not domain/provenance edges. Clocks never choose
winners. Every peer receives everything, including old values, source originals,
messages, and evidence. Peers are trusted; encryption is still required in transit.

Payloads:

```json
{"type":"ContactPoint","properties":{"kind":"phone","value":"+12025550101"}}
{"type":"has_contact_point","from":"PERSON_UUID","to":"PHONE_UUID","properties":{}}
{"property":"label","value":"work"}
{"value":"retracted"}
```

The first two payloads create an object/edge. Creation also establishes an active
lifecycle version. The last two set a property or lifecycle. Replacement IDs refer
to versions of that *same target and property*. Unobserved/concurrent alternatives
are never implicitly replaced. A JSON `null` can explicitly clear a property.

Object and edge creation cannot be undone by recycling their UUID. Lifecycle is
`active`, `trashed`, or `retracted`, and can itself conflict. Concurrent deletion and
property edits remain in history and are exposed as a deletion conflict. Restoring
is another operation, not history rewriting. A provisional scalar value is selected
by operation UUID for deterministic display, and is never itself user confirmation.

SQLite authority is just `graph_meta`, `graph_commits`, and `graph_blobs`. Current
entities, edges, property alternatives, and identity components are rebuildable.
Separate persisted projection/index tables will follow before application cutover.

## Domain

Object types:

```text
Person, Name, ContactPoint, Note, Claim, SourceRecord, Evidence,
Interaction, Conversation, Asset, Relationship, RelationshipPreferences,
Decision, ProcessingRun, Moment
```

A contact card is deliberately **not** an authoritative object. It will be an export
projection over names, contact points, accepted claims, preferences, and photos.
Shared phone numbers/emails are valid; normalized values must not imply one owner.

Domain/provenance edge types:

```text
has_name, has_contact_point, has_note, subject_of, has_asset, has_preferences,
same_person, distinct_person, participant, in_conversation, drawn_from,
supported_by, contradicted_by, originated_from, generated_by, targets, about
```

Edges have stable IDs, immutable endpoints, versioned properties, and lifecycle.
Changing attribution retracts the old edge and creates a new edge. An independent
`originated_from` edge continues to identify the original evidence/source record.
A decision can carry an exact operation reference when it applies only to a version.

Active `same_person` edges define identity components. They never rewrite message,
fact, or source ownership. Retracting one link only separates identities if no
other path still connects them. `distinct_person` inside one component is an
explicit contradiction, not a reason to silently discard either assertion.

### Two Camerons

`split(person, new_name, selected_edge_ids)` creates a new Person/Name, records a
`distinct_person` edge, retracts selected associations, and creates corresponding
associations to the new person in one commit. The exact phone/message/note/fact
edges must be selected. Unselected associations are returned as a review list;
they remain on the old identity until a person makes a decision. This list is not
yet a persisted review queue or a native screen.

Legacy migration marks ownership `legacy_current_owner`. It does not invent
pre-merge attribution that was destroyed by old SQL merges. Retained thread/source
identifiers can assist a later manual split; uncertain items cannot be auto-repaired.

## Workbench (synthetic data only during development)

Run from the repo root with explicit paths. The normal CLI does not open its default
DB for these commands, and the workbench refuses a legacy application DB as its store.

```sh
pnpm mypeople graph --store /tmp/synthetic-graph.db init
pnpm mypeople graph --store /tmp/synthetic-graph.db create Person
pnpm mypeople graph --store /tmp/synthetic-graph.db status
pnpm mypeople graph --store /tmp/synthetic-graph.db show PERSON_UUID
pnpm mypeople graph --store /tmp/synthetic-graph.db split PERSON_UUID \
  --name 'Cameron B' --move PHONE_EDGE_UUID --move MESSAGE_PARTICIPANT_EDGE_UUID
```

Migration and full encrypted file reconciliation:

```sh
pnpm mypeople graph --store /tmp/synthetic-graph.db migrate --source /tmp/synthetic-legacy.db
pnpm mypeople graph --store /tmp/synthetic-graph.db export /tmp/synthetic.graph \
  --password-file /tmp/synthetic-passphrase
pnpm mypeople graph --store /tmp/synthetic-clone.db import /tmp/synthetic.graph \
  --password-file /tmp/synthetic-passphrase --adopt
```

Use a fresh destination for migration, not the initialized/edited example above.
`--adopt` only allows joining an empty store to the archive's collection. A clone
gets its own peer UUID; never clone a live SQLite file and reuse its peer identity.

Archives are authenticated AES-GCM using the existing transfer encryption envelope,
with a separate `graph.json` plus `blobs/<sha256>` ZIP layout. They are intentionally
not readable as legacy phone-safe snapshots. Foreign collections, missing parents,
invalid frontiers, damaged/missing referenced blobs, path tricks, and duplicate ZIP
entries are refused before graph writes. Full archives currently have the existing
128 MiB encrypted / 256 MiB expanded limits and a 128 MiB manifest limit; larger
collections need the upcoming chunked transport, not silent omission.

Trash/retraction is not erasure. History retains prior identifying data. Permanent
erasure across trusted peers and backups needs a separate explicit design.

## Verification

- `pnpm mypeople:check`
- `pnpm macos:mypeople:check`
- `pnpm macos:mypeople:build`
- From `android/mypeople`, with JDK 25 and SDK 37.0:
  `./gradlew :app:testDebugUnitTest :app:lintDebug :app:assembleDebug`

No personal databases, credentials, live import sources, installed app instances,
or real Android Contacts Provider are needed by the new tests.
