"""The sync server: holds what the Mac publishes and queues what the phone asks for.

It runs on an always-on machine you own (`mypeople server run`) and never sees message text.
The Mac pushes records and photos and applies queued operations; phones read changes and
queue operations. Every change gets a version from one counter, so a client asks for
"everything since version N" and gets record updates, deletions, and operation results alike.

Each device has its own bearer token (only its hash is stored) and a role, mac or phone.
It speaks plain HTTP: bind it to localhost and put it behind `tailscale serve` for HTTPS.
"""

from __future__ import annotations

import hashlib
import json
import re
import secrets
import sqlite3
import threading
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO meta (key, value) VALUES ('version', 0);

-- What the Mac published. data is NULL once deleted, so clients learn about deletions.
CREATE TABLE IF NOT EXISTS records (
    kind    TEXT NOT NULL,
    id      TEXT NOT NULL,
    data    TEXT,
    version INTEGER NOT NULL,
    PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS records_version ON records (version);

-- Edits and enrichment requests from phones, waiting for the Mac.
CREATE TABLE IF NOT EXISTS ops (
    id         INTEGER PRIMARY KEY,
    client_id  TEXT NOT NULL UNIQUE,
    device     TEXT NOT NULL,
    kind       TEXT NOT NULL,
    payload    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',  -- pending | done | failed
    message    TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    done_at    TEXT,
    version    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ops_version ON ops (version);

CREATE TABLE IF NOT EXISTS devices (
    name       TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    role       TEXT NOT NULL CHECK (role IN ('mac', 'phone')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_seen  TEXT
);
"""

KINDS = ("person", "event", "profile", "moment", "dupes", "contact_change")
CHANGES_LIMIT = 2000
MAX_BODY = 32 * 1024 * 1024
MAX_PHOTO = 10 * 1024 * 1024
HASH = re.compile(r"[0-9a-f]{64}")


def default_dir() -> Path:
    return Path.home() / ".mypeople-server"


def _hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


class Store:
    """The server's database and photo folder. One lock serializes writes."""

    def __init__(self, root: Path):
        self.root = root
        self.photos = root / "photos"
        self.photos.mkdir(parents=True, exist_ok=True)
        root.chmod(0o700)
        self.conn = sqlite3.connect(root / "server.db", check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self.conn.executescript(SCHEMA)
        self.lock = threading.Lock()

    # --- devices ------------------------------------------------------------------------

    def add_device(self, name: str, role: str) -> str:
        if role not in ("mac", "phone"):
            raise ValueError("role must be mac or phone")
        token = secrets.token_urlsafe(32)
        with self.lock, self.conn:
            self.conn.execute("INSERT INTO devices (name, token_hash, role) VALUES (?, ?, ?)", (name, _hash(token), role))
        return token

    def remove_device(self, name: str) -> bool:
        with self.lock, self.conn:
            return self.conn.execute("DELETE FROM devices WHERE name = ?", (name,)).rowcount > 0

    def devices(self) -> list[sqlite3.Row]:
        return self.conn.execute("SELECT name, role, created_at, last_seen FROM devices ORDER BY name").fetchall()

    def device(self, token: str) -> sqlite3.Row | None:
        with self.lock, self.conn:
            row = self.conn.execute("SELECT name, role FROM devices WHERE token_hash = ?", (_hash(token),)).fetchone()
            if row:
                self.conn.execute("UPDATE devices SET last_seen = datetime('now') WHERE name = ?", (row["name"],))
            return row

    # --- versions -----------------------------------------------------------------------

    def _bump(self) -> int:
        self.conn.execute("UPDATE meta SET value = value + 1 WHERE key = 'version'")
        return self.conn.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()[0]

    def version(self) -> int:
        return self.conn.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()[0]

    # --- records ------------------------------------------------------------------------

    def push(self, upserts: list[dict], deletes: list[dict]) -> int:
        """Store what the Mac sends. Unchanged records keep their version, so clients don't refetch them."""
        changed = 0
        with self.lock, self.conn:
            for r in upserts:
                kind, rid, data = r["kind"], str(r["id"]), json.dumps(r["data"], sort_keys=True, ensure_ascii=False)
                if kind not in KINDS:
                    raise ValueError(f"unknown kind {kind!r}")
                current = self.conn.execute("SELECT data FROM records WHERE kind = ? AND id = ?", (kind, rid)).fetchone()
                if current and current["data"] == data:
                    continue
                self.conn.execute(
                    "INSERT INTO records (kind, id, data, version) VALUES (?, ?, ?, ?) "
                    "ON CONFLICT (kind, id) DO UPDATE SET data = excluded.data, version = excluded.version",
                    (kind, rid, data, self._bump()),
                )
                changed += 1
            for r in deletes:
                cur = self.conn.execute(
                    "UPDATE records SET data = NULL, version = ? WHERE kind = ? AND id = ? AND data IS NOT NULL",
                    (self.version() + 1, r["kind"], str(r["id"])),
                )
                if cur.rowcount:
                    self._bump()
                    changed += 1
        return changed

    def changes(self, since: int, limit: int = CHANGES_LIMIT) -> dict:
        """Records and operations changed after `since`, up to a cursor with nothing missing below it."""
        with self.lock:
            return self._changes(since, limit)

    def _changes(self, since: int, limit: int) -> dict:
        records = self.conn.execute(
            "SELECT kind, id, data, version FROM records WHERE version > ? ORDER BY version LIMIT ?", (since, limit)
        ).fetchall()
        ops = self.conn.execute(
            "SELECT id, client_id, kind, payload, status, message, version FROM ops WHERE version > ? ORDER BY version LIMIT ?",
            (since, limit),
        ).fetchall()
        # A full page might stop short of later changes in the other list; don't skip past those.
        cursor = self.version()
        for rows in (records, ops):
            if len(rows) == limit:
                cursor = min(cursor, rows[-1]["version"])
        return {
            "cursor": cursor,
            "more": cursor < self.version(),
            "records": [
                {"kind": r["kind"], "id": r["id"], "data": json.loads(r["data"]) if r["data"] else None}
                for r in records if r["version"] <= cursor
            ],
            "ops": [_op(o) for o in ops if o["version"] <= cursor],
        }

    # --- operations ---------------------------------------------------------------------

    def add_ops(self, device: str, ops: list[dict]) -> list[dict]:
        """Queue operations. Resending one with the same client_id is harmless."""
        out = []
        with self.lock, self.conn:
            for op in ops:
                client_id, kind, payload = str(op["client_id"]), str(op["kind"]), op.get("payload") or {}
                if not isinstance(payload, dict):
                    raise ValueError("payload must be an object")
                cur = self.conn.execute(
                    "INSERT OR IGNORE INTO ops (client_id, device, kind, payload, version) VALUES (?, ?, ?, ?, ?)",
                    (client_id, device, kind, json.dumps(payload), self.version() + 1),
                )
                if cur.rowcount:
                    self._bump()
                out.append(_op(self.conn.execute("SELECT * FROM ops WHERE client_id = ?", (client_id,)).fetchone()))
        return out

    def pending(self) -> list[dict]:
        with self.lock:
            return [_op(o) for o in self.conn.execute("SELECT * FROM ops WHERE status = 'pending' ORDER BY id")]

    def finish(self, op_id: int, ok: bool, message: str) -> bool:
        with self.lock, self.conn:
            cur = self.conn.execute(
                "UPDATE ops SET status = ?, message = ?, done_at = datetime('now'), version = ? WHERE id = ?",
                ("done" if ok else "failed", message, self.version() + 1, op_id),
            )
            if cur.rowcount:
                self._bump()
            return cur.rowcount > 0

    # --- photos -------------------------------------------------------------------------

    def missing_photos(self, hashes: list[str]) -> list[str]:
        return [h for h in hashes if HASH.fullmatch(h) and not (self.photos / h).exists()]

    def put_photo(self, digest: str, data: bytes) -> None:
        if not HASH.fullmatch(digest) or hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("photo doesn't match its hash")
        tmp = self.photos / f".{digest}.tmp"
        tmp.write_bytes(data)
        tmp.replace(self.photos / digest)

    def photo(self, digest: str) -> bytes | None:
        path = self.photos / digest
        return path.read_bytes() if HASH.fullmatch(digest) and path.exists() else None


def _op(o: sqlite3.Row) -> dict:
    return {"id": o["id"], "client_id": o["client_id"], "kind": o["kind"], "payload": json.loads(o["payload"]),
            "status": o["status"], "message": o["message"]}


class Handler(BaseHTTPRequestHandler):
    store: Store  # set on the subclass made by serve()
    server_version = "mypeople"

    def log_message(self, format, *args):  # keep request lines (and their ids) out of the console
        pass

    def _send(self, status: int, body: dict | bytes, content_type: str = "application/json") -> None:
        data = body if isinstance(body, bytes) else json.dumps(body, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        if content_type != "application/json":
            self.send_header("Cache-Control", "private, max-age=31536000, immutable")  # photos never change
        self.end_headers()
        self.wfile.write(data)

    def _error(self, status: int, message: str) -> None:
        self._send(status, {"error": message})

    def _body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            raise ValueError("request too large")
        return self.rfile.read(length)

    def _device(self, *roles: str) -> sqlite3.Row | None:
        auth = self.headers.get("Authorization", "")
        device = self.store.device(auth.removeprefix("Bearer ").strip()) if auth.startswith("Bearer ") else None
        if device is None:
            self._error(HTTPStatus.UNAUTHORIZED, "unknown device")
            return None
        if roles and device["role"] not in roles:
            self._error(HTTPStatus.FORBIDDEN, f"only a {' or '.join(roles)} device can do that")
            return None
        return device

    def _route(self, method: str) -> None:
        path, _, query = self.path.partition("?")
        params = dict(p.partition("=")[::2] for p in query.split("&") if p)
        try:
            if method == "GET" and path == "/v1/health":
                return self._send(HTTPStatus.OK, {"ok": True})
            if method == "GET" and path == "/v1/changes":
                if self._device():
                    self._send(HTTPStatus.OK, self.store.changes(int(params.get("since", 0) or 0)))
                return
            if method == "GET" and path.startswith("/v1/photos/"):
                if self._device():
                    data = self.store.photo(path.rsplit("/", 1)[1])
                    self._send(HTTPStatus.OK, data, "image/jpeg") if data else self._error(HTTPStatus.NOT_FOUND, "no such photo")
                return
            if method == "POST" and path == "/v1/ops":
                if device := self._device():
                    ops = json.loads(self._body())["ops"]
                    self._send(HTTPStatus.OK, {"ops": self.store.add_ops(device["name"], ops)})
                return
            if method == "GET" and path == "/v1/ops/pending":
                if self._device("mac"):
                    self._send(HTTPStatus.OK, {"ops": self.store.pending()})
                return
            if method == "POST" and (m := re.fullmatch(r"/v1/ops/(\d+)/result", path)):
                if self._device("mac"):
                    body = json.loads(self._body())
                    found = self.store.finish(int(m.group(1)), bool(body["ok"]), str(body.get("message") or ""))
                    self._send(HTTPStatus.OK, {"ok": True}) if found else self._error(HTTPStatus.NOT_FOUND, "no such op")
                return
            if method == "POST" and path == "/v1/push":
                if self._device("mac"):
                    body = json.loads(self._body())
                    changed = self.store.push(body.get("upserts", []), body.get("deletes", []))
                    self._send(HTTPStatus.OK, {"changed": changed, "version": self.store.version()})
                return
            if method == "POST" and path == "/v1/photos/missing":
                if self._device("mac"):
                    self._send(HTTPStatus.OK, {"missing": self.store.missing_photos(json.loads(self._body())["hashes"])})
                return
            if method == "PUT" and path.startswith("/v1/photos/"):
                if self._device("mac"):
                    body = self._body()
                    if len(body) > MAX_PHOTO:
                        return self._error(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "photo too large")
                    self.store.put_photo(path.rsplit("/", 1)[1], body)
                    self._send(HTTPStatus.OK, {"ok": True})
                return
            self._error(HTTPStatus.NOT_FOUND, "not found")
        except (ValueError, KeyError, TypeError) as e:  # includes bad JSON
            self._error(HTTPStatus.BAD_REQUEST, str(e) or type(e).__name__)

    def do_GET(self):
        self._route("GET")

    def do_POST(self):
        self._route("POST")

    def do_PUT(self):
        self._route("PUT")


def make_server(store: Store, host: str = "127.0.0.1", port: int = 8765) -> ThreadingHTTPServer:
    handler = type("BoundHandler", (Handler,), {"store": store})
    server = ThreadingHTTPServer((host, port), handler)
    server.daemon_threads = True
    return server
