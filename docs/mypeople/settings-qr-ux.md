# Settings & Mac QR transfer

## User jobs and hierarchy

Settings is a utility screen, not an introduction to the product. The default view prioritizes:

1. Resolve an unreadable store, if present, with its actual error and Retry.
2. Sync with the Mac: queued-edit count, last successful sync, one prominent Scan Mac QR action.
3. Access encrypted-file transfers as a collapsed alternative, not competing primary buttons.
4. Recover failed edits, when present, without hiding them in a technical section.
5. Choose whether the app opens to People.
6. Configure Android contacts; import/export contacts; create/restore backups; inspect storage/privacy. Each has its own labelled, saveable disclosure.

Removed the slogan heading, promotional offline-storage card, repeated sync explanations, and branded footer. Retained consent, unencrypted-vCard warnings, authoritative Android-copy behavior, backup loss/replacement warnings, pending-queue restore guard, migration report, and recovery actions. Full-width labelled switches and disclosures have standard touch targets and state semantics. Tonal groups use the existing Kin tokens and typography. Dialog bodies scroll independently of their actions, including with the keyboard and large text. Transfer/backup passphrases remain ordinary in-memory state, never saveable state, and use password keyboards.

## Which QR screens exist?

Android **scans**, it does not display a pairing QR:

- Settings → Scan Mac QR → explicit camera permission → full-screen CameraX preview. An opening state remains until preview frames arrive. A clipped TextureView keeps the preview inside its allotted region, including at 200% text; it cannot paint over Cancel or the scanner instructions.
- “Where do I find the QR?” works before scanning and inside the scanner. It shows a selectable CLI command, Mac-awake/pairing requirements, expiry recovery, and the trust boundary. Help does not initiate transfer.
- A decoded/validated offer closes the camera and opens a confirmation with the Mac name, queued-edit count, and complete-memory/history trust warning. v2 and v3 are bidirectional; v1 remains explicitly download-only.
- Foreign queued edits block confirmation. Nearby devices permission is requested only on confirming a transfer.
- Transfer phase titles distinguish connecting, sending edits, Mac processing, receiving memory, durable import, and final confirmation. Progress is determinate only when totals are available. Phase changes are announced; percentage changes do not repeatedly interrupt a screen reader. Cancel stays disabled during import/final confirmation, and Back/outside dismissal cannot interrupt an active transfer.
- Invalid/expired QRs, camera failures, connection failures, and Nearby devices denial remain inline beside the scan/retry action instead of depending solely on a transient snackbar. Permission-related errors also link to app permissions. Camera denial retains its explicit settings/cancel dialog. Successful sync retains its existing completion/remaining-work feedback.

No networking, discovery, background-transfer behavior, protocol, acknowledgment rules, durable history, file formats, or restore semantics changed. Cancelling/retrying does not clear edits. The privacy copy no longer incorrectly promises that raw messages stay on the Mac: current transfers exchange the complete versioned graph, as described in [Bluetooth transfer](bluetooth.md).

## Verification

`SettingsTransferUxTest` is guarded to a fresh opted-in disposable emulator. It renders synthetic states without writing contacts or importing memory. It covers default priority, independent disclosure access, encrypted-file eligibility, restore disabled with queued edits while backup remains available, empty-passphrase protection, store-error retry, v3/v1 labels, foreign-queue blocking, all six transfer phases, commit-time cancel guards, and scanner help/cancel using the emulator camera. `ScanWithoutNetworkTest` separately checks bundled offline decoding and denied INTERNET permission.

Screenshots are written outside the repo to the disposable app's external files directory (`settings-qa`). Review light/dark Settings, Mac QR help/confirmation, foreign queues, progress/import/confirmation, backup guards, errors, and the synthetic camera. Repeat with a 320 dp-wide screen and 200% system text; content must scroll while dialog actions remain reachable. Actual OS permission denial should also be checked from an empty emulator installation.

The standard Gradle unit/lint/debug/test-APK/dev build command passed (241 JVM tests, no failures). The five focused instrumentation tests passed at normal size and 320 dp width with 200% system text. Light/dark, confirmation/foreign-queue/progress states, backup guards, store errors, camera permission denial and the real keyboard-visible backup dialog were inspected on the disposable emulator. Scanner testing waits for actual synthetic-camera preview frames, not just the presence of camera chrome. The isolated dev APK was installed in place on the connected Pixel without clearing data.

These render/emulator checks do not validate physical-camera recognition or a real Mac Bluetooth session. Never reset, seed, or run synthetic-store tests against a personal phone. Use `app.sherloq.dev` for non-destructive phone previews.
