# Android startup

The address book no longer waits behind an “Opening your memory” screen. Navigation
and search render immediately. A small local index supplies real contact rows while
full records, pending operations, and contact history restore in the background.
The index is read-only: creating/editing contacts and opening full person details wait
for authoritative state. Loading does not pretend that an existing address book is empty.

## What was slow

- Every process start decoded the entire JSON checkpoint and replayed its JSON journal.
  The phone sample had 2,455 people, 5,917 facts, 1,240 profiles, and queued legacy merges.
- Those merges were replayed over all facts/profiles again before the first useful screen.
- Navigation itself was gated on that entire operation finishing.
- Android cancellation of Contacts sync interrupted `runBlocking` outside its inner
  exception handler, crashing the whole process. Reopening then required another cold load.

The observed JSON restoration times varied considerably (including multi-second samples
while the device was dozing). Those background wall-clock times are **not foreground
launch benchmarks**. Debug APK interpretation/class loading also affects startup; the
installed Pixel build was compiled with the app-scoped Android `speed` compiler filter.

## Storage

- `files/memory/store.bin` is a versioned, checksummed, typed checkpoint of **all** records,
  history, local IDs, cursor, outbox, failed operations, notices, and source metadata.
  JSON checkpoint migration occurs once; the old `store.json` remains untouched.
- A versioned materialized view in the checkpoint avoids replaying unchanged queued merges
  or rebuilding the contact DAG merely to display the same address book on each launch.
  View-changing journal entries invalidate this cached view. Checkpoint version 3 interns
  repeated string/parent arrays; readers remain compatible with versions 1 and 2. Do not
  downgrade to a build supporting only those earlier versions after writing version 3.
- `store.journal` still commits fsynced, checksummed transactions. Checkpointing at 256
  transactions or 256 KiB bounds the cold JSON replay cost. Checkpoint rename precedes
  journal truncation, so replay of old frames after interruption is idempotent. Dense bulk
  history imports checkpoint directly, avoiding a huge intermediate JSON journal tree.
  A failed post-commit journal cleanup cannot misreport an already committed edit as lost.
- `startup.idx` contains only lightweight contact-list data: local/UUID identity, names,
  aliases, cached avatar references, pin/trash/closeness, and a short row detail. It excludes
  full notes/photos, imported originals, facts, and operation payloads. The measured phone
  index was about 300 KiB.
- The index is bound to the exact checkpoint digest and journal length/final frame digest.
  A newer transaction, collection switch, or interrupted index write invalidates it. A
  broken index is disposable; it can never replace authoritative data. If the authority
  is unreadable, a last-known index may remain visible **read-only**, with a recovery error.
- Transfers and encrypted full-phone backups retain their existing JSON-based formats.
  Back up through the app, not by copying only one checkpoint or the disposable index.
  Do not downgrade to an APK that cannot read these files.

The typed codec has explicit schema/version guards, full-model round-trip tests, integrity
checks, bounded collections/strings, and backward reading of the initial binary version.
Changing persistent model fields requires updating the codec and its migration/tests.

## Cancellation

`ContactsSyncTask.kt` catches interruption around `runBlocking`, not only inside its
coroutine. Normal Android cancellation preserves the interrupted status without reporting
an IO/authentication failure or terminating the app. Other auth/IO errors retain their
normal SyncResult reporting.

## Verification

- JVM tests pass, including every persisted field, null/Unicode/large strings, arbitrary
  JSON values, migration, stale/corrupt indexes, outbox preservation, projection invalidation,
  old checkpoint replay, and an interrupted sync thread with no uncaught exception.
- A private copy of the phone's real cache round-tripped exactly; diagnostics print only
  counts/times, never contact or operation contents. No personal fixtures are committed.
- `StartupNavigationTest` passed on an isolated Android 35 emulator with 3,000 synthetic
  contacts and 7,000 facts: navigation/search exist before opening storage; valid cached
  rows remain read-only when authoritative checksums fail; repairing/reopening storage
  preserves the selected Settings tab and restores all records.
- The installed Pixel 10 published its lightweight address book after **368 ms** in a
  process-cold diagnostic run. The device was dozing/locked, so this is the index-availability
  measurement, **not** an on-screen time-to-first/full-display claim. Full memory restoration
  is independent and can take longer in the background.
- `MyPeopleStartup` logs debug-only numeric timings (`address_book`, `disk`, `projection`,
  `content`, plus `history_validate/order/merges/reduce` when constructing history).
  `MyPeopleBluetooth` separately reports secret-free preparation/decrypt/archive/commit
  timings in debug builds. `reportFullyDrawn()` reports authoritative content readiness separately from
  the initial navigation/contact-list frame. No records, URLs, credentials, or messages log.

Each phone update was installed in place, without clearing app data, after saving a private
pre-upgrade backup including the latest unsynced operations. Physical full-display timings
must be measured while the phone is awake and unlocked.
