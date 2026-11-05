# Signal Desktop import

Signal's history is encrypted locally. Export on the Mac that holds the history
and its login Keychain; import the resulting private snapshot on your MyPeople
machine. Linking a fresh desktop is not a substitute for extracting the old
laptop's existing history.

## 1. Preserve the source

Before resetting, reinstalling, relinking, or deleting Signal data, quit Signal
and back up **the entire** `~/Library/Application Support/Signal/` folder to a
private location. Preserve access to the old Mac's login Keychain too: the data
folder alone generally isn't enough to decrypt a recent installation. Don't
copy another profile over a live Signal installation.

The exporter itself can run with Signal open. It opens the database read-only,
reads its WAL, and uses one transaction for a consistent snapshot. It never
writes Signal settings, checkpoints the database, or opens attachments.

## 2. Export on the old Mac

With this repository and its dependencies available:

```sh
brew install sqlcipher
uv run python -m mypeople.importers.signal_export ~/signal-history.jsonl
```

Run this in a **local Terminal on the old Mac**, not just SSH. macOS may ask for
permission to read the `Signal Safe Storage` login-Keychain item. Unlock the
login Keychain and approve that prompt; do not paste the password/key into chat.
SSH often reports that the item is missing or that interaction isn't allowed,
even when the item exists. Keep the Mac awake with its desktop unlocked: macOS
cannot show security UI in dark wake (Keychain exit 24). SSH-only access normally
returns exit 36 when a local approval is needed.

Alternatively, copy just `src/mypeople/importers/signal_export.py` to the old
Mac. It is standalone and only needs Python 3.11+, `cryptography`, and SQLCipher:

```sh
python3 -m venv ~/.cache/mypeople-signal-tools
~/.cache/mypeople-signal-tools/bin/python -m pip install cryptography
~/.cache/mypeople-signal-tools/bin/python /path/to/signal_export.py ~/signal-history.jsonl
```

Optional: `--profile /path/to/Signal` or `--sqlcipher /path/to/sqlcipher`.
A copied profile must match the Keychain item on that Mac. Legacy plaintext
`config.json` keys and current macOS Chromium `v10` safeStorage keys are supported;
other encryption formats fail explicitly.

The exporter:

- reads the key into memory; it never prints it or puts it in process arguments;
- exports only account identity and whitelisted conversation/message fields;
- excludes protocol secrets, attachment bytes/paths, and other account settings;
- writes a mode-0600 JSONL snapshot atomically and refuses to overwrite a file;
- includes an end marker/counts so interrupted exports cannot be imported.

**The JSONL file is plaintext private message history**, even though it has
restricted permissions. Keep it outside the repository, on an encrypted disk,
and transfer it only over a trusted encrypted connection. The original encrypted
Signal profile is untouched. Delete temporary snapshots when no longer needed.

## 3. Import into MyPeople

```sh
uv run mypeople import signal ~/signal-history.jsonl
# Optional history cutoff (older outgoing messages still establish relationships):
uv run mypeople import signal ~/signal-history.jsonl --since 2024-01-01
```

No model is called by export/import. Normal `extract` is a separate step and may
send imported messages to the configured model provider.

### Identity and interaction rules

- Account IDs (ACIs) and explicit international phone numbers match existing
  identities. Display names alone never merge people.
- Unmatched people become people only if you sent a normal direct message to
  them. Attachment-only messages count as activity, without importing media.
- Signal source IDs follow existing MyPeople merges. Contact-card names, phone
  fields, labels, verification, and manual deletions aren't overwritten; Signal
  phone numbers aren't appended to contact cards or identifier lists.
- Incoming group messages count only for known people, resolved through private
  conversation records. Unknown members and your outgoing group messages don't
  create people or inflate activity with everyone in the group.
- Note to Self, system notices, reactions, calls, erased/deleted messages,
  view-once messages, and **all disappearing messages** are excluded. Import is
  not a way to defeat ephemeral-message retention.
- Repeated snapshots from the same desktop history deduplicate using exporting
  account + desktop-local message UUID. Separately linked desktops may assign
  different message UUIDs, so overlapping exports from them can duplicate
  activity. Use the old laptop's full history as the primary source.
- Edited bodies aren't updated on re-import; the importer is insert-only, like
  the other message importers. Calls, media, and long-message attachments aren't
  extracted in this first version.

Tests use synthetic snapshots/keys; real messages and Keychain secrets never
belong in fixtures, logs, or commits.
