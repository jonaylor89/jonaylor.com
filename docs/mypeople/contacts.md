# MyPeople as your Android address book

MyPeople can create, maintain, and merge contacts on the phone without a running Mac. [Replicated causal contact history](contact-replication.md) reconciles offline changes with CLI peers; the Mac still handles message imports, inference, and enrichment. Install the updated Python package **and** Android app before syncing new contact operations.

## Before removing another Contacts app

1. Export an original vCard from your existing address book and keep it outside MyPeople. Back up your Mac database/photos separately too.
2. Sync the updated Mac once to assign stable contact UUIDs. Old cached records without UUIDs are deliberately not editable until this upgrade arrives.
3. In **Settings → Your address book**, import the original vCard or existing Android contacts. Review each potential match. Matches start unchecked; explicitly choose **Fill #…** or create a separate person. Fill preserves existing values and adds fields; it does not overwrite your manual notes.
4. Open **Migration safety report**. Resolve legacy/unverified numbers, invalid numbers, and shared identifiers. Country codes discarded by previous MyPeople versions cannot be inferred from a matching key alone: recover the original source metadata below, re-import the originals, or check them yourself in Edit contact. Merely pinning an old record does not mark its numbers verified.
5. Enable **Android contacts integration**. Confirm the disclosure and Contacts permission. Test known international/local numbers, extensions, multiple emails, and a shared household number. No calls or messages are placed automatically.
6. Create an **encrypted phone backup**, copy it off the phone, and keep the separate passphrase safely. Test restoring it on a spare/fresh installation. Also export a portable vCard.
7. Verify caller names and recipient selection in the actual dialer/SMS apps you use. OEM behavior differs. Only then remove other Contacts **UI apps** if desired. Keep Android **Contacts Storage**, your dialer, and your messaging/email apps. Removing a Google account can remove its contacts; removing its Contacts UI is not the same thing.

There is no special Android “default Contacts app” role to acquire. MyPeople handles contact insert/insert-or-edit, view/edit, vCard view/share, and contact/phone/email pick intents and provides contact data through Android's existing Contacts Provider.

## Daily use

- People opens first by default; Settings can switch back to Home. Browse A–Z, Favorites, Closest, or Trash; search names, nicknames, phone numbers, and emails. Search/sorting stay pinned while the contact list scrolls. Tap or drag the right-hand A–Z/# rail to jump, use the A–Z button for an accessible letter chooser, or use the up/down controls to reach the first/last contact immediately. Names sort before bare numbers/symbols under #. Large text uses a sampled visual rail without removing any jump targets.
- A single bottom-nav tap restores the tab’s position. Double-tapping the same item within Android’s double-tap interval returns to that tab’s root and scrolls the active page to the top. Home/Review keep the selected sub-tab; person detail pages are exited. TalkBack also exposes an explicit “Return to top” action.
- **New contact** and **Edit contact** work immediately offline. Maintain multiple labelled/preferred numbers, emails, postal addresses, websites, IM addresses, anniversaries, structured/phonetic names, birthday, company/title, photo, contact notes, preferred channel, and favorites.
- New or changed social website URLs entered in the contact editor also register as confirmed profiles on the Mac after sync, making them available to photo lookup and public-profile discovery. Confirmation is per link: imported/unchanged URLs and edits to labels, names, notes, or favorites do not confirm anything. Explicit profile rejections still win. Removing a website does not reject its separately confirmed social profile; use profile review for that.
- Original phone strings and extensions are retained. libphonenumber derives international dialing targets using the contact’s country or a per-number override. Explicit `+country` codes win; meaningful Italian leading zeroes and extension zeroes are preserved. Android call targets use a wait before extension digits; SMS targets contain only the main international number. Google/Android import uses explicit canonical country metadata when available. Unparseable values are retained and flagged, never truncated.
- A legacy matching identifier without a proven country is not silently converted to `+1`. Call/Text opens its editor for verification; vCard export retains the raw value and unverified marker. Re-import original Android/Google/vCard contacts to recover missing codes. Explicitly filling a legacy card with verified originals replaces obsolete phone hints while retaining historical identifiers and your notes.
- Copy/share individual details, share a vCard, open postal addresses in Maps, or call/text/email using installed apps. Contact notes are ordinary text, **not** sent for AI extraction. The separate “Add note” memory feature still requests extraction on the Mac.
- Move contacts to Trash with confirmation; restore from People → Trash. Trash is not permanent erasure. Facts/history and originals remain recoverable.
- Merge preparation checks only the selected people, not every contact in the address book. The confirmation stays open with an actionable error if preparation fails; successful requests are durably queued before the UI dismisses. Android-copy differences are repaired automatically and do not block a merge; unresolved MyPeople offline conflicts still do.
- Graph edits and merges finish locally. **Split into separate contact** moves explicitly selected phone/note/fact/profile/message-batch associations into a new person after review; unselected ambiguous items stay put. Message rows state their full batch count/thread scope. Retracting merge assertions preserves later edits instead of restoring an old destructive SQL snapshot. See [graph architecture and upgrade safety](versioned-graph.md).

## Data and identity

The immutable object graph is authoritative. `people.contact_uid` and local SQL rows project graph identities; `contact_data` is a derived editing/export card. Names, contact points, notes, claims, decisions, relationships and attribution edges have stable UUIDs and revisions. Every trusted peer receives all data and history, including conversations and originals. Imports retain original vCard/Google properties as evidence. Unsupported external photo formats/URLs remain in originals, not fetched automatically.

Native screen IDs are local indexes only. New graph edits address portable UUIDs and are durable without Mac approval; Bluetooth/file synchronization joins history and acknowledges frontiers. Derived relationship inference remains a Mac job, with explicit preferences overriding its last published hints. Old unsent/failed requests are retained during upgrade and recovery. Restart an old Mac listener after updating it. See [replication and collection isolation](contact-replication.md).

vCard TEL values use international numbers for portability; grouped `X-SHERLOQ-ORIGINAL-PHONE` metadata retains original formatting and is accepted only when it normalizes to the same number. Per-number country overrides and the unverified marker survive phone↔Mac imports. Legacy suffix identifiers cannot override a different full country-aware number.

Re-imports honor explicit identity merges: old display names, nicknames, and stable source IDs resolve to the surviving contact without renaming it. Replicated merges retain alternate names as aliases; older merge names can also be recovered from contact history. A different name sharing a household number is still kept separate unless that identity was explicitly merged.

International matching keys are no longer truncated to ten digits. The old NANP matching key remains for backwards compatibility, **not** as the dialing representation. A separate non-unique `contact_keys` index allows multiple cards to share household phone/email identifiers; an ambiguous shared key is not an automatic person match. Removed manual contact details are not reused as current matching evidence, although historical identifiers remain for provenance.

## Recovering legacy phone numbers on the Mac

```sh
# Preview only; uses the existing MyPeople Google login, plus local Messages,
# WhatsApp Desktop and macOS Contacts databases when present.
uv run mypeople recover-phones --google
# Review the private JSON preview, then back up and apply unambiguous repairs:
uv run mypeople recover-phones --google --apply
```

Recovery links originals using an existing Google resource ID, a unique email, or an exact imported message/call reference. It never assigns people by name or number suffix alone, creates people, merges records, or writes to Google/Apple/WhatsApp. Messages are inspected for addressing metadata, not their bodies. Conflicting country codes and missing/invalid originals remain unverified. Google canonical country metadata, meaningful zeroes, extensions, existing labels, notes, and other contact details are retained. Verified/manual cards are not refilled with historical numbers the user removed.

Every apply creates a consistent SQLite backup and a private before/after audit journal under `~/.mypeople/recovery/` before changing anything. Concurrent changes to names, cards, identifiers, lifecycle state, or matching keys are skipped. Historical identifiers and inferred facts/history are unchanged; only structured cards and their country-aware matching keys are repaired, in one transaction. The JSON reports and backups contain personal contact data; keep them private. Sync/export a fresh snapshot afterwards so the phone receives the repairs while preserving its queued edits.

## Android integration and conflicts

Integration is **off by default**. Enabling it creates the local `MyPeople` account (`app.sherloq.contacts`). Only that account's raw contacts are created, updated, or removed. Google, SIM, and other device-account raw contacts are never written to. Device import reads other accounts only after permission and stages a review; it does not silently import on startup.

The bridge exports contact details, not relationship scores, life events, message quotes, or inferred profiles. Apps with Contacts permission can read the exported details, including ordinary contact notes. Android may aggregate copies that share numbers; MyPeople itself does not merge those people. Ambiguous system contact links require choosing a person. Phone/email pickers return an exact data-row URI.

**MyPeople is the source of truth for its Android copies.** Saved MyPeople edits automatically update the Provider after the graph transaction commits, including while offline. Reconciliation runs after local changes, on foreground resume, through a Contacts content observer, and via Android's sync adapter. Changes or deletions made to MyPeople copies in other apps are replaced by the saved MyPeople version; edit contacts inside MyPeople instead. There is no Android-versus-MyPeople version choice. Original source records, graph history, merge identities and field ownership remain in MyPeople; unresolved offline/peer conflicts still require review inside MyPeople before that contact exports.

A persisted baseline and Provider version checks distinguish our callbacks from external edits, avoiding repeated writes. Restart/retry locates copies by stable SOURCE_ID, including when a baseline is missing after an interrupted export, so it updates in place instead of creating another contact. A corrupt baseline or failed Provider query stops reconciliation without resetting contacts. Permission revocation pauses writes; grant permission and retry in Settings or resume the app. Removing the MyPeople Android account pauses integration without trashing the MyPeople address book. Pausing integration leaves existing Android copies intact; remove the account in Android Settings to remove those copies. Failed exports leave MyPeople edits durable and retry on the next reconciliation.

Legacy/unverified phone details are not exported to Android until re-imported or explicitly verified. Photos sent to the Provider are bounded thumbnails; full manual JPEG/PNG images remain in the card and encrypted backup. Extremely large contacts may exceed Android's IPC limits and are refused by the bridge without discarding the originals.

## Repeated numbers and earlier identity decisions

A person can legitimately have more than one phone number. The contact page
groups equivalent formats into one row per distinct number and shows how many
saved copies it represents. Formatting is derived for display, not rewritten in
the graph. Unknown countries and different extensions are never equated.

**Remove … repeated entries** previews the exact numbers being kept and the
before/after entry counts. For example, six entries containing three copies each
of two numbers become two entries, not one number. Cleanup preserves labels,
defaults, field ownership, original history and any earlier identity decision.
It is available even with an earlier merge/separation warning; genuine competing
field values must still be resolved first.

Old `matching_hint` / legacy-identifier phone points appear under **unverified
import hints**, not among the normal phone rows or Call/Message actions. Their
provenance is read from the graph on a background thread for this contact only.
They are retained for source review, excluded from repeated-entry cleanup, and
never assigned a guessed country code.

Open **Review → Decisions** for earlier separation decisions and actual value
conflicts, counted separately:

- **Earlier separation decision → Review earlier decision** shows the current
  distinct numbers and the named source records previously marked as different
  people. Choose whether the displayed details belong to one person, then
  **Keep this contact**. Multiple phone numbers do not imply different people.
- If they really are different people, the alternative explicitly confirms
  restoring **all N separate records** using existing field ownership. Nothing
  is erased, but duplicate-looking contacts can reappear.
- Optional phone cleanup can share the same atomic commit with a confirmed keep
  decision. It can also run independently without confirming or undoing a merge.
- Actual independently edited values still appear under **Two versions, safely
  kept**, with human-readable field labels rather than graph UUID paths.
  No identity decision or competing value is selected automatically.

Canceling a preview does nothing. Saved decisions travel to peers on the next
sync. Android copies follow MyPeople, subject to permission and phone-verification
safeguards.

## Backup and restore

**Encrypted phone backup** is a versioned, authenticated AES-GCM archive using the existing PBKDF2 transfer encryption. It contains the authoritative phone cache, unsynced and failed operation payloads, cursor/source metadata, trash, facts/evidence, and all referenced photos. It fails rather than claim success when a referenced photo cannot be obtained. Photos previously fetched over HTTP must be available locally or from the server during backup.

The archive excludes Bluetooth capabilities, browser credentials, and transfer passphrases. Use a separate ASCII passphrase of at least 12 characters. Full phone backup size is limited to 128 MiB encrypted / 256 MiB expanded; manifests to 64 MiB; individual manual photos to 2 MiB. vCard import files are limited to 16 MiB. Backups should be copied somewhere outside app-private storage.

Restore authenticates and validates all data before replacing state, requires an empty current outbox, disconnects credentials durably, pauses Android integration, and restores pending operations with their original UUIDs. It is serialized against sync and Provider reconciliation. Re-pair with the **same** Mac database or re-enter credentials for the **same** server; foreign-source switches remain blocked while edits are pending. Cloud backup/device transfer remain disabled. Uninstalling the app removes local data, so a backup left only inside the app is not a backup.

A phone backup does **not** contain the Mac's raw messages or undo snapshots. Back up the Mac's SQLite database and referenced photo directory separately (use SQLite's backup API or close MyPeople writers before copying). Portable vCard export is unencrypted and does not include inferred facts or conversation history. Retained contact-source properties may contain old address-book details; review before sharing.

## Verification

Automated coverage includes Python schema upgrade, original international numbers/extensions, shared identifiers, rich vCard/Google imports, manual/inferred separation, CRUD, UUID retries, merge undo/refusal, Android offline ID adoption, receipt-before-publication, atomic cache restart, failed-edit recovery, vCard folding/Unicode/custom labels, favorites/trash, and encrypted backup authentication/restore protection.

An instrumentation test exercises the real Contacts Provider: account creation, owned-only writes, phone/contact picker URIs, automatic repair of external edits/deletions and simultaneous changes, no feedback loops or duplicate exports after restart/missing baselines, permission/Provider failures, trash/restore, unrelated raw contacts remaining untouched, account removal/re-enabling without deleting MyPeople contacts, and a real encrypted full-phone backup/restore with unsynced operation UUIDs preserved. Run it **only on a fresh disposable emulator**, never a personal phone/installation. It refuses to start with an existing MyPeople cache.

```sh
uv run --all-extras pytest
cd ../../android/mypeople # from cli/mypeople
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
./gradlew assembleDebug assembleDebugAndroidTest testDebugUnitTest lintDebug
# Explicitly select your disposable emulator, not every connected device:
adb -s EMULATOR_SERIAL install app/build/outputs/apk/debug/app-debug.apk
adb -s EMULATOR_SERIAL install app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb -s EMULATOR_SERIAL shell am instrument -w app.sherloq.test/androidx.test.runner.AndroidJUnitRunner
# Scrolling/nav Compose tests explicitly opt in to seeding a disposable empty cache:
adb -s EMULATOR_SERIAL shell am instrument -w -e myPeopleDisposable true \\
  -e class app.mypeople.data.PeopleNavigationTest \\
  app.sherloq.test/androidx.test.runner.AndroidJUnitRunner
```

Verified on disposable Android 35 and 37 emulators. Actual call/SMS/email delivery, OEM-specific caller-name behavior, and a long-term real-phone migration still require your device acceptance check. No personal contacts are modified by the build or JVM/Python test suites.
