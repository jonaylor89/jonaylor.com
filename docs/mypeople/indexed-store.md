# Android persistent working index

Native Android graphs use `files/memory/indexed-graph/graph.sqlite` with WAL and
`synchronous=FULL`. This is the transactional live store, **not** a list preview
and not an in-memory cache that must be reconstructed on each launch.

## Authority and working rows

- `commits` and `operations` retain the complete graph history, UUIDs, ancestry,
  operation order, payloads and replacement tags. Nothing is compacted away.
- `entities` indexes objects/edges by type, outgoing owner and incoming target.
- `registers` indexes live alternatives by entity/property. Birth/death sequence
  bounds preserve immutable historical snapshots and conflicts.
- `components` persists identity groups. Merges/splits update their working rows;
  contact projections invalidate the old and new affected owners, not the book.
- `blob_catalog` retains every raw hash; `blob_references` records causal ownership.
  Immutable bytes remain in `memory/graph-blobs/`. Opening the app does not read
  or hash the whole blob directory. Imports, exports and Base64 asset reads verify
  hashes; image previews use the app-private immutable files directly.
- `screen` stores version-bounded derived/person/event/profile/moment rows.
  `person_fast` is a rebuildable typed row cache so normal startup avoids JSON
  parsing of every contact. Events/profiles are read lazily in bounded pages.
  Person pages use the existing `screen_owner` index and version bounds to load
  only that person's rows on `Dispatchers.IO`; the contact header renders without
  waiting for notes/links. Never filter the entire SQL-backed map in composition
  or compare lazy record maps as Compose effect keys.
- Duplicate matching keys are persisted. Their rules and explicit exclusions are
  unchanged; unrelated edits do not renormalize every contact.

Graph changes, register/identity indexes, outbox/metadata, derived rows and screen
updates commit together. The Store publishes its new state **after COMMIT**, and
Save returns only after that FULL-sync commit. Errors roll back the transaction
and keep the previous visible version. Read snapshots cannot mutate the database.

Routine graph sync adopts IDs only for previously unseen people. The legacy
outbox adoption view is lazy, unchanged derived records/queues retain their
identity, and unchanged authority reuses the published view. Small graph and
relationship-hint deltas project only affected owners (including review targets).
Commit collision, ancestry, blob and source checks remain in place. Received
frontiers, receipts and sync metadata still commit before import acknowledgment.

New blobs are hash-checked, atomically placed and fsynced before their references
commit. Original history/blobs remain authoritative and complete; indexes and
screen rows do not replace or discard them. Old snapshots use sequence-bounded
register/view rows rather than accidentally observing later edits during backup.

## Fact rows and targeted maintenance

Empty contact-note and birthday/organization/title registers intentionally exist
for peer conflict tracking. They are not facts with erased text: Android excludes
blank event rows when projecting and when reading older materialized rows.
Saving contact scalars reads/updates only claims asserted by `contact_card` or
`legacy_contact_card`, never independent inferred facts with the same predicate.

Debug-only `FactAudit` opens SQLite READONLY and compares aggregate display,
graph and hash-verified source-original counts without printing contact payloads.
`FactRepairMaintenance` previews only the old save bug's paired retractions:
an active source-event claim's attribution was retracted in the same commit as
the same owner's matching card-scalar attribution. Rejected/forgotten facts,
self contacts, attribution-lifecycle conflicts and unrelated explicit retractions
are not restored.
Apply requires an exact-frontier preview token, verifies a complete encrypted
backup first, then restores only those edge lifecycles in one Store transaction.
Prior history and fact text remain unchanged.

`PhoneDuplicateMaintenance` previews within-card duplicates, not duplicate people.
Equivalence retains countries, leading zeroes, extensions and uncertain-region
boundaries. Cleanup retracts redundant phone links and combines necessary
label/default metadata only; it does not resave whole cards. Offline conflicts,
incompatible structured metadata and shared metadata changes are left alone.
Every contact's edit uses Store transactions and version checks.

These operator commands require stopping the app and explicitly preparing the
same app-private `cache/index-maintenance` marker as indexed maintenance.
Normal loading and scheduled Contacts sync stay paused while it exists. Always
remove the marker and restart normal app mode after maintenance. Complete,
verified encrypted backups, private keys, plans and progress are retained under
app-private `files/maintenance-recovery/`; never copy them into the repo or log
their keys. On large books, backup verification can take several minutes; a host
timeout is not evidence that the operation rolled back. Check its result and
audit the durable Store before considering another apply.

## Migration and recovery

Existing checkpoint-v1–v8/journal stores remain readable. Conversion is one-time:
validate/reduce the old graph, populate a temporary SQLite directory, compare a
streamed SHA-256 of the complete ordered authority, compare projections, blob
inventory, IDs, peer/frontier metadata and pending work, then publish the committed
directory with an atomic rename and directory fsync. Original checkpoint/journal
files are retained in a `pre-index-*` recovery copy. Blob bytes are not rewritten.
An interrupted conversion never publishes an incomplete index or an empty book.
A published but unreadable database fails closed; it must not silently fall back
to a stale pre-index store. Do not downgrade an indexed store to an older APK.

Complete encrypted file backups still carry portable typed state, all history,
raw blobs and required UI photos. They restore into a fresh store/index. **Do not
copy a running SQLite file alone**: its WAL may contain committed changes. Use
the encrypted backup/export API. Do not clear/uninstall/restore over a live book
as a performance workaround.

Debug-only `IndexedMaintenance` is operator instrumentation, not a fixture/test
runner. With the normal app stopped and an app-private `cache/index-maintenance`
marker explicitly prepared, its `index`, `check`, `backup` and `verify-backup`
commands operate only on the existing real store and print aggregate diagnostics.
The marker suppresses normal auto-loading/provider reconciliation during explicit
maintenance. Remove it before normal use. Keys remain app-private and temporary;
never pass their contents in command arguments or logs.

## Verification

- The same SQL reducer is tested against the immutable reference reducer after
  every shared-fixture commit and restart, including conflicts/deletion, stale
  snapshots and complete rollback. Indexed opening must not select operation
  payloads, property registers or blob bytes.
- Disposable-emulator tests use a wholly synthetic production-shaped book:
  152,547 operations, 37,461 blobs, ~57 MB metadata and ~497 MB raw data. Cold
  readiness, durable edits, merges and a second process are measured with a
  192 MiB heap. This fixture must never be installed on a personal device.
- Indexed sync regression checks the 152,547-operation synthetic book across an
  unchanged response, one relationship hint, one field delta and restart. Each
  import must stay under one second without altering unrelated people/history.
- Owner-query regression tests verify bounded decoding, actual query plans,
  historical ownership, projection exclusions and in-memory compatibility. A
  40,053-row synthetic Compose test, including empty placeholders, rejects unscoped/main-thread detail reads
  and checks refresh and person switching without leaking another person's rows.
- Additional emulator checks cover 329,000 messages, 272 MiB streaming blobs,
  encrypted backup/fresh restore, actual Provider field UUIDs, photo lifecycle
  and unverified legacy numbers. Native frame/operation timing logs contain only
  stage names/durations, never person IDs, names, contact content or payloads.

## Python CLI index

The Python engine keeps the same kind of index in the main database, so no command replays the
whole history to answer a question about one contact. `graph_index.py` owns it:

- `graph_index_commits`, `graph_index_entities`, `graph_index_operations` and
  `graph_index_registers` hold the reduced graph: commit rank and ancestry, objects and edges by
  owner and target, which commit wrote each operation, and the live alternatives of every
  property. `graph_index_affected` remembers which people each commit involves, for history.
- `graph_commits` stays the authority. Every write updates the index in the same transaction,
  through `IndexedGraph`, which runs the reducer's own `_apply` rules against SQL. Commits that
  extend the current heads are cheap; others rerank the order. More than `BULK` new commits at
  once, as in a first transfer, rebuild the index from an in-memory replay instead.
- `graph_index_meta` records the format, the number of commits and the highest `graph_commits`
  rowid seen. Commits written by a CLI that predates the index are applied on the next open; a
  missing or different format rebuilds it. A database that can't be written (read-only, or
  locked by another writer) is replayed in memory, as before.
- A graph object read earlier keeps its own view: when another write bumps the connection's
  generation, its next read replays up to its own commit sequence.
- `projected` is the sequence up to which the SQL compatibility rows reflect the graph.
  `graph_runtime.project` rebuilds only the contacts touched since then, widened to everyone
  who shared a contact with them before or after and everyone competing for the same globally
  unique identifier or moment key. If it meets anything it can't place, it rebuilds everything.
  The engine builds the index and the watermark before its first request
  (`graph_runtime.warm`), so the first edit after an upgrade doesn't pay for it.

`MYPEOPLE_GRAPH_VERIFY=1` checks every index write against a full replay, and every partial
projection against a full one run in a savepoint that is then rolled back. The test suite turns
it on for every test (`tests/conftest.py`); `tests/test_graph_index.py` covers catch-up, format
rebuilds, stale views and partial projections.
