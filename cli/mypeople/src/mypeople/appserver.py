"""`mypeople app-server`: the local engine behind the macOS app.

The app contains no domain logic that can change data. It starts this as a child process and
speaks newline-delimited JSON over stdin/stdout: no sockets, and it dies with the app.

    → {"id": 7, "method": "contact.save", "params": {...}}
    ← {"event": "view.delta", "params": {...}}     (sent first, so the edit is visible on return)
    ← {"id": 7, "result": {...}}                   or {"id": 7, "error": {"code", "message"}}

Requests run on one of two lanes. The serial lane owns one SQLite connection and handles every
edit in order. The slow lane gives each call a thread of its own, for work that mustn't hold up
editing. A third thread keeps the view current when anything else commits to the database. See
docs/mypeople/macos.md.
"""

from __future__ import annotations

import base64
import datetime as dt
import hashlib
import importlib.metadata
import importlib.util
import json
import math
import os
import queue
import shutil
import signal
import sqlite3
import sys
import threading
import time
import traceback
import uuid
from pathlib import Path
from typing import Callable

from . import appjobs, contacts, db, identity, llm, moments, ops, publish, replica

PROTOCOL = 4
POLL_SECONDS = 2.0
MIN_REFRESH_SECONDS = 5.0
REFRESH_BACKOFF = 5  # never spend more than a fifth of the time refreshing
STOP_SECONDS = 5
HIDDEN_CARD_KEYS = ("photo", "originals", "source_records")  # large; the editor loads the full card
HISTORY_LIMIT = 200
# Edits the app may send straight to ops.apply. Contact edits go through replica instead, as
# `mypeople contact` does, so they enter causal history immediately. Model-backed operations
# are jobs.
SECRET_KEYS = ("ANTHROPIC_API_KEY",)
EDIT_KINDS = ("alias_add", "alias_remove", "event_add", "event_forget", "note", "relationship", "profile_status",
              "distinct", "moment_status", "merge_undo")
Key = tuple[str, str]


class RpcError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _today() -> dt.date:
    return dt.date.today()


# --- framing ------------------------------------------------------------------------------

def _finite(value):
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    return value


def encode(frame: dict) -> bytes:
    """One line of valid UTF-8 JSON, whatever an imported name or a model's float contained."""
    try:
        text = json.dumps(frame, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except ValueError:
        text = json.dumps(_finite(frame), ensure_ascii=False, separators=(",", ":"))
    return text.encode("utf-8", "replace") + b"\n"


# --- the view -----------------------------------------------------------------------------

def fingerprint(card: dict) -> str:
    return hashlib.sha256(replica.encoded(card).encode("utf-8", "replace")).hexdigest()


class View:
    """The latest published view, and what it takes to bring the app up to date with it."""

    def __init__(self, avatars: Path):
        self.avatars = avatars
        self.records: dict[Key, dict] = {}
        self.version = 0
        self.lock = threading.Lock()  # also held while sending, so frames can't overtake each other
        self.ready = threading.Event()
        self.hashes: dict[tuple, str | None] = {}
        self.dials: dict[tuple, tuple[str, str]] = {}

    def _hash(self, path: str) -> str | None:
        """Photos are large and rarely change; rehashing all of them on every refresh is the slow part."""
        try:
            stat = os.stat(path)
        except OSError:
            return None
        key = (path, stat.st_mtime_ns, stat.st_size)
        if key not in self.hashes:
            self.hashes[key] = publish.photo_hash(path)
        return self.hashes[key]

    def _card_photo(self, encoded: str) -> str | None:
        """A photo chosen in the contact editor lives inside its card; give the app a file."""
        try:
            data = base64.b64decode(encoded, validate=True)
        except ValueError:
            return None
        path = self.avatars / f"{hashlib.sha256(data).hexdigest()}{'.png' if data.startswith(b'\x89PNG') else '.jpg'}"
        if not path.exists():
            self.avatars.mkdir(parents=True, exist_ok=True, mode=0o700)
            temp = path.with_suffix(f".{uuid.uuid4().hex}.tmp")
            temp.write_bytes(data)
            temp.chmod(0o600)
            temp.replace(path)
        return str(path)

    def _with_dial(self, card: dict, field: dict) -> dict:
        """Where a Call or Message button should go. Empty means don't guess: check the number first."""
        if field.get("kind") != "phone":
            return field
        key = (field.get("value"), field.get("region"), card.get("region"), bool(card.get("legacy_unverified")))
        if key not in self.dials:
            self.dials[key] = contacts.contact_phone(card, field)
        number, extension = self.dials[key]
        return {**field, "dial": number, "dial_ext": extension}

    def _present(self, key: Key, data: dict, files: dict[str, str]) -> dict:
        if key[0] != "person":
            return data
        card = data.get("card")
        avatar = self._card_photo(card["photo"]) if card and card.get("photo") else None
        slim = None
        if card:
            slim = {k: v for k, v in card.items() if k not in HIDDEN_CARD_KEYS}
            slim["fields"] = [self._with_dial(card, f) for f in card.get("fields", [])]
        return {**data, "card": slim, "avatar_path": avatar or files.get(data.get("photo") or "")}

    def build(self, conn: sqlite3.Connection, people: set[int] | None = None) -> dict[Key, dict]:
        out, files = publish.records(conn, people=people, hash_photo=self._hash)
        return {key: self._present(key, data, files) for key, data in out.items() if key[0] != "contact_change"}

    def diff(self, new: dict[Key, dict], people: set[int] | None = None) -> dict | None:
        """Adopt `new` (a part of the view if `people` is given) and describe the change. Hold the lock."""
        if people is None:
            old = self.records
        else:
            old = {k: v for k, v in self.records.items()
                   if (int(k[1]) in people if k[0] == "person" else v.get("person_id") in people)}
        upserts = [{"kind": k[0], "id": k[1], "data": v} for k, v in new.items() if self.records.get(k) != v]
        deletes = [{"kind": k[0], "id": k[1]} for k in old if k not in new]
        if people is None:
            self.records = dict(new)
        else:
            for item in deletes:
                self.records.pop((item["kind"], item["id"]), None)
            self.records.update(new)
        if not upserts and not deletes:
            return None
        self.version += 1
        return {"version": self.version, "upserts": upserts, "deletes": deletes}

    def snapshot(self) -> dict:
        return {"version": self.version, "records": [{"kind": k[0], "id": k[1], "data": v} for k, v in self.records.items()]}


# --- the engine ---------------------------------------------------------------------------

METHODS: dict[str, tuple[Callable, str]] = {}


def method(name: str, lane: str = "serial"):
    def register(fn):
        METHODS[name] = (fn, lane)
        return fn
    return register


def _text(p: dict, key: str) -> str:
    value = p.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RpcError("invalid", f"{key} is missing")
    return value.strip()


def _int(p: dict, key: str) -> int:
    value = p.get(key)
    if not isinstance(value, int) or isinstance(value, bool):
        raise RpcError("invalid", f"{key} must be a number")
    return value


def _ints(p: dict, key: str, minimum: int = 1) -> list[int]:
    values = p.get(key)
    if not isinstance(values, list) or len(values) < minimum or not all(isinstance(v, int) and not isinstance(v, bool) for v in values):
        raise RpcError("invalid", f"{key} must list at least {minimum}")
    return list(dict.fromkeys(values))


class Engine:
    def __init__(self, db_path: Path, emit: Callable[[bytes], None], *, poll: float = POLL_SECONDS,
                 min_refresh: float = MIN_REFRESH_SECONDS):
        self.db_path = db_path
        self.emit = emit
        self.poll, self.min_refresh = poll, min_refresh
        self.view = View(db_path.parent / "app-cache" / "avatars")
        self.jobs = appjobs.JobRunner(self.event, db_path, on_finished=self.wake_refresh)
        self.requests: queue.Queue = queue.Queue()
        self.connected = threading.Event()
        self.stopping = threading.Event()
        self.wake = threading.Event()
        self.edits = 0  # how many scoped updates have landed; a full refresh that overlaps one is stale
        self.touched: set[int] = set()  # people the running serial handler changed
        self.view_error: str | None = None
        self.initialization_error: Exception | None = None
        self.conn: sqlite3.Connection | None = None

    # --- sending ---

    def send(self, frame: dict) -> None:
        self.emit(encode(frame))

    def event(self, name: str, params: dict) -> None:
        self.send({"event": name, "params": params})

    def _publish(self, new: dict[Key, dict], people: set[int] | None = None) -> None:
        with self.view.lock:
            if (delta := self.view.diff(new, people)) is not None:
                self.event("view.delta", delta)

    # --- lanes ---

    def start(self) -> None:
        self.serial = threading.Thread(target=self._serial_lane, name="serial", daemon=True)
        self.serial.start()
        threading.Thread(target=self._view_loop, name="view", daemon=True).start()
        self.wake.set()  # the first refresh shouldn't wait for a poll

    def submit(self, frame: dict) -> None:
        """Route one request. Called only from the thread reading stdin."""
        entry = METHODS.get(frame.get("method"))
        if frame.get("method") == "view.snapshot":
            threading.Thread(target=self._snapshot, args=(frame.get("id"),), daemon=True).start()
        elif entry is None:
            self.send({"id": frame.get("id"), "error": {"code": "unknown_method", "message": f"No method {frame.get('method')!r}"}})
        elif entry[1] == "slow":
            threading.Thread(target=self._slow, args=(frame, entry[0]), daemon=True).start()
        elif entry[1] == "now":
            self._respond(frame, entry[0], None)
        else:
            self.requests.put(frame)

    def _respond(self, frame: dict, handler: Callable, conn: sqlite3.Connection | None) -> None:
        id = frame.get("id")
        params = frame.get("params") or {}
        serial = conn is not None and conn is self.conn
        try:
            if not isinstance(params, dict):
                raise RpcError("invalid", "params must be an object")
            result = handler(self, conn, params)
            if conn is not None and conn.in_transaction:
                conn.commit()
        except Exception as exc:  # the engine outlives any one bad request
            if conn is not None:
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
            if serial:
                self.touched.clear()
            self.send({"id": id, "error": _error(exc)})
            return
        # Before the response: when the caller's await returns, its edit is already on screen.
        if serial and self.touched:
            people, self.touched = self.touched, set()
            try:
                self._publish(self.view.build(conn, people), people)
                self.edits += 1
            except Exception:
                traceback.print_exc()  # the edit committed, and the next full refresh will show it
        self.send({"id": id, "result": result if result is not None else {}})

    def _snapshot(self, id) -> None:
        self.view.ready.wait()
        if self.view_error:
            self.send({"id": id, "error": _error(RpcError("database", self.view_error))})
            return
        # The lock stays held while the response goes out, so no delta can overtake it.
        with self.view.lock:
            self.send({"id": id, "result": self.view.snapshot()})

    def _serial_lane(self) -> None:
        failure = None
        try:
            self.conn = db.connect(self.db_path)
        except Exception as exc:
            # Graph upgrades can also refuse missing assets/invalid source data.
            # Keep answering RPCs with an actionable error rather than losing the lane.
            failure = RpcError("database", f"Couldn't open {self.db_path}: {exc}")
            self.initialization_error = failure
        finally:
            self.connected.set()  # others connect after this, so only one of us runs migrations
        while (frame := self.requests.get()) is not None:
            if failure:
                self.send({"id": frame.get("id"), "error": _error(failure)})
            else:
                self._respond(frame, METHODS[frame["method"]][0], self.conn)

    def _slow(self, frame: dict, handler: Callable) -> None:
        self.connected.wait()
        if self.initialization_error:
            self.send({"id": frame.get("id"), "error": _error(self.initialization_error)})
            return
        conn = None
        try:
            conn = db.connect(self.db_path)
        except Exception as exc:
            self.send({"id": frame.get("id"), "error": _error(RpcError("database", str(exc)))})
            return
        try:
            self._respond(frame, handler, conn)
        finally:
            conn.close()

    # --- keeping the view current ---

    def wake_refresh(self) -> None:
        self.wake.set()

    def _view_loop(self) -> None:
        self.connected.wait()
        if self.initialization_error:
            self.view_error = str(self.initialization_error)
            self.view.ready.set()
            return
        try:
            conn = db.connect(self.db_path)
        except Exception as exc:
            self.view_error = f"Couldn't open {self.db_path}: {exc}"
            self.view.ready.set()
            return
        seen_version = seen_day = None
        finished = -math.inf
        wait = 0.0
        while not self.stopping.is_set():
            asked = self.wake.wait(self.poll)
            self.wake.clear()
            try:
                version = conn.execute("PRAGMA data_version").fetchone()[0]
            except sqlite3.Error:
                traceback.print_exc()  # a dead view thread would freeze the app silently
                continue
            day = _today()
            if not asked and version == seen_version and day == seen_day:
                continue
            if time.monotonic() - finished < wait and not asked:
                continue  # still due: seen_version hasn't moved, so a later tick picks this up
            seen_version, seen_day = version, day
            started, edits = time.monotonic(), self.edits
            self.event("view.state", {"refreshing": True})
            stale = False
            try:
                new = self.view.build(conn)
                with self.view.lock:
                    # Built from before an edit landed: go again, or we'd undo it on screen.
                    stale = self.edits != edits
                    if not stale and (delta := self.view.diff(new)) is not None:
                        self.event("view.delta", delta)
                self.view_error = None
            except Exception as exc:
                traceback.print_exc()
                self.view_error = str(exc) if isinstance(exc, sqlite3.Error) else "Couldn't read the database."
                try:
                    conn.rollback()
                except sqlite3.Error:
                    pass
            finished = time.monotonic()
            wait = max(self.min_refresh, (finished - started) * REFRESH_BACKOFF)
            if stale:
                seen_version = None
            else:
                self.view.ready.set()
            self.event("view.state", {"refreshing": False, "error": self.view_error})

    def stop(self) -> None:
        self.stopping.set()
        self.jobs.shutdown()
        self.requests.put(None)
        if threading.current_thread() is not self.serial:
            self.serial.join(STOP_SECONDS)  # let an edit in progress finish


def _error(exc: Exception) -> dict:
    if isinstance(exc, RpcError):
        return {"code": exc.code, "message": str(exc)}
    if isinstance(exc, appjobs.JobError):
        return {"code": "invalid", "message": str(exc)}
    if isinstance(exc, identity.PersonNotFound):
        return {"code": "not_found", "message": str(exc)}
    if isinstance(exc, llm.LLMError):
        return {"code": "model", "message": str(exc)}
    if isinstance(exc, sqlite3.OperationalError) and "locked" in str(exc):
        return {"code": "busy", "message": "The database is busy with another MyPeople process. Nothing was changed; try again."}
    if isinstance(exc, sqlite3.Error):
        return {"code": "database", "message": f"Database error: {exc}"}
    if isinstance(exc, ValueError):  # contacts.validate and ops.OpError speak to the user
        return {"code": "invalid", "message": str(exc)}
    traceback.print_exc()
    return {"code": "internal", "message": f"Something went wrong ({type(exc).__name__}). Nothing was changed."}


# --- app and view -------------------------------------------------------------------------

@method("app.hello", "now")
def hello(self: Engine, conn, p: dict) -> dict:
    return {"protocol": PROTOCOL, "version": _version(), "db": str(self.db_path)}


def _version() -> str:
    try:
        return importlib.metadata.version("mypeople")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


@method("view.refresh", "now")
def view_refresh(self: Engine, conn, p: dict) -> dict:
    self.wake_refresh()
    return {}


def _exists(path: Path) -> bool:
    try:
        return path.exists()
    except OSError:
        return False


def _full_disk_access() -> bool | None:
    """Can this process read another app's data? None when there's nothing there to test against."""
    probe = Path.home() / "Library" / "Messages" / "chat.db"
    try:
        with open(probe, "rb"):
            return True
    except PermissionError:
        return False
    except OSError:
        return None


@method("system.status")
def system_status(self: Engine, conn, p: dict) -> dict:
    from . import google, transfer
    from .importers import imessage, mino, whatsapp

    backend = llm.backend()
    home = Path.home()
    secrets = Path(os.environ.get("MYPEOPLE_ENV_FILE", home / ".mypeople" / "secrets.ini")).expanduser()
    return {
        "db": str(self.db_path),
        "version": _version(),
        "python": sys.version.split()[0],
        "llm": {"backend": backend.name, "model": backend.model, "local": backend.local, "choices": list(llm.BACKENDS)},
        # Whether a credential exists, never its value.
        "secrets": {"path": str(secrets), "exists": _exists(secrets), "keys": {k: bool(os.environ.get(k)) for k in SECRET_KEYS}},
        "pi_auth": _exists(llm.AUTH_PATH),
        "transfer_key": _exists(transfer.KEY_FILE),
        "full_disk_access": _full_disk_access(),
        "extras": {
            "bluetooth": all(importlib.util.find_spec(m) for m in ("IOBluetooth", "qrcode")),
        },
        "sqlcipher": shutil.which("sqlcipher") is not None,
        "sources": {
            "imessage": _exists(imessage.DEFAULT_DB),
            "whatsapp": _exists(whatsapp.DEFAULT_DIR),
            "mino": _exists(mino.DEFAULT_DB),
        },
        "google": {"client": _exists(google.CLIENT_PATH), "signed_in": _exists(google.TOKEN_PATH)},
    }


@method("settings.llm")
def settings_llm(self: Engine, conn, p: dict) -> dict:
    name = _text(p, "backend")
    if name not in llm.BACKENDS:
        raise RpcError("invalid", f"Unknown model backend {name!r}")
    os.environ["MYPEOPLE_LLM"] = name
    return {}


# --- contacts -----------------------------------------------------------------------------

def _uid_person(conn, uid: str) -> int:
    row = conn.execute("SELECT id FROM people WHERE contact_uid = ?", (uid,)).fetchone()
    if row is None:
        raise RpcError("not_found", "That contact no longer exists.")
    return identity.canonical(conn, row["id"])


def _capture_for(self: Engine, conn, uid: str | None) -> replica.History:
    """Capture history before editing a contact. Capturing a recent merge can move its root to the
    other record, and the view has to drop the old one too."""
    row = conn.execute("SELECT id FROM people WHERE contact_uid = ?", (uid,)).fetchone() if uid else None
    if row is not None:
        self.touched.add(identity.canonical(conn, row["id"]))
    return replica.capture(conn)


def _contact(history: replica.History, uid: str) -> replica.Contact:
    contact = history.contact(uid)
    if contact is None:
        raise RpcError("not_found", "That contact no longer exists.")
    return contact


@method("contact.associations")
def contact_associations(self: Engine, conn, p: dict) -> dict:
    from . import graph_runtime
    result = graph_runtime.associations(conn, _text(p, "uid"))
    conn.commit()
    return result


@method("contact.split")
def contact_split(self: Engine, conn, p: dict) -> dict:
    from . import graph_runtime
    uid = _text(p, "uid")
    before = _uid_person(conn, uid)
    try:
        result = graph_runtime.split(conn, uid, _text(p, "name"), p.get("edges"), heads=p.get("heads"))
    except ValueError as exc:
        raise RpcError("conflict" if "reload associations" in str(exc) else "invalid", str(exc)) from None
    conn.commit()
    self.touched |= {before, result["person_id"]}
    self.wake_refresh()
    return result


@method("contact.get")
def contact_get(self: Engine, conn, p: dict) -> dict:
    contact = _contact(replica.capture(conn), _text(p, "uid"))
    conn.commit()
    return {"uid": contact.uid, "card": contact.card, "fingerprint": fingerprint(contact.card)}


@method("contact.save")
def contact_save(self: Engine, conn, p: dict) -> dict:
    """Create a contact, or save an edited card if nobody has changed it since it was loaded."""
    card = p.get("card")
    if not isinstance(card, dict):
        raise RpcError("invalid", "card is missing")
    history = _capture_for(self, conn, p.get("uid"))
    if p.get("uid"):
        contact = _contact(history, _text(p, "uid"))
        # replica.edit diffs against the current card, so a stale editor would silently revert
        # whatever changed in the meantime.
        if p.get("fingerprint") != fingerprint(contact.card):
            raise RpcError("conflict", "This contact changed while you were editing it.")
        uid, previous = contact.uid, contact.card
    else:
        uid, previous = str(uuid.uuid4()), None
    contacts.validate(card)
    card = contacts.mark_manual_websites(card, previous) | {"user_edited": True}
    replica.change(conn, uid, card)
    conn.commit()
    person_id = _uid_person(conn, uid)
    self.touched.add(person_id)
    return {"uid": uid, "person_id": person_id}


@method("contact.patch")
def contact_patch(self: Engine, conn, p: dict) -> dict:
    """Change a few scalar fields without loading the card: rename, favorite."""
    values = p.get("values")
    if not isinstance(values, dict) or not values or set(values) - (replica.DEFAULTS.keys() | {"name"}):
        raise RpcError("invalid", "values must name contact fields")
    if "name" in values and (not isinstance(values["name"], str) or not values["name"].strip()):
        raise RpcError("invalid", "A contact needs a name")
    uid = _contact(_capture_for(self, conn, p.get("uid")), _text(p, "uid")).uid
    replica.change(conn, uid, values={**values, "user_edited": True})
    conn.commit()
    self.touched.add(_uid_person(conn, uid))
    return {}


@method("contact.trash")
def contact_trash(self: Engine, conn, p: dict) -> dict:
    uid = _contact(_capture_for(self, conn, p.get("uid")), _text(p, "uid")).uid
    replica.change(conn, uid, trashed=bool(p.get("trashed", True)))
    conn.commit()
    self.touched.add(_uid_person(conn, uid))
    return {}


@method("contact.resolve")
def contact_resolve(self: Engine, conn, p: dict) -> dict:
    contact = _contact(_capture_for(self, conn, p.get("uid")), _text(p, "uid"))
    field, change = _text(p, "field"), _text(p, "change")
    choice = next((c for c in contact.conflicts.get(field, []) if c["change"] == change), None)
    if choice is None:
        raise RpcError("invalid", "That choice is no longer available.")
    replica.change(conn, contact.uid, values={field: choice["value"]})
    conn.commit()
    self.touched.add(_uid_person(conn, contact.uid))
    return {}


def _summarize_change(change: dict) -> dict:
    """History without the bulky parts: photos and raw vCard properties become placeholders."""
    values = {k: ("<photo>" if k == "photo" and v else v) for k, v in change.get("values", {}).items()}
    adds = change.get("adds", {})
    return {
        "id": change["id"], "contact_uid": change["contact_uid"], "values": values,
        "added_fields": adds.get("fields", []), "removed_fields": len(change.get("removes", {}).get("fields", [])),
        "links": change.get("links", []), "parents": len(change.get("parents", [])),
    }


@method("contact.history")
def contact_history(self: Engine, conn, p: dict) -> dict:
    history = replica.load(conn)
    contact = _contact(history, _text(p, "uid"))
    members = set(contact.members)
    changes = [c for c in history.changes if c["contact_uid"] in members or members & set(c.get("links", []))]
    return {"changes": [_summarize_change(c) for c in changes[-HISTORY_LIMIT:]][::-1], "total": len(changes)}


@method("contact.export", "slow")
def contact_export(self: Engine, conn, p: dict) -> dict:
    """Write full cards, including photos and original properties, to a .vcf the user chose."""
    uids = p.get("uids")
    if not isinstance(uids, list) or not uids or not all(isinstance(u, str) for u in uids):
        raise RpcError("invalid", "uids must list at least one contact")
    history = replica.load(conn)
    cards = [_contact(history, uid).card for uid in dict.fromkeys(uids)]
    path = Path(_text(p, "path")).expanduser()
    try:
        path.write_bytes(contacts.vcard_export(cards).encode("utf-8", "replace"))
    except OSError as exc:
        raise RpcError("invalid", f"Couldn't write {path}: {exc.strerror or exc}") from None
    return {"count": len(cards), "path": str(path)}


@method("report.migration")
def report_migration(self: Engine, conn, p: dict) -> dict:
    return contacts.migration_report(conn)


# --- edits --------------------------------------------------------------------------------

def _edit_scope(conn, kind: str, payload: dict) -> set[int]:
    """Whose records an edit can change, worked out before it runs."""
    one = {"event_forget": ("SELECT person_id FROM events WHERE id = ?", "event_id"),
           "profile_status": ("SELECT person_id FROM profiles WHERE id = ?", "profile_id"),
           "moment_status": ("SELECT person_id FROM moments WHERE key = ?", "key")}
    if kind in one:
        query, key = one[kind]
        row = conn.execute(query, (payload.get(key),)).fetchone()
        return {row[0]} if row else set()
    if kind == "distinct":
        return set()  # only changes duplicate groups, which a full refresh rebuilds
    person = ops._person(conn, payload)["id"]
    if kind == "merge_undo":
        from . import graph_runtime
        if graph_runtime.enabled(conn):
            uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (person,)).fetchone()[0]
            contact = replica.load(conn).contact(uid)
            if contact:
                marks = ','.join('?' for _ in contact.members)
                return {r[0] for r in conn.execute(f"SELECT id FROM people WHERE contact_uid IN ({marks})", contact.members)}
        row = conn.execute("SELECT person_ids FROM contact_merge_undo WHERE keep_id = ? AND undone = 0 ORDER BY id DESC LIMIT 1", (person,)).fetchone()
        return {person, *json.loads(row[0])} if row else {person}
    return {person}


@method("edit.apply")
def edit_apply(self: Engine, conn, p: dict) -> dict:
    kind, payload = _text(p, "kind"), p.get("payload") or {}
    if kind not in EDIT_KINDS or not isinstance(payload, dict):
        raise RpcError("invalid", f"{kind} isn't an edit")
    scope = _edit_scope(conn, kind, payload)
    message = ops.apply(conn, kind, payload)
    self.touched |= scope
    if kind == "distinct":
        self.wake_refresh()
    return {"message": message}


@method("people.merge")
def people_merge(self: Engine, conn, p: dict) -> dict:
    """Join graph identity components without discarding original attribution."""
    from . import dupes

    ids = ops._people(conn, {"person_ids": _ints(p, "ids", 2)})
    replica.capture(conn)
    keep = contacts.reversible_merge(conn, ids, lambda: dupes.merge(conn, [{"id": i} for i in ids], commit=False))
    conn.commit()
    keep = identity.canonical(conn, keep)
    self.touched |= {*ids, keep}
    self.wake_refresh()  # duplicate groups changed too
    return {"person_id": keep}


@method("me.get")
def me_get(self: Engine, conn, p: dict) -> dict:
    user = identity.me(conn)
    if not user:
        return {"person": None}
    ids = conn.execute("SELECT kind, value FROM identifiers WHERE person_id = ?", (user["id"],)).fetchall()
    return {"person": {"id": user["id"], "name": user["name"], "aliases": identity.aliases(conn, user["id"]),
                       "identifiers": [{"kind": r["kind"], "value": r["value"]} for r in ids]}}


@method("me.set")
def me_set(self: Engine, conn, p: dict) -> dict:
    ids = _ints(p, "ids")
    identity.set_me(conn, ids)
    conn.commit()
    self.touched |= set(ids)
    self.wake_refresh()  # your own records leave moments and duplicate groups too
    return me_get(self, conn, {})


@method("moments.preview")
def moments_preview(self: Engine, conn, p: dict) -> dict:
    """`mypeople today --preview`: what a day would surface, without marking anything as shown."""
    day = dt.date.fromisoformat(p["date"]) if p.get("date") else None
    limit = p.get("limit") if isinstance(p.get("limit"), int) else moments.DEFAULT_LIMIT
    chosen = moments.today_moments(conn, day, limit, record=False)
    return {"moments": [{"key": m.key, "person_id": m.person_id, "name": m.name, "kind": m.kind, "reason": m.reason,
                         "context": m.context, "score": m.score} for m in chosen]}


# --- review -------------------------------------------------------------------------------

@method("profiles.review")
def profiles_review(self: Engine, conn, p: dict) -> dict:
    """`mypeople socials review`, with the evidence the phone's published view leaves out."""
    from . import socials

    diagnostics = bool(p.get("include_diagnostics"))
    rows = [r for r in socials.suggestions(conn, include_diagnostics=diagnostics) if diagnostics or socials.reviewable(conn, r)]
    return {"profiles": [{
        "id": r["id"], "person_id": r["person_id"], "name": r["name"], "site": r["site"], "url": r["url"],
        "title": r["title"], "snippet": r["snippet"], "reason": r["reason"], "assessment": r["assessment"],
        "confidence": r["confidence"], "evidence": json.loads(r["evidence"]), "sources": json.loads(r["sources"]),
    } for r in rows]}


def _dupe_cards(conn, ids: list[int]):
    from . import dupes

    # By id only: identity.lookup would fall back to searching names for a number that isn't an id.
    return [dupes.card(conn, ops._person(conn, {"person_id": i})) for i in ids]


@method("dupes.cards")
def dupes_cards(self: Engine, conn, p: dict) -> dict:
    from . import dupes

    cards = _dupe_cards(conn, _ints(p, "ids", 2))
    return {"cards": [{
        "id": c.person["id"], "name": c.person["name"], "ids": c.ids,
        "channels": [{"channel": ch, "count": n} for ch, n in c.channels],
        "first": c.first, "last": c.last, "closeness": c.closeness, "now": c.now, "facts": c.facts,
        "said": [{"date": d, "text": t} for d, t in c.said], "photos": c.photos,
    } for c in cards], "clues": dupes.shared_clues(cards, conn)}


@method("twitter.unnamed", "slow")
def twitter_unnamed(self: Engine, conn, p: dict) -> dict:
    """The conversations `import twitter --review` would ask about."""
    from .importers import twitter

    root = Path(_text(p, "root")).expanduser()
    try:
        todo = twitter.unnamed(conn, root)
    except (OSError, ValueError, KeyError, IndexError) as exc:
        raise RpcError("invalid", f"Couldn't read that X archive: {exc}") from None
    return {"conversations": [{
        "account_id": u.account_id, "link": u.link, "tweets_shared": u.tweets_shared,
        "messages": [{"at": at, "mine": mine, "text": text} for at, mine, text in u.messages],
    } for u in todo]}


@method("twitter.name")
def twitter_name(self: Engine, conn, p: dict) -> dict:
    from .importers import twitter

    name, handle = p.get("name") or None, p.get("handle") or None
    person_id = p.get("person_id")
    if not (name or handle or person_id):
        raise RpcError("invalid", "Give a name, an @handle, or an existing person.")
    pid = twitter.name_account(conn, _text(p, "account_id"), name, handle, person_id)
    self.touched.add(pid)
    return {"person_id": pid}


# --- jobs ---------------------------------------------------------------------------------

@method("job.start", "now")
def job_start(self: Engine, conn, p: dict) -> dict:
    return self.jobs.start(_text(p, "kind"), p.get("params") or {})


@method("job.cancel", "now")
def job_cancel(self: Engine, conn, p: dict) -> dict:
    self.jobs.cancel(_int(p, "id"))
    return {}


@method("job.input", "now")
def job_input(self: Engine, conn, p: dict) -> dict:
    self.jobs.write(_int(p, "id"), str(p.get("text") or ""))
    return {}


# --- entry point --------------------------------------------------------------------------

def serve(db_path: Path) -> None:
    """Run until the app closes our stdin. Frames travel on private copies of stdin and stdout."""
    frames_in = os.fdopen(os.dup(0), "rb")
    frames_out = os.fdopen(os.dup(1), "wb")
    # Domain code prints, and a few paths call input(). Neither may touch the protocol: a stray
    # print() would corrupt the stream, and input() would swallow a request.
    os.dup2(os.open(os.devnull, os.O_RDONLY), 0)
    os.dup2(2, 1)

    write_lock = threading.Lock()
    engine: Engine

    def emit(data: bytes) -> None:
        try:
            with write_lock:
                frames_out.write(data)
                frames_out.flush()
        except (BrokenPipeError, ValueError):
            shutdown()

    stopping = threading.Lock()

    def shutdown(*_) -> None:
        if not stopping.acquire(blocking=False):
            return  # another thread is already on its way out
        try:
            engine.stop()
        finally:
            os._exit(0)

    llm.load_env_file()  # as the CLI does, so status and model calls see the same credentials
    engine = Engine(db_path, emit)
    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)
    engine.start()
    for raw in frames_in:
        try:
            frame = json.loads(raw)
            if not isinstance(frame, dict):
                raise ValueError
        except ValueError:
            engine.send({"id": None, "error": {"code": "invalid", "message": "Not a JSON object."}})
            continue
        engine.submit(frame)
    shutdown()
