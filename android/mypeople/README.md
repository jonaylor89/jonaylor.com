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

### Direct Bluetooth QR (no server)

On the Mac, run `uv run --extra bluetooth mypeople transfer qr`. In MyPeople Settings,
tap **Scan Mac QR**, scan the private QR displayed on your Mac, and tap **Sync with Mac**.
Queued edits are sent first; the Mac applies them and returns freshly published memory
and acknowledgments in the same connection. No manual reverse import is needed.
Approve normal OS Bluetooth/Nearby devices prompts. Keep the Mac awake and nearby until
import finishes; then the phone works fully offline, including photos. The in-app camera
scanner requests Camera permission explicitly and bundles its QR detector for offline use.

See [`../../docs/mypeople/bluetooth.md`](../../docs/mypeople/bluetooth.md) for encrypted file fallback, returning
queued edits, credential safety, transfer limits, and protocol details. The QR transfers
only the published phone-safe view, never the raw database or message history.

### Optional HTTPS server

1. Run the Python sync server on your own host. Expose it with HTTPS, for example using Tailscale Serve.
2. Add a **phone-role** device with `mypeople server add-device pixel --role phone`.
3. Enter the HTTPS origin and that device's token in Settings, then save.
4. Sync the Mac to publish records and apply queued edits. Enrichment operations require the Mac's normal sync, not `--no-enrich`.

For local emulator development only, the existing network security configuration permits `http://10.0.2.2:8765`. All other origins require HTTPS. Redirects are deliberately not followed; configure the final server origin.

Example local setup (use a test copy of your database):

```sh
uv run mypeople server run --data /tmp/mypeople-srv
# In another terminal:
uv run mypeople server add-device mac --role mac --data /tmp/mypeople-srv
export MYPEOPLE_SYNC_CONFIG=/tmp/mypeople-test-sync.json
uv run mypeople --db /path/to/test-copy.db sync setup http://127.0.0.1:8765 '<mac token>'
uv run mypeople --db /path/to/test-copy.db sync --no-enrich
uv run mypeople server add-device pixel --role phone --data /tmp/mypeople-srv
```

## Design system

The visual direction is a **living address book**: warm paper, botanical green, clay accents, and editorial typography. `ui/Theme.kt` owns color, type, and shape tokens. Newsreader headlines and Manrope body text are bundled for consistent offline rendering; licenses ship in `assets/licenses/`. The small, vendored AndroidX Material icon subset avoids shipping the extended icon library.

- Shared headings, connection mark, paper cards, varied initial avatars, metadata labels, and illustrated empty states live in `ui/Components.kt`.
- People has pinned search/sorting, compact rows, a draggable A–Z/# rail with a letter preview, an accessible letter chooser, and instant top/bottom jumps. Single bottom-nav taps restore position; double taps return to the root/top without reviving a person detail page.
- Home and Review keep their segmented tabs available while scrolling. Tabs become horizontally scrollable at large font sizes; content and actions reflow rather than using fixed-height cards.
- Home combines a date-led daily page with recent contacts. Feed preserves source/date attribution; Upcoming uses distinct calendar accents.
- Person pages expose note/fact creation and relationship adjustments directly. Facts offer evidence and a confirmed forget action without requiring a long press.
- Suggested profiles explicitly require identity confirmation. Assessment badges are not confirmation badges, and only confirmed profiles appear on a person’s page.
- Settings puts offline storage, last sync, and queued edits before credential setup. A persistent status strip links failures and pending work to Settings, using the same top-level navigation behavior as the bottom bar.
- Native startup backgrounds and adaptive/monochrome launcher art share the app’s palette and connection mark. Standard Material ripples, navigation transitions, and animated tab colors provide restrained feedback.

## Data and sync

- `data/Logic.kt`: pure record reduction, optimistic overlays, current profile, search, date formatting, feed, moments, upcoming selection, and cursor paging.
- `data/Store.kt`, `StoreJournal.kt`, `StoreCheckpoint.kt`: cached `StateFlow` backed by checksummed, fsynced transactions and typed `files/memory/store.bin` checkpoints. Legacy `store.json` is migrated once and retained unchanged. A versioned computed view avoids replaying old queued merges on every cold start. A corrupt checkpoint or complete journal frame is never replaced with an empty cache.
- `data/StartupIndex.kt`: a small, source-bound, disposable contact-list index publishes real browsing rows before the full memory is restored. The navigation graph exists immediately; details and editing wait for authoritative loading. No modal “Opening memory” screen. See [startup diagnostics and storage](../../docs/mypeople/android-startup.md).
- `data/ContactHistory.kt`: causal contact DAG, observed-remove fields, multi-value scalar conflicts, UUID identity links, and local projections. Contact changes are authoritative locally; receipts acknowledge delivery, not approval. New contacts can merge before their first sync. `ContactMirror.kt` journals the Android Provider baseline per changed contact.
- Contact history persists independently of pending delivery receipts. Non-contact requests retain the legacy optimistic outbox behavior, including failure recovery. All queued operations have UUIDs and are durable before becoming visible. Lost replies can safely be retried.
- Sync runs on foreground resume, 650 ms after edits, manually from Settings, and in a network-constrained, unique 15-minute WorkManager task. Android can defer background work in Doze.
- The Coil loader uses the API's authenticated OkHttp client, with a 100 MiB disk cache. Credentials are sent only to the exact configured origin. No request/record logging is installed.
- Local files and preferences are app-private; cloud backup and device transfer are disabled. Changing server or device credentials resets the cached view, but is blocked while edits remain pending so they cannot be sent to another account or lost.
- Relationship overrides cleared to “Automatic” can only be fully re-inferred on the Mac. The phone shows the last known value until that sync returns.

## Verification

`assembleDebug`, `testDebugUnitTest` (55 tests), and `lintDebug` pass. The new dedicated-address-book tests and disposable-device verification are described in [Contacts](../../docs/mypeople/contacts.md). The offline transfer tests include Python↔JVM encryption compatibility, protected queues/receipts, stale/foreign snapshots, and QR validation. The full Python suite passes (471 tests, 4 skipped), including the existing sync suite. Tests cover overlays, rollback, persistence/restart, UUID retries, deletion, current profile, dates/leap years, feed, upcoming, search, origin validation, and mixed record/operation paging.

Manual emulator verification against the real local HTTP server and the supplied test database:

- Android 35 and Android 37: installed, launched, and pulled **9,098 records**, including a multi-page initial sync.
- Android 35: navigated Home's three tabs, People, Person, Review's two tabs, and Settings. No app crash. Checked light/dark mode; Android 37 also visually checked in dark mode.
- Authenticated photos downloaded into Coil's disk cache and rendered on Android 37.
- Added a nickname through the phone UI; the Mac's `sync --no-enrich` applied it to the test database. Resuming the phone pulled the canonical record and cleared its outbox. Removed the verification nickname through the same phone → Mac → phone round trip.
- WorkManager registered a network-constrained job with a 15-minute interval. Its initial execution completed successfully.
- Design pass on visible Android 37: Home/Feed/Upcoming, People, Person, duplicate comparison, profile-review empty state, Settings, note/relationship editors, and evidence dialogs checked in light and dark themes. Checked no-result search, 2× system text, pinned/scrollable tabs, and returning from sync status to People. No destructive actions or new edits were submitted for visual testing.
- With airplane mode enabled, saved pages remained browsable and the sync failure banner/detail appeared. Restoring connectivity and foregrounding the app recovered sync without changing credentials or clearing the outbox. Restored normal text size and left the updated app open. Personal screenshots were kept outside the repository.

Physical Pixel 10 verification: Camera permission, in-app QR scanning, OS Bluetooth pairing,
encrypted memory/photos, and persistent offline state. Two-way sync has been exercised;
the Mac has 67 successful edit receipts and the phone’s persisted queue is empty.

Not end-to-end verified: a real Tailscale HTTPS deployment, actual call/SMS/email delivery, model-backed enrichment, destructive merge/reject/forget actions against personal data, physical Android 10 devices, or long-term background timing under Doze. Those operations use the documented payloads and the pure reducers are unit-tested. The original Android-only verification left Python unchanged; the Bluetooth transfer implementation and cross-language tests are documented in `../../docs/mypeople/bluetooth.md`.
