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

New blobs are hash-checked, atomically placed and fsynced before their references
commit. Original history/blobs remain authoritative and complete; indexes and
screen rows do not replace or discard them. Old snapshots use sequence-bounded
register/view rows rather than accidentally observing later edits during backup.

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
- Owner-query regression tests verify bounded decoding, actual query plans,
  historical ownership, projection exclusions and in-memory compatibility. A
  40,003-row synthetic Compose test rejects unscoped/main-thread detail reads
  and checks refresh and person switching without leaking another person's rows.
- Additional emulator checks cover 329,000 messages, 272 MiB streaming blobs,
  encrypted backup/fresh restore, actual Provider field UUIDs, photo lifecycle
  and unverified legacy numbers. Native frame/operation timing logs contain only
  stage names/durations, never person IDs, names, contact content or payloads.
