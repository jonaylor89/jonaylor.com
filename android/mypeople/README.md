# MyPeople for Android

Kotlin / Jetpack Compose offline address book and relationship memory. Create, edit, and merge contacts locally; reconcile causal history with CLI peers; optionally expose contacts through a MyPeople Android account. Message import and extraction still run on the Mac. See [contact replication, upgrade instructions, and current boundaries](../../docs/mypeople/contact-replication.md).

See **[Dedicated contacts app setup, migration, backup, and safety checklist](../../docs/mypeople/contacts.md)** before replacing another contacts app.

## Build

Requires Android SDK platform 37.0, JDK 25 to run Gradle, and a JDK 17 compilation toolchain. CI installs both JDKs. Locally, Android Studio's bundled Java is suitable when it is JDK 25:

```sh
cd android/mypeople # from the monorepo root
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug testDebugUnitTest
./gradlew lintDebug
```

The supplied version catalog is unchanged. `compileSdk` is 37 because its dependencies require it; `targetSdk` remains 36 and `minSdk` remains 29. A deliberate botanical light/dark palette is used consistently on Android 29+, rather than inheriting wallpaper colors.

APK: `app/build/outputs/apk/debug/app-debug.apk`.

Pushes to `main` publish signed APKs through the shared monorepo release workflow;
PRs produce debug artifacts without signing credentials. The package ID remains
`app.sherloq`. **Existing debug-signed installations need a verified backup before
switching signing certificates.** See [migration and releases](../../docs/mypeople/monorepo.md).

Python commands below run from `cli/mypeople`, not the Android directory.

## Connect

### Direct Bluetooth QR

On the Mac, run `uv run --extra bluetooth mypeople transfer qr`. In MyPeople Settings,
tap **Scan Mac QR**, scan the private QR displayed on your Mac, and tap **Sync with Mac**.
Queued edits are sent first; the Mac applies them and returns freshly published memory
and acknowledgments in the same connection. No manual reverse import is needed.
Approve normal OS Bluetooth/Nearby devices prompts. Keep the Mac awake and nearby until
import finishes; then the phone works fully offline, including photos. The in-app camera
scanner requests Camera permission explicitly and bundles its QR detector for offline use.

See [`../../docs/mypeople/bluetooth.md`](../../docs/mypeople/bluetooth.md) for encrypted file fallback, returning
queued edits, credential safety, transfer limits, and protocol details. The QR transfers the complete encrypted graph, including raw message records, full-size
assets, source originals and history. Every paired peer is trusted. See the
[graph schema and coordinated upgrade procedure](../../docs/mypeople/versioned-graph.md).

## Design system

The visual direction is a **living address book**: warm paper, botanical green, clay accents, and editorial typography. `ui/Theme.kt` owns color, type, and shape tokens. Newsreader headlines and Manrope body text are bundled for consistent offline rendering; licenses ship in `assets/licenses/`. The small, vendored AndroidX Material icon subset avoids shipping the extended icon library.

- Shared headings, connection mark, paper cards, varied initial avatars, metadata labels, and illustrated empty states live in `ui/Components.kt`.
- People has pinned search/sorting, compact rows, a draggable A–Z/# rail with a letter preview, an accessible letter chooser, and instant top/bottom jumps. Single bottom-nav taps restore position; double taps return to the root/top without reviving a person detail page.
- Home and Review keep their segmented tabs available while scrolling. Tabs become horizontally scrollable at large font sizes; content and actions reflow rather than using fixed-height cards.
- Home combines a date-led daily page with recent contacts. Upcoming uses distinct calendar accents.
- Person pages expose note/fact creation and relationship adjustments directly. Facts offer evidence and a confirmed forget action without requiring a long press.
- Suggested profiles explicitly require identity confirmation. Assessment badges are not confirmation badges, and only confirmed profiles appear on a person’s page.
- Settings puts offline storage, last sync, and queued edits before credential setup. A persistent status strip links failures and pending work to Settings, using the same top-level navigation behavior as the bottom bar.
- Native startup backgrounds and adaptive/monochrome launcher art share the app’s palette and connection mark. Standard Material ripples, navigation transitions, and animated tab colors provide restrained feedback.

## Data and sync

- `data/Logic.kt`: pure record reduction, optimistic overlays, current profile, search, date formatting, feed, moments, upcoming selection, and cursor paging.
- `data/Store.kt`, `IndexedGraphDatabase.kt`, `IndexedGraph.kt`: transactional SQLite graph authority and persistent working/contact indexes in `files/memory/indexed-graph/`. Cold startup reads materialized rows, not history or every blob. Changes, indexes and screen rows commit together before publication. [Architecture, migration and recovery](../../docs/mypeople/indexed-store.md). `StoreJournal.kt`/`StoreCheckpoint.kt` retain checksummed legacy checkpoint/journal migration and portable backups. Legacy `store.json` is migrated once and retained unchanged. A versioned computed view avoids replaying old queued merges on every cold start. A corrupt checkpoint or complete journal frame is never replaced with an empty cache.
- `data/StartupIndex.kt`: a small, source-bound, disposable contact-list index publishes real browsing rows before the full memory is restored. The navigation graph exists immediately; details and editing wait for authoritative loading. No modal “Opening memory” screen. See [startup diagnostics and storage](../../docs/mypeople/android-startup.md).
- `data/VersionedGraph.kt` / `GraphStore.kt`: authoritative immutable object/edge history, causal property alternatives, local projections, stable contact-point identity, and explicit splitting/retractable merges. All domain edits finish locally. `ContactHistory.kt` remains an upgrade adapter for retained legacy data, not the new authority.
- Portable/legacy `StoreCheckpoint.kt` version 8 streams typed graph checkpoints with durable external `GraphBlobs` inventories; versions 1–7 remain readable. Blob bytes live in `files/memory/graph-blobs/`, never a book-wide Base64 heap map. Commit/file-hash journal deltas, automatic pre-graph recovery copies and complete encrypted backups retain history and unsent work. `store.bin` alone is not a complete backup. Old queued requests remain until reconciled or explicitly recovered. Contact-card `photo_hash` references preserve original assets without decoding them for unrelated edits.
- Small card saves use structurally shared immutable reducer maps and incremental adjacency/type indexes, project affected components directly (including shared object owners), and validate only new blob bytes/references. An immutable duplicate-candidate index normalizes only changed contacts; matching rules stay identical to the compatibility reducer. Merges, splits and unsupported deltas use full projection. All indexes are disposable, never serialized graph authority. The live SQLite indexes are already durable at open; normal startup does not warm a full in-memory reducer. Legacy-only migration validates/reduces once. `LargeArchive` and `ChunkedCrypto` stream authenticated file archives/backups with raw blob entries and a typed checkpoint, avoiding a second whole graph/Base64 document. Per-decode string sharing, common immutable property-name sets and operation-backed single-version registers also bound metadata overhead. Cold checkpoints are checksum-verified and decoded from the same file inode without a checkpoint-sized byte buffer; cached long text shares strings with the authority. Journal frames mark incremental native IDs with `graph_ids_delta`; readers still accept older full-ID frames. The complete Store (checkpoint plus immutable blob directory) and encrypted file backups retain all IDs/history/blobs. Older APKs do not understand incremental-ID journal frames: do not downgrade an active store without first checkpointing it with this version.
- `StreamingGraphLoadTest` verifies 272 MiB of raw blobs through import/edit/restart/encrypted backup/fresh-process restore with a 192 MiB heap. A referenced original asset larger than the old card-size limit stays hashed through unrelated edits. `GraphCutoverTest` also checks compact photo baselines and stable Provider field UUIDs. These tests require disposable-emulator opt-ins; never run synthetic fixtures on a personal phone. Large legacy cutovers use separate preparation/verification/commit processes: [Wi-Fi/USB migration](../../docs/mypeople/bluetooth.md#large-complete-graphs-wi-fiusb-migration).
- Synthetic save regression: `GraphLargeImportTest` requires `myPeopleDisposable=true`, emulator hardware and a synthetic fixture. At 2,600 people / 329,000 messages / 192 MiB heap, the first fix reduced same-emulator saves from 2,888 ms to 716–744 ms. The structurally shared/incremental pipeline then measured 30–35 ms for the first save and a 16–19 ms median for six subsequent saves per run (13–21 ms normally). Rename/phone-add saves, including duplicate checks, normally measured 18/16–17 ms versus the previous 1,038/916 ms; quick-action note/rename saves measured 13 ms. One 125–145 ms memory-pressure outlier remained per run (blocking GC confirmed in emulator logs); it can affect either preference or identity edits. First save after a fresh-process restart measured 35–37 ms (3.5–4.0 s to authoritative readiness). Reducer append fell from ~220 ms to 1 ms; publication fell from ~360 ms to 7–11 ms. Seven preference edits wrote 7,805 journal bytes without a checkpoint. These timings are environment-dependent, not directly comparable to the earlier ~12 s run. Separate-process restart and encrypted backup/restore preserve the complete book.
- Data moves only when you scan a Mac's QR or choose an encrypted file. Nothing syncs in the background.
- Photos come only from local files received with a memory. The APK has no `INTERNET` permission, so it can't reach the network. ML Kit's dependency on Google's `datatransport` telemetry is stripped in the manifest: its permissions and its upload backend are removed, so events are dropped before they're stored. QR scanning runs on the device. `ScanWithoutNetworkTest` checks both, and any ML Kit update should be rechecked with `aapt2 dump permissions`.
- Local files and preferences are app-private; cloud backup and device transfer are disabled. Graph notes, facts, profiles, review decisions, preferences and contact edits use UUIDs and can reconcile with any peer in the same collection. Unresolved old row-ID requests remain publisher-bound until recovered.
- Relationship overrides cleared to “Automatic” can only be fully re-inferred on the Mac. The phone shows the last known value until that sync returns.

## Separate conflated contacts

On a person's More menu choose **Split into separate contact**, enter the new name,
and select exact associations. Review before moving them. Phone selection never implies
message/note ownership; message batches show the complete count/thread scope being moved.
Unselected ambiguous data stays with the original person. A stale snapshot requires reopening
and reviewing again. Original objects, evidence and previous attribution remain in history.

## Verification

`assembleDebug`, `testDebugUnitTest`, and `lintDebug` pass. The new dedicated-address-book tests and disposable-device verification are described in [Contacts](../../docs/mypeople/contacts.md). The offline transfer tests include Python↔JVM encryption compatibility, protected queues/receipts, stale/foreign snapshots, and QR validation. The Python, Kotlin and Swift suites include complete-graph cloning, conflicts, source isolation, migration/recovery, typed checkpoints, stable field identity and native split behavior. Tests cover overlays, rollback, persistence/restart, UUID retries, deletion, current profile, dates/leap years, feed, upcoming, search, origin validation, and mixed record/operation paging.

Physical Pixel 10 verification: Camera permission, in-app QR scanning, OS Bluetooth pairing,
encrypted memory/photos, and persistent offline state. Two-way sync has been exercised;
the Mac has 67 successful edit receipts and the phone’s persisted queue is empty.

Not end-to-end verified: actual call/SMS/email delivery, model-backed enrichment, destructive merge/reject/forget actions against personal data, physical Android 10 devices, or long-term background timing under Doze. Those operations use the documented payloads and the pure reducers are unit-tested. The original Android-only verification left Python unchanged; the Bluetooth transfer implementation and cross-language tests are documented in `../../docs/mypeople/bluetooth.md`.
