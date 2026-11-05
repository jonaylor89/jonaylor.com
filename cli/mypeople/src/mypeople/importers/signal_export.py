"""Export a minimal Signal Desktop snapshot on macOS, without changing Signal.

Run in a local Terminal (SSH cannot normally approve Keychain access):
    python -m mypeople.importers.signal_export ~/signal.jsonl

Requires cryptography and the SQLCipher CLI (`brew install sqlcipher`). This
file can also be copied to another Mac and run directly with Python 3.11+.
Only whitelisted conversation/message fields and the account identity leave
SQLCipher. No protocol keys, attachment paths, or attachment bytes are exported.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

FORMAT = "mypeople-signal-desktop"
VERSION = 1
DEFAULT_DIR = Path.home() / "Library/Application Support/Signal"
SCHEMA_QUERY = "SELECT json_object('messages', json((SELECT json_group_array(name) FROM pragma_table_info('messages'))), 'conversations', json((SELECT json_group_array(name) FROM pragma_table_info('conversations'))));\n"

CONVERSATION_FIELDS = (
    "id", "type", "serviceId", "uuid", "e164", "name", "profileName",
    "profileFamilyName", "systemGivenName", "systemFamilyName", "groupId",
)
MESSAGE_FIELDS = (
    "id", "conversationId", "type", "sent_at", "sourceServiceId", "sourceUuid",
    "source", "body", "isErased", "deletedForEveryone", "isViewOnce", "expireTimer",
)


class SignalExportError(ValueError):
    pass


def unwrap_key(config: dict, password: bytes) -> str:
    """Chromium's macOS v10 safeStorage format. Never base64-decode password."""
    if isinstance(config.get("key"), str):
        key = config["key"]  # legacy Signal Desktop
    else:
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.primitives.padding import PKCS7

        try:
            blob = bytes.fromhex(config["encryptedKey"])
            if blob[:3] != b"v10":
                raise ValueError("unsupported envelope")
            kek = hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", 1003, 16)
            decryptor = Cipher(algorithms.AES(kek), modes.CBC(b" " * 16)).decryptor()
            padded = decryptor.update(blob[3:]) + decryptor.finalize()
            unpadder = PKCS7(128).unpadder()
            key = (unpadder.update(padded) + unpadder.finalize()).decode("ascii")
        except (KeyError, TypeError, ValueError, UnicodeError):
            raise SignalExportError("Couldn't decrypt Signal's database key; unsupported format or wrong Keychain item.") from None
    if not re.fullmatch(r"[0-9a-fA-F]{64}", key):
        raise SignalExportError("Signal's database key has an unsupported format.")
    return key


def _field(field: str, columns: set[str]) -> str:
    # New Signal versions remove extracted fields from JSON entirely. Dedicated
    # columns are authoritative; older versions retain the complete JSON object.
    return f'"{field}"' if field in columns else f"json_extract(json, '$.{field}')"


def _object(fields: tuple[str, ...], columns: set[str], extra: str = "") -> str:
    pairs = ", ".join(f"'{field}', {_field(field, columns)}" for field in fields)
    return f"json_object({pairs}{extra})"


def _preamble(key: str) -> str:
    # Suppress PRAGMA key's acknowledgement; the key only travels on stdin.
    return f""".bail on
.timeout 10000
.output /dev/null
PRAGMA key = "x'{key}'";
.output stdout
.headers off
.mode list
"""


def snapshot_sql(key: str, schema: dict[str, set[str]]) -> str:
    messages, conversations = schema["messages"], schema["conversations"]
    # Filter before content reaches plaintext, even on a normalized schema.
    message_filter = " AND ".join([
        f"{_field('type', messages)} IN ('incoming', 'outgoing')",
        *(f"coalesce({_field(field, messages)}, 0) = 0"
          for field in ("isErased", "deletedForEveryone", "isViewOnce", "expireTimer")),
    ])
    attachments = "coalesce(json_array_length(json_extract(json, '$.attachments')), 0)"
    if "hasAttachments" in messages:
        attachments = f'max(coalesce("hasAttachments", 0), {attachments})'
    message_object = _object(MESSAGE_FIELDS, messages, f", 'hasAttachments', {attachments} > 0")
    # A single read transaction includes the WAL and keeps all sections consistent.
    return _preamble(key) + f"""BEGIN;
SELECT json_object('kind', 'header', 'format', '{FORMAT}', 'version', {VERSION},
  'aci', (SELECT json_extract(json, '$.value') FROM items WHERE id='uuid_id'),
  'number', (SELECT json_extract(json, '$.value') FROM items WHERE id='number_id'));
SELECT json_object('kind', 'conversation', 'data', {_object(CONVERSATION_FIELDS, conversations)}) FROM conversations ORDER BY id;
SELECT json_object('kind', 'message', 'data', {message_object}) FROM messages WHERE {message_filter} ORDER BY sent_at, id;
SELECT json_object('kind', 'end', 'conversations', (SELECT count(*) FROM conversations), 'messages', (SELECT count(*) FROM messages WHERE {message_filter}));
COMMIT;
"""


def export_snapshot(root: Path, output: Path, sqlcipher: str | None = None) -> None:
    if sys.platform != "darwin":
        raise SignalExportError("Automatic Keychain extraction currently supports macOS only.")
    binary = sqlcipher or shutil.which("sqlcipher")
    if not binary:
        binary = next((str(p) for p in (Path("/opt/homebrew/bin/sqlcipher"), Path("/usr/local/bin/sqlcipher")) if p.is_file()), None)
    if not binary:
        raise SignalExportError("Install SQLCipher first: brew install sqlcipher")
    try:
        config = json.loads((root / "config.json").read_text())
    except (OSError, ValueError):
        raise SignalExportError("Couldn't read Signal's config.json in the supplied profile folder.") from None
    if not isinstance(config, dict):
        raise SignalExportError("Signal's config.json must contain an object.")
    if not (root / "sql/db.sqlite").is_file():
        raise SignalExportError("Signal's sql/db.sqlite is missing.")
    # Never put a plaintext snapshot inside the live Signal profile.
    if output.resolve().is_relative_to(root.resolve()):
        raise SignalExportError("Choose an output path outside Signal's profile folder.")
    if output.exists():
        raise SignalExportError("Output already exists; choose a new snapshot filename.")
    password = b""
    if not config.get("key"):
        try:
            result = subprocess.run(
                ["/usr/bin/security", "find-generic-password", "-w", "-s", "Signal Safe Storage",
                 str(Path.home() / "Library/Keychains/login.keychain-db")],
                capture_output=True, timeout=120,
            )
        except subprocess.TimeoutExpired:
            raise SignalExportError("Keychain access timed out. Run locally and approve the macOS prompt.") from None
        if result.returncode:
            raise SignalExportError(f"Couldn't access Signal Safe Storage (Keychain exit {result.returncode}). Wake and unlock the Signal Mac, run in its local Terminal, and approve Keychain access.")
        password = result.stdout.rstrip(b"\r\n")
    key = unwrap_key(config, password)
    args = [binary, "-readonly", "-batch", str(root / "sql/db.sqlite")]
    schema_sql = _preamble(key) + SCHEMA_QUERY
    try:
        result = subprocess.run(args, input=schema_sql.encode(), capture_output=True, timeout=30)
        schema = json.loads(result.stdout) if result.returncode == 0 else {}
        if not isinstance(schema, dict) or any(not isinstance(schema.get(table), list) or not {"id", "json"}.issubset(schema[table]) for table in ("messages", "conversations")):
            raise ValueError("unsupported schema")
        schema = {table: set(columns) for table, columns in schema.items()}
    except (ValueError, TypeError, subprocess.TimeoutExpired):
        raise SignalExportError("SQLCipher couldn't read Signal's schema. The database key or schema may be unsupported.") from None
    output.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=".signal-", dir=output.parent)
    try:
        with os.fdopen(fd, "wb") as dest:
            result = subprocess.run(
                args,
                input=snapshot_sql(key, schema).encode(), stdout=dest, stderr=subprocess.PIPE, timeout=300,
            )
        if result.returncode:
            # CLI errors can echo SQL containing secrets; do not surface stderr.
            raise SignalExportError("SQLCipher couldn't read the Signal database. Its schema or encryption may be unsupported; no snapshot was saved.")
        # Check the framing without retaining message contents or printing them.
        with open(temporary, encoding="utf-8") as stream:
            header = json.loads(next(stream, "null"))
            last = None
            for line in stream:
                last = line
            footer = json.loads(last or "null")
        if not isinstance(header, dict) or header.get("format") != FORMAT or not header.get("aci") or not isinstance(footer, dict) or footer.get("kind") != "end":
            raise SignalExportError("Incomplete snapshot or missing account identity; no snapshot was saved.")
        # Atomic publication without overwriting an existing file, including races.
        os.link(temporary, output)
    except subprocess.TimeoutExpired:
        raise SignalExportError("SQLCipher timed out; no snapshot was saved.") from None
    finally:
        Path(temporary).unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="new private JSONL snapshot, outside the Signal folder")
    parser.add_argument("--profile", type=Path, default=DEFAULT_DIR)
    parser.add_argument("--sqlcipher", help="path to the SQLCipher CLI")
    args = parser.parse_args(argv)
    try:
        export_snapshot(args.profile.expanduser(), args.output.expanduser(), args.sqlcipher)
    except (SignalExportError, OSError, ValueError) as exc:
        if isinstance(exc, SignalExportError):
            parser.exit(1, f"{exc}\n")
        parser.exit(1, "Couldn't save the Signal snapshot; check paths and permissions.\n")
    print(f"Saved private Signal snapshot to {args.output}. Treat it as plaintext message history.")


if __name__ == "__main__":
    main()
