"""Encrypted, serverless snapshots and edit bundles, carried by Bluetooth or USB.

The OS transports an ordinary .sherloq file. The published UI view accompanies a
complete versioned graph (including raw conversations and full-size assets) for
trusted peers. Files use PBKDF2-HMAC-SHA256 + AES-256-GCM on every platform.
"""
from __future__ import annotations

import datetime as dt
import hashlib
import io
import json
import os
import re
import secrets
import sqlite3
import tempfile
import uuid
import zipfile
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from . import ops, publish

MAGIC = b"SHERLOQ1"
ITERATIONS = 200_000
MAX_FILE = 128 * 1024 * 1024
MAX_EXPANDED = 256 * 1024 * 1024
MAX_PHOTO = 10 * 1024 * 1024
MAX_GRAPH = MAX_EXPANDED
KEY_FILE = Path.home() / ".mypeople" / "transfer.key"
SCHEMA = """
CREATE TABLE IF NOT EXISTS transfer_state (
    slot INTEGER PRIMARY KEY CHECK(slot = 1), source TEXT NOT NULL, revision INTEGER NOT NULL,
    publisher TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS transfer_applied (
    client_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
    payload TEXT NOT NULL, status TEXT NOT NULL, message TEXT NOT NULL
);
"""


class TransferError(ValueError):
    pass


def _password(password: str) -> bytes:
    if len(password) < 12 or not password.isascii():
        raise TransferError("Use a transfer passphrase of at least 12 ASCII characters.")
    return password.encode("ascii")


def encrypt(data: bytes, password: str) -> bytes:
    salt, nonce = secrets.token_bytes(16), secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac("sha256", _password(password), salt, ITERATIONS, 32)
    result = MAGIC + salt + nonce + AESGCM(key).encrypt(nonce, data, MAGIC)
    if len(result) > MAX_FILE:
        raise TransferError("Complete transfer exceeds the size limit; no graph history or assets were omitted.")
    return result


def decrypt(data: bytes, password: str) -> bytes:
    if len(data) > MAX_FILE or len(data) < 52 or data[:8] != MAGIC:
        raise TransferError("Not a supported MyPeople transfer file.")
    key = hashlib.pbkdf2_hmac("sha256", _password(password), data[8:24], ITERATIONS, 32)
    try:
        return AESGCM(key).decrypt(data[24:36], data[36:], MAGIC)
    except InvalidTag:
        raise TransferError("Incorrect transfer passphrase or damaged file.") from None


def key_file(path: Path = KEY_FILE, *, create: bool = False) -> str:
    if create and not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, "w") as stream:
            stream.write(secrets.token_urlsafe(18) + "\n")
    if not path.exists():
        raise TransferError(f"No transfer passphrase at {path}. Use --password-file to select one.")
    password = path.read_text().rstrip("\r\n")
    _password(password)
    return password


def _prepare(conn: sqlite3.Connection) -> tuple[str, int]:
    # executescript would implicitly commit an enclosing graph/edit transaction.
    for statement in SCHEMA.split(";"):
        if statement.strip():
            conn.execute(statement)
    if "publisher" not in {r[1] for r in conn.execute("PRAGMA table_info(transfer_state)")}:
        conn.execute("ALTER TABLE transfer_state ADD COLUMN publisher TEXT NOT NULL DEFAULT ''")
    conn.execute("INSERT OR IGNORE INTO transfer_state(slot, source, revision) VALUES (1, ?, 0)", (str(uuid.uuid4()),))
    conn.execute("UPDATE transfer_state SET publisher=? WHERE publisher=''", (str(uuid.uuid4()),))
    conn.commit()
    row = conn.execute("SELECT source, revision FROM transfer_state WHERE slot = 1").fetchone()
    return row["source"], row["revision"]


def pack(manifest: dict, photos: dict[str, str] | None = None, *, compact_history: bool = True) -> bytes:
    manifest = dict(manifest)
    graph = manifest.pop("graph", None)
    if compact_history:
        from .contact_wire import compact
        manifest = compact(manifest)
    out = io.BytesIO()
    total = 0
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as archive:
        raw = json.dumps(manifest, ensure_ascii=False).encode()
        if len(raw) > 32 * 1024 * 1024:
            raise TransferError("Transfer manifest exceeds 32 MiB. Update both clients for compact contact history; no history was truncated.")
        total += len(raw)
        archive.writestr("manifest.json", raw)
        if graph is not None:
            raw_graph = json.dumps(graph, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode()
            total += len(raw_graph)
            if len(raw_graph) > MAX_GRAPH or total > MAX_EXPANDED:
                raise TransferError("Complete graph exceeds the archive size limit; nothing was truncated.")
            archive.writestr("graph.json", raw_graph)
        for digest, path in (photos or {}).items():
            data = Path(path).read_bytes()
            if len(data) > MAX_PHOTO:
                raise TransferError("A photo is too large. Export again with --no-photos.")
            if hashlib.sha256(data).hexdigest() != digest:
                raise TransferError("A photo changed during export. Please retry.")
            total += len(data)
            if total > MAX_EXPANDED:
                raise TransferError("Transfer is too large. Export again with --no-photos.")
            archive.writestr(f"photos/{digest}", data)
    return out.getvalue()


def unpack(data: bytes) -> dict:
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            entries = archive.infolist()
            if len(entries) > 10_000 or sum(e.file_size for e in entries) > MAX_EXPANDED:
                raise TransferError("Transfer exceeds the safe size limit.")
            names = [e.filename for e in entries]
            if any(name not in ("manifest.json", "graph.json") and re.fullmatch(r"photos/[0-9a-f]{64}", name) is None for name in names):
                raise TransferError("Unsafe path in transfer archive.")
            if len(set(names)) != len(names) or "manifest.json" not in names:
                raise TransferError("Invalid transfer archive.")
            if archive.getinfo("manifest.json").file_size > 32 * 1024 * 1024:
                raise TransferError("Transfer manifest is too large.")
            manifest = json.loads(archive.read("manifest.json"))
            if not isinstance(manifest, dict) or manifest.get("format") not in (1, 2):
                raise TransferError("Unsupported transfer format.")
            uuid.UUID(manifest["source"])
            if "graph.json" in names:
                if "graph" in manifest or archive.getinfo("graph.json").file_size > MAX_GRAPH:
                    raise TransferError("Invalid or oversized graph payload.")
                manifest["graph"] = json.loads(archive.read("graph.json"))
            from .contact_wire import expand
            return expand(manifest)
    except (zipfile.BadZipFile, KeyError, TypeError, json.JSONDecodeError, AttributeError, ValueError) as e:
        if isinstance(e, TransferError):
            raise
        raise TransferError("Invalid transfer archive.") from None


def write_file(path: Path, data: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".mypeople-")
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)


def validate_inventory(manifest: dict) -> None:
    graph = manifest.get("graph")
    if graph is not None:
        if not isinstance(graph, dict) or set(graph) != {"collection", "heads", "commits", "blobs"}:
            raise TransferError("Invalid graph bundle")
        try:
            if str(uuid.UUID(graph["collection"])) != graph["collection"]:
                raise ValueError
            if not isinstance(graph["heads"], list) or len(graph["heads"]) > 100_000 or len(set(graph["heads"])) != len(graph["heads"]):
                raise ValueError
            for head in graph["heads"]:
                if str(uuid.UUID(head)) != head:
                    raise ValueError
        except (ValueError, TypeError, AttributeError):
            raise TransferError("Invalid graph collection or frontier") from None
        if not isinstance(graph["commits"], list) or len(graph["commits"]) > 100_000:
            raise TransferError("Invalid graph commit list")
        if not isinstance(graph["blobs"], dict) or len(graph["blobs"]) > 1_000_000 or any(
            not isinstance(key, str) or re.fullmatch(r"[a-f0-9]{64}", key) is None or not isinstance(value, str)
            for key, value in graph["blobs"].items()
        ):
            raise TransferError("Invalid graph blob inventory")
    hashes, photos = manifest.get("record_hashes", {}), manifest.get("photo_hashes", [])
    if not isinstance(hashes, dict) or len(hashes) > 100_000 or any(
        not isinstance(k, str) or ":" not in k or k.split(":", 1)[0] not in ("person", "event", "profile", "moment", "dupes") or
        not isinstance(v, str) or re.fullmatch(r"[a-f0-9]{64}", v) is None for k, v in hashes.items()
    ):
        raise TransferError("Invalid record inventory")
    if not isinstance(photos, list) or len(photos) > 10_000 or any(not isinstance(h, str) or re.fullmatch(r"[a-f0-9]{64}", h) is None for h in photos):
        raise TransferError("Invalid photo inventory")
    wire = manifest.get("contact_wire", 0)
    if not isinstance(wire, int) or isinstance(wire, bool) or wire not in (0, 1):
        raise TransferError("Unsupported contact wire capability")
    revision = manifest.get("revision", 0)
    if not isinstance(revision, int) or isinstance(revision, bool) or revision < 0:
        raise TransferError("Invalid sync revision")
    if manifest.get("publisher") is not None:
        try: uuid.UUID(manifest["publisher"])
        except (ValueError, TypeError, AttributeError): raise TransferError("Invalid publisher") from None
    for key in ("contact_heads", "contact_history"):
        if not isinstance(manifest.get(key, []), list) or len(manifest.get(key, [])) > 100_000:
            raise TransferError("Invalid contact history inventory")
    try:
        for head in manifest.get("contact_heads", []): uuid.UUID(head)
    except (ValueError, TypeError, AttributeError):
        raise TransferError("Invalid contact history head") from None


def export_snapshot(conn: sqlite3.Connection, path: Path, password: str, *, include_photos: bool = True, compact_photos: bool = False, peer: dict | None = None) -> dict:
    if peer is not None: validate_inventory(peer)
    source, _ = _prepare(conn)
    from . import replica, graph_runtime
    graph_runtime.initialize(conn)
    history = replica.capture(conn)
    conn.commit()
    source = conn.execute("SELECT source FROM transfer_state WHERE slot=1").fetchone()[0]
    if peer is not None and (peer.get("source") != source or peer.get("type") != "edits"):
        raise TransferError("Sync inventory belongs to another address book")
    replicated = peer is None or peer.get("contact_version") == 1
    known_heads = peer.get("contact_heads", []) if peer and replicated else []
    try:
        # The graph travels once in graph.json; never duplicate native commits
        # inside the obsolete contact-card wire protocol.
        contact_changes = [] if graph_runtime.enabled(conn) else history.missing(known_heads)
    except (ValueError, TypeError) as exc:
        raise TransferError(str(exc)) from exc
    revision = conn.execute("UPDATE transfer_state SET revision = revision + 1 WHERE slot = 1 RETURNING revision").fetchone()[0]
    conn.commit()
    records, photos = publish.records(conn)
    records = {key: data for key, data in records.items() if key[0] != "contact_change"}
    # The small UI manifest must not duplicate megabytes of card originals/photos.
    # Their complete authoritative bytes remain in the graph and its blobs.
    for (kind, _), record in records.items():
        if kind == "person" and record.get("card"):
            record["card"] = {key: value for key, value in record["card"].items() if key not in ("photo", "originals", "source_records")}
    graph = graph_runtime.bundle(conn, (peer.get("graph") or {}).get("heads", []) if peer else [])
    conn.commit()
    requested = {op.get("client_id") for op in peer.get("ops", []) if isinstance(op, dict)} if peer is not None else None
    results = [dict(row) for row in conn.execute("SELECT client_id, kind, payload, status, message FROM transfer_applied")
               if requested is None or row["client_id"] in requested]
    for result in results:
        result["payload"] = json.loads(result["payload"])
        result["id"] = 0
    manifest = {
        "format": 1, "type": "snapshot", "source": source, "revision": revision,
        "publisher": conn.execute("SELECT publisher FROM transfer_state WHERE slot=1").fetchone()[0],
        "created_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "records": [{"kind": kind, "id": rid, "data": record} for (kind, rid), record in records.items()],
        "results": results,
        "graph": graph,
    }
    if peer is None:  # memory files can reach another Mac; a phone doesn't need what's forgotten
        manifest["fact_state"] = _fact_state(conn)
    if replicated:
        manifest.update(contact_version=1, contact_history=contact_changes, contact_heads=[] if graph_runtime.enabled(conn) else history.heads)
    # QR transfers use avatar-sized JPEGs, not full-size contact originals. This
    # substantially reduces Bluetooth time and strips unneeded photo metadata.
    with tempfile.TemporaryDirectory(prefix="mypeople-photos-") as temp:
        database = conn.execute("PRAGMA database_list").fetchone()[2]
        cache = Path(database).parent / "transfer-avatars" if database else Path(temp)
        if include_photos and compact_photos:
            cache.mkdir(mode=0o700, parents=True, exist_ok=True)
            from PIL import Image, ImageOps
            compact = {}
            replacements = {}
            for digest, original in photos.items():
                try:
                    cached = cache / digest
                    if cached.is_file():
                        content = cached.read_bytes()
                        new_hash = hashlib.sha256(content).hexdigest()
                        compact[new_hash] = str(cached)
                        if new_hash != digest: replacements[digest] = new_hash
                        continue
                    with Image.open(original) as image:
                        image = ImageOps.exif_transpose(image)
                        image.thumbnail((384, 384))
                        if image.mode in ("RGBA", "LA") or "transparency" in image.info:
                            rgba = image.convert("RGBA")
                            background = Image.new("RGB", rgba.size, "white")
                            background.paste(rgba, mask=rgba.getchannel("A"))
                            image = background
                        else:
                            image = image.convert("RGB")
                        out = io.BytesIO()
                        image.save(out, "JPEG", quality=85, optimize=True)
                        content = out.getvalue()
                    if len(content) >= Path(original).stat().st_size:
                        content = Path(original).read_bytes()
                    new_hash = hashlib.sha256(content).hexdigest()
                    write_file(cached, content)
                    compact[new_hash] = str(cached)
                    if new_hash != digest: replacements[digest] = new_hash
                except (OSError, ValueError):
                    compact[digest] = original
            for (kind, _), record in records.items():
                if kind == "person" and record.get("photo") in replacements:
                    record["photo"] = replacements[record["photo"]]
            photos = compact
        hashes = {f"{kind}:{rid}": hashlib.sha256(replica.encoded(record).encode()).hexdigest()
                  for (kind, rid), record in records.items()}
        manifest["record_hashes"] = hashes
        known_records = peer.get("record_hashes", {}) if peer else {}
        if known_records and peer.get("revision", 0) > 0 and peer.get("contact_version") == 1 and peer.get("publisher") == manifest["publisher"]:
            manifest["base_revision"] = peer["revision"]
            manifest["records"] = [r for r in manifest["records"] if known_records.get(f"{r['kind']}:{r['id']}") != hashes[f"{r['kind']}:{r['id']}"]]
            for key in known_records.keys() - hashes.keys():
                kind, rid = key.split(":", 1)
                if kind not in ("person", "event", "profile", "moment", "dupes"):
                    raise TransferError("Invalid record inventory")
                manifest["records"].append({"kind": kind, "id": rid, "data": None})
        known_photos = set(peer.get("photo_hashes", [])) if peer else set()
        photos = {h: p for h, p in photos.items() if h not in known_photos}
        manifest["contact_wire"] = 1
        compact_history = peer is None or peer.get("contact_wire", 0) >= 1
        data = encrypt(pack(manifest, photos if include_photos else None, compact_history=compact_history), password)
    write_file(path, data)
    conn.commit()
    return {"records": len(records), "updated": len(manifest["records"]), "changes": len(graph["commits"]),
            "photos": len(photos) if include_photos else 0, "bytes": len(data)}


class _Transaction:
    """ops.apply's internal commits must not split an edit from its UUID receipt."""
    def __init__(self, conn):
        self.conn = conn

    def commit(self):
        pass

    def __getattr__(self, name):
        return getattr(self.conn, name)


def _fact_state(conn: sqlite3.Connection) -> dict:
    """What a memory file's event records don't say: facts past their first generation, and forgotten ones."""
    moved = {str(r["id"]): r["generation"] for r in conn.execute("SELECT id, generation FROM events WHERE status = 'active' AND generation > 1")}
    forgotten = [dict(r) for r in conn.execute(
        "SELECT p.contact_uid, e.type, e.value, e.date, e.generation FROM events e JOIN people p ON p.id = e.person_id "
        "WHERE e.status = 'rejected' AND p.contact_uid IS NOT NULL AND p.contact_uid != ''")]
    return {"generations": moved, "forgotten": forgotten}


def _merge_facts(conn: sqlite3.Connection, manifest: dict) -> dict:
    """Join the other Mac's notes and facts in, under the contact they belong to. See events.reconcile."""
    from .events import reconcile
    from .extract import NOTE_READ
    from .identity import canonical

    records = manifest.get("records", [])
    state = manifest.get("fact_state") or {}
    generations = state.get("generations") or {}
    uids = {r["id"]: r["data"].get("contact_uid") for r in records if r.get("kind") == "person"}

    def person(uid):
        row = conn.execute("SELECT id FROM people WHERE contact_uid = ?", (uid,)).fetchone() if uid else None
        return canonical(conn, row["id"]) if row else None

    def join(uid, fact, generation):
        pid = person(uid)
        if pid is None or not isinstance(fact.get("value"), str) or not fact["value"].strip() or not isinstance(generation, int):
            return
        # Marked read: the Mac that wrote a note reads it for facts, and they arrive from there.
        counts[reconcile(conn, pid, fact, generation, NOTE_READ if fact.get("type") == "note" else None)] += 1

    counts = {"added": 0, "forgotten": 0, None: 0}
    for r in records:
        if r.get("kind") == "event":
            join(uids.get(str(r["data"].get("person_id"))), r["data"], generations.get(r["id"], 1))
    for fact in state.get("forgotten") or []:
        join(fact.get("contact_uid"), fact, fact.get("generation"))
    return {"facts_added": counts["added"], "facts_forgotten": counts["forgotten"]}


def merge_snapshot(conn: sqlite3.Connection, path: Path, password: str) -> dict:
    """Join an empty CLI or reconcile a trusted peer's complete graph.

    Raw conversations, decisions, provenance, full assets and retractions travel
    with contacts. A foreign existing collection is never implicitly combined.
    """
    from . import replica
    if path.stat().st_size > MAX_FILE:
        raise TransferError("Transfer exceeds the safe size limit.")
    manifest = unpack(decrypt(path.read_bytes(), password))
    validate_inventory(manifest)
    if manifest.get("type") != "snapshot" or (manifest.get("graph") is None and manifest.get("contact_version") != 1):
        raise TransferError("Choose a memory file with a versioned graph.")
    source, _ = _prepare(conn)
    empty = not conn.execute("SELECT 1 FROM people LIMIT 1").fetchone() and not replica.load(conn).changes
    if source != manifest["source"] and not empty:
        raise TransferError("This memory belongs to a different address book. Clone into an empty --db instead.")
    try:
        if manifest.get("graph") is not None:
            from . import graph_runtime
            before_people = conn.execute("SELECT count(*) FROM people").fetchone()[0]
            fact_query = "SELECT type,value,date,source FROM events WHERE status=?"
            before_facts = {tuple(row) for row in conn.execute(fact_query, ('active',))}
            before_forgotten = {tuple(row) for row in conn.execute(fact_query, ('rejected',))}
            with conn:
                graph_runtime.receive(conn, manifest["graph"])
                conn.execute("UPDATE transfer_state SET source=? WHERE slot=1", (manifest["source"],))
            graph = graph_runtime.capture(conn)
            conn.commit()
            conflicts = len({target for target, prop in graph.versions if graph.conflicted(target, prop)})
            return {"contacts": max(0, conn.execute("SELECT count(*) FROM people").fetchone()[0] - before_people),
                    "conflicts": conflicts,
                    "facts_added": len({tuple(row) for row in conn.execute(fact_query, ('active',))} - before_facts),
                    "facts_forgotten": len({tuple(row) for row in conn.execute(fact_query, ('rejected',))} - before_forgotten)}
        with conn:
            history = replica.capture(conn)
            combined = replica.receive(conn, manifest.get("contact_history", []))
            if not combined.past(manifest.get("contact_heads", [])).issuperset(c["id"] for c in manifest.get("contact_history", [])):
                raise ValueError("Invalid contact history frontier")
            conn.execute("UPDATE transfer_state SET source=? WHERE slot=1", (manifest["source"],))
            facts = _merge_facts(conn, manifest)
        conflicts = sum(bool(combined.contact(uid).conflicts) for uid in {c["contact_uid"] for c in combined.changes} if combined.contact(uid))
        return {"contacts": len(combined.changes) - len(history.changes), "conflicts": conflicts, **facts}
    except (ValueError, TypeError) as exc:
        raise TransferError(str(exc)) from exc


def import_edits(conn: sqlite3.Connection, path: Path, password: str, *, enrich: bool = True) -> dict:
    if path.stat().st_size > MAX_FILE:
        raise TransferError("Transfer exceeds the safe size limit.")
    return apply_edits(conn, path.read_bytes(), password, enrich=enrich)


def apply_edits(conn: sqlite3.Connection, encrypted: bytes, password: str, *, enrich: bool = True) -> dict:
    """Apply a fully received encrypted bundle, from a file or a Bluetooth session."""
    if len(encrypted) > MAX_FILE:
        raise TransferError("Transfer exceeds the safe size limit.")
    manifest = unpack(decrypt(encrypted, password))
    source, _ = _prepare(conn)
    if manifest.get("type") != "edits" or manifest.get("source") != source:
        raise TransferError("These edits belong to a different Mac database, or this is not an edits file.")
    validate_inventory(manifest)
    pending = manifest.get("ops")
    if not isinstance(pending, list) or len(pending) > 10_000:
        raise TransferError("Invalid edit list.")
    publisher = conn.execute("SELECT publisher FROM transfer_state WHERE slot=1").fetchone()[0]
    foreign = manifest.get("publisher") not in (None, publisher)
    validated = []
    seen_ids = set()
    for op in pending:
        if not isinstance(op, dict) or op.get("kind") not in ops.KINDS or not isinstance(op.get("payload"), dict):
            raise TransferError("Invalid edit operation.")
        try:
            uuid.UUID(op["client_id"])
        except (KeyError, ValueError, TypeError, AttributeError):
            raise TransferError("Invalid edit identifier.") from None
        if op["client_id"] in seen_ids:
            raise TransferError("Duplicate edit identifier.")
        seen_ids.add(op["client_id"])
        payload = json.dumps(op["payload"], sort_keys=True)
        fingerprint = hashlib.sha256((op["kind"] + payload).encode()).hexdigest()
        previous = conn.execute("SELECT fingerprint FROM transfer_applied WHERE client_id = ?", (op["client_id"],)).fetchone()
        if previous and previous["fingerprint"] != fingerprint:
            raise TransferError("An edit identifier was reused for different content.")
        if op["kind"] == "contact_change" and op["client_id"] != op["payload"].get("id"):
            raise TransferError("Contact operation and change identifiers must match.")
        validated.append((op, payload, fingerprint, previous is not None))
    from . import replica
    if manifest.get("contact_version", 0) not in (0, 1):
        raise TransferError("Unsupported contact history version")
    if manifest.get("graph") is not None:
        from . import graph_runtime
        try:
            with conn:
                graph_runtime.receive(conn, manifest["graph"])
        except (ValueError, TypeError) as exc:
            raise TransferError(str(exc)) from exc
    elif manifest.get("contact_version") == 1:
        try:
            with conn:
                history = replica.capture(conn)
                if manifest.get("contact_history"):
                    history = replica.receive(conn, manifest["contact_history"])
                if not history.past(manifest.get("contact_heads", [])).issuperset(c["id"] for c in manifest.get("contact_history", [])):
                    raise ValueError("Invalid contact history frontier")
        except (ValueError, TypeError) as exc:
            raise TransferError(str(exc)) from exc
    stats = {"applied": 0, "failed": 0, "already_applied": 0, "deferred": 0}
    for op, payload, fingerprint, previous in sorted(validated, key=lambda item: item[0]["kind"] in ops.ENRICHMENT):
        if previous:
            stats["already_applied"] += 1
            continue
        if op["kind"] in ops.ENRICHMENT and not enrich:
            stats["deferred"] += 1
            continue
        if foreign and not ops.portable(op):
            # Names a row on the Mac it came from. It stays queued on the phone until they next sync.
            stats["deferred"] += 1
            continue
        conn.execute("BEGIN IMMEDIATE")
        try:
            message = ops.apply(_Transaction(conn), op["kind"], op["payload"])
            status = "done"
        except ops.OpError as exc:
            conn.rollback()
            status, message = "failed", str(exc)
        except Exception:
            conn.rollback()
            # Leave retryable model/network failures queued, not permanently rejected.
            stats["deferred"] += 1
            continue
        conn.execute("INSERT INTO transfer_applied VALUES (?, ?, ?, ?, ?, ?)",
                     (op["client_id"], fingerprint, op["kind"], payload, status, message))
        conn.commit()
        stats["applied" if status == "done" else "failed"] += 1
    return stats
