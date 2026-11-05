# Local-first contact history

Contacts now have a replicated causal history, shared by the Python CLI and Android.
The Mac is no longer the authority that approves **contact-card edits, trash/restore,
renames, or identity merges**. These finish durably on the device where you make them.
A freshly installed phone can create and merge contacts before pairing with anything.

This is not Git embedded in the app. It is an immutable change DAG with domain-specific
reconciliation and a materialized address book. Bluetooth, encrypted files, and the
optional HTTPS relay transport the same contact changes.

## Upgrade safely

1. Export a vCard, make an encrypted phone backup, and back up the CLI database/photos.
2. Update **both** the Python package and APK. Restart an already-running Bluetooth
   listener/server-side CLI sync process so it loads the new protocol.
3. Sync once. The CLI journals its existing contact cards and legacy redirect UUIDs.
   The phone imports this history without discarding its pending edits. Terminal legacy
   contact-save receipts still protect cards until publication; unresolved legacy
   contact operations must finish before the existing address book switches modes.
4. Settings explains when contact changes are local and complete rather than awaiting
   Mac approval. Old snapshots cannot downgrade an already replicated address book.

Old `store.json` is migrated once to a typed, checksummed `store.bin`, retaining the old
file unchanged. `contacts-mirror.json` remains the Provider baseline checkpoint. Do not
downgrade to an APK that cannot read the binary checkpoint/journals. Length-framed
`.journal` files hold fsynced transactions; periodic atomic checkpoints bound replay.
A disposable `startup.idx` lets the contact list appear before full restoration; it is
never edit/backup authority. See [startup storage and diagnostics](android-startup.md). An incomplete final append is recoverable;
a damaged complete transaction or checkpoint is an error, never an empty address book.
Do not copy only `store.json` as a backup: it no longer necessarily contains the latest
state. Use **encrypted phone backup**, which includes the complete logical state.

## Reconciliation rules

- All contact identities and changes use UUIDs, independently of device-local integer IDs.
- A change names its causal parents, changed scalar fields, observed scalar versions it
  replaces, tagged list additions/removals, and any identity links.
- Independent changes to different fields combine. Concurrent additions of different
  phone/email/address fields are retained. Removing a field removes only the addition
  tags actually observed, so a concurrent new addition is not silently deleted.
- Defaults on a newly created identity are absence, not writes that can erase another
  contact's information during a later merge. Lists are sets of complete field values,
  including labels/preference/country; they are not ordered collaborative text.
- Independent edits of the **same scalar** keep all causally maximal alternatives.
  Every device displays the same deterministic UUID-selected provisional value, with
  an explicit conflict indicator. Device clock skew cannot decide whose edit wins.
- On Android, open the contact to choose a version under **Two versions, safely kept**.
  Merely editing an unrelated field does not resolve a conflict. Provider export of a
  conflicted contact pauses rather than writing an arbitrary choice to Android Contacts.
- Trash is reversible. Concurrent edits of other fields remain in history while the
  contact is trashed. Concurrent trash/restore choices preserve both scalar alternatives.
- Identity links are transitive: independently merging A+B and B+C converges to one
  identity. Edits addressed to an original member still contribute after merging.
  The displayed identity UUID is the lexicographic minimum of the member UUIDs, not
  the Mac's choice of integer ID or the device with the most message history.
- Merging explicitly resolves known scalar differences using the selected contact cards;
  truly concurrent unseen edits remain conflicts. Original changes and list tags remain.
- Initially marked self-records are not seeded. Marking an already-shared person as you
  hides that identity on peers; it does not erase previously shared historical data.

## CLI

```sh
uv run mypeople contact create "Ada" --add email=ada@example.test
uv run mypeople contact edit "Ada" --set organization="Example Co" --set notes="Met in Berlin"
uv run mypeople contact edit "Ada" --add phone=+4930123456
uv run mypeople contact edit "Ada" --remove email=ada@example.test
uv run mypeople contact trash "Ada"
uv run mypeople contact restore "Ada"
uv run mypeople merge "Ada" "Ada duplicate"
uv run mypeople contact history "Ada"
uv run mypeople contact conflicts                # optional PERSON limits the list
uv run mypeople contact resolve "Ada" notes CHANGE_UUID
```

`contact edit --card PATH` accepts a complete contact-card JSON file for structured
names, labelled fields, photos, and other rich data. `--set favorite=true` and other
boolean fields take `true`/`false`. `rename` and interactive duplicate merges also
record contact history. Existing importers/legacy SQL writes are captured as patches
**before** remote history is received, so an offline CLI edit does not become a false
post-sync overwrite of a phone edit.

A second CLI can join the same address book without copying SQLite IDs or message data:

```sh
# First CLI: encrypted full memory/contact-history export.
uv run mypeople transfer export /tmp/memory.sherloq --password-file /private/shared.key
# Second CLI: must be empty, or already belong to this same collection.
uv run mypeople --db /path/to/second.db transfer merge /tmp/memory.sherloq --password-file /private/shared.key
```

Both CLIs may then edit offline, export memory files, and `transfer merge` each other's
files in either order. The shared key is private and must be provided independently;
it is not inside an export. An existing unrelated database is refused, not silently
joined. Clone this way rather than copying a live database and its publisher identity.

## Bluetooth and relay sync

The QR still uses encrypted RFCOMM upload/response frames. With updated peers it adds:

- a collection UUID (which address book) **and a publisher UUID** (which peer's derived
  snapshot). Each publisher has its own revision counter; there is no global master clock;
- exchange of changes missing from the peer's last acknowledged causal frontier;
- record-hash inventories, so the return view contains only changed records/deletions;
- photo-hash inventories and cached 384px avatars, avoiding unchanged photo retransmission
  and repeated image resizing. Originals remain unchanged;
- an explicit base revision/publisher check for incremental views. A different publisher
  sends a fresh derived view, while contact histories are joined, never replaced.

A new publisher gets full contact history on its first exchange. Portable edit-file
fallbacks include full history, so they can reach any peer in the same collection.
Repeated parent frontiers are interned losslessly on the wire (`contact_wire=1`, manifest
format 2), retaining all UUIDs/causal edges and exact retry payloads. Plain format 1 stays
readable; update both clients before exchanging format 2. Graph walks expand shared
frontiers once instead of repeatedly traversing the same dense bootstrap edges.
Large compacted histories exceeding the existing 8 MiB Bluetooth upload limit need the encrypted
file fallback. Full-file exports remain self-contained rather than dependent on a delta.
HTTPS publishes immutable `contact_change` records alongside the derived view; Android
waits for a complete paged causal history before activating it.

Receipts only track delivery. Losing a reply cannot roll back a completed local contact
change. Backups retain history, unresolved alternatives, original UUIDs, and unsent work.
Switching to a foreign collection never uploads the old collection's history.

## Deliberate boundaries

- **This is contact replication, not replication of the whole SQLite database.** Imported
  conversations, inferred life events, relationship inference/overrides, aliases, profile
  decisions, moments, and model/enrichment requests retain their existing Mac workflow.
  A CLI clone imports contact history, not another machine's published facts/messages.
  Queued Mac-only memory requests must finish with their original publisher before switching
  peers, because their integer fact/profile IDs are not portable across CLI databases.
- **Splitting a replicated identity/undoing its merge is not implemented.** Android hides
  that action and the backend refuses it. The compatibility SQL view still coalesces
  existing message/event foreign keys; a safe split needs provenance for that data too.
  Do not mistake retained contact history for a complete reversible VCS of all app data.
- No Android-to-Android Bluetooth listener, automatic peer discovery, multi-user permissions,
  remote revocation, permanent history erasure, or history garbage collection is provided.
  Android can edit alone and reconcile with CLI peers through the existing transports.
- Contact history is private identifying data, including prior values and imported originals.
  Trash/removal is not permanent erasure. Share encrypted exports/keys only with trusted devices.
- Current bounds: 100,000 unique changes, 8,000,000 parent edges, 32 MiB transfer manifest, 128 MiB encrypted file,
  256 MiB expanded archive, 500 fields/contact. Exceeding bounds errors rather than truncates.

## Verification

The Python/JVM suites, Android debug/APK builds, and lint pass. Python/JVM tests cover independent branches, scalar conflicts/resolution, observed removals,
transitive merges, edits to merged identities, UUID retries/collisions, missing parents/cycles,
CLI clone/diverge/reconcile, publisher-local counters, delta records/deletions, foreign-source
isolation, backups, legacy migration, torn appends, corrupt journals, and checkpoint replay.
A shared Unicode/conflict/list fixture checks Python/Kotlin projection parity.

A synthetic JVM regression with **3,000 contacts** measured a two-person local merge at
**35–44 ms** across three runs, appending approximately **237 kB** instead of rewriting all contact cards. This is a
host benchmark, not a claim about Bluetooth or latency on a physical phone. Provider work
is now scoped to selected UUIDs, full reconciliations release their lock every eight contacts,
callbacks are conflated, and unchanged baseline data is not reserialized on every change.

On a fresh, isolated Android 35 ATD emulator, `ReplicatedContactsTest` passed local merging,
remote conflicts, the explicit choice UI, real Android Provider reconciliation, and restart;
the provider-backed two-contact merge measured **14 ms**. `DeviceContactsTest` also passed
external-edit/conflict/trash/restore/picker/full-backup recovery, and `MergeInternationalTest`
passed the legacy scoped-merge/international-dialing/confirmation regression. Run these
only on a fresh disposable emulator with `myPeopleDisposable=true`; never on personal data.
The updated protocol has also completed a real Mac↔Pixel 10 Bluetooth exchange with
replication enabled, both confirmations received, and no remaining queued edits. See
[Bluetooth](bluetooth.md) for native readiness, duplicate-callback, and import keepalive
handling. A cold instrumented sync still took about one minute; host merge timings above
are not physical-device sync latency.
