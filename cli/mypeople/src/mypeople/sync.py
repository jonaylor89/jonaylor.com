"""`mypeople sync`: this Mac's side of syncing with the server.

First it applies what phones queued (edits, then enrichment requests), so the push that
follows already includes their results. Then it pushes whatever changed in the published
view since the last push, and uploads photos the server doesn't have yet.
"""

from __future__ import annotations

import json
import os
import sqlite3
import urllib.error
import urllib.request
from pathlib import Path

from . import ops, publish

CONFIG = Path(os.environ.get("MYPEOPLE_SYNC_CONFIG", Path.home() / ".mypeople" / "sync.json"))
BATCH = 1000
TIMEOUT = 120

SCHEMA = """
CREATE TABLE IF NOT EXISTS sync_pushed (
    kind TEXT NOT NULL,
    id   TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (kind, id)
);
-- Operations already applied here, in case the server didn't hear the result.
CREATE TABLE IF NOT EXISTS sync_applied (
    op_id   INTEGER PRIMARY KEY,
    ok      INTEGER NOT NULL,
    message TEXT NOT NULL
);
"""


class SyncError(RuntimeError):
    pass


def save_config(url: str, token: str, path: Path = CONFIG) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"url": url.rstrip("/"), "token": token}))
    path.chmod(0o600)


def load_config(path: Path = CONFIG) -> dict:
    if not path.exists():
        raise SyncError("Not set up yet. Run `mypeople sync setup URL TOKEN` with a token from `mypeople server add-device`.")
    return json.loads(path.read_text())


class Client:
    def __init__(self, url: str, token: str):
        self.url, self.token = url.rstrip("/"), token

    def request(self, method: str, path: str, body: dict | None = None, data: bytes | None = None) -> dict:
        if body is not None:
            data = json.dumps(body, ensure_ascii=False).encode()
        req = urllib.request.Request(self.url + path, data=data, method=method)
        req.add_header("Authorization", f"Bearer {self.token}")
        req.add_header("Content-Type", "application/json" if body is not None else "application/octet-stream")
        try:
            with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
                return json.loads(resp.read())
        except urllib.error.HTTPError as e:
            try:
                detail = json.loads(e.read()).get("error", "")
            except ValueError:
                detail = ""
            raise SyncError(f"The server said {e.code} {detail}".strip()) from None
        except (urllib.error.URLError, OSError) as e:
            raise SyncError(f"Couldn't reach the server at {self.url}: {getattr(e, 'reason', e)}") from None


def _prepare(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA)


def apply_ops(conn: sqlite3.Connection, client: Client, enrich: bool = True, report=print) -> int:
    """Apply queued operations in order. Enrichment waits for the edits, and is skipped without enrich."""
    _prepare(conn)
    queued = client.request("GET", "/v1/ops/pending")["ops"]
    queued.sort(key=lambda o: (o["kind"] in ops.ENRICHMENT, o["id"]))
    done = 0
    for op in queued:
        if op["kind"] in ops.ENRICHMENT and not enrich:
            continue
        seen = conn.execute("SELECT ok, message FROM sync_applied WHERE op_id = ?", (op["id"],)).fetchone()
        if seen:
            ok, message = bool(seen["ok"]), seen["message"]
        else:
            try:
                message, ok = ops.apply(conn, op["kind"], op["payload"]), True
            except ops.OpError as e:
                conn.rollback()
                message, ok = str(e), False
            except Exception as e:  # a failed model call or search shouldn't stop the rest
                conn.rollback()
                message, ok = f"Failed: {e}", False
            conn.execute("INSERT INTO sync_applied (op_id, ok, message) VALUES (?, ?, ?)", (op["id"], int(ok), message))
            conn.commit()
        client.request("POST", f"/v1/ops/{op['id']}/result", {"ok": ok, "message": message})
        report(f"  {op['kind']}: {message}")
        done += 1
    return done


def push(conn: sqlite3.Connection, client: Client, report=print) -> dict[str, int]:
    """Send records that changed since the last push, deletions, and new photos."""
    _prepare(conn)
    from . import replica
    replica.capture(conn)
    conn.commit()
    current, files = publish.records(conn)
    hashes = {key: publish.digest(data) for key, data in current.items()}
    pushed = {(r["kind"], r["id"]): r["hash"] for r in conn.execute("SELECT kind, id, hash FROM sync_pushed")}

    missing = client.request("POST", "/v1/photos/missing", {"hashes": sorted(files)})["missing"]
    for digest in missing:
        client.request("PUT", f"/v1/photos/{digest}", data=Path(files[digest]).read_bytes())

    upserts = [key for key, h in hashes.items() if pushed.get(key) != h]
    deletes = [key for key in pushed if key not in current]
    for start in range(0, len(upserts), BATCH):
        batch = upserts[start:start + BATCH]
        client.request("POST", "/v1/push", {"upserts": [{"kind": k, "id": i, "data": current[(k, i)]} for k, i in batch]})
        conn.executemany("INSERT OR REPLACE INTO sync_pushed (kind, id, hash) VALUES (?, ?, ?)",
                         [(k, i, hashes[(k, i)]) for k, i in batch])
        conn.commit()
    for start in range(0, len(deletes), BATCH):
        batch = deletes[start:start + BATCH]
        client.request("POST", "/v1/push", {"deletes": [{"kind": k, "id": i} for k, i in batch]})
        conn.executemany("DELETE FROM sync_pushed WHERE kind = ? AND id = ?", batch)
        conn.commit()
    return {"records": len(current), "updated": len(upserts), "deleted": len(deletes), "photos": len(missing)}


def sync(conn: sqlite3.Connection, client: Client, enrich: bool = True, report=print) -> dict[str, int]:
    applied = apply_ops(conn, client, enrich, report)
    return {"applied": applied, **push(conn, client, report)}
