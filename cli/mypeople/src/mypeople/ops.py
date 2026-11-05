"""Edits made on the phone or the Mac app, and older requests, applied to this database.

Each operation has a kind and a JSON payload naming people and facts by their ids here.
A person merged since the phone last synced is followed to the record they were merged into.
"""

from __future__ import annotations

import sqlite3

from . import identity, relationships
from .events import EVENT_TYPES, MANUAL, add_event, add_note

EDITS = ("contact_change", "contact_save", "contact_trash", "contact_restore", "merge_undo", "rename", "alias_add", "alias_remove", "event_add", "event_forget", "note", "relationship",
         "profile_status", "merge", "distinct", "moment_status")
# These need the model, Exa, or this Mac's address book, and can take a while.
# Requests only older phones still send. Kept so that an edit bundle queued before they went CLI-only still applies.
ENRICHMENT = ("extract", "find_profiles", "photos")
KINDS = EDITS + ENRICHMENT


class OpError(ValueError):
    """The operation can't be applied as asked. Its message is shown on the phone."""


def _text(payload: dict, key: str) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise OpError(f"{key} is missing")
    return value.strip()


def _person(conn: sqlite3.Connection, payload: dict, key: str = "person_id") -> sqlite3.Row:
    uid = payload.get("contact_uid") if key == "person_id" else None
    if uid:
        row = conn.execute("SELECT id FROM people WHERE contact_uid=?", (uid,)).fetchone()
        raw = row["id"] if row else None
    else:
        raw = payload.get(key)
    if not isinstance(raw, int):
        raise OpError(f"{key} is missing")
    row = conn.execute("SELECT * FROM people WHERE id = ?", (identity.canonical(conn, raw),)).fetchone()
    if row is None:
        raise OpError(f"No person #{raw}")
    return row


def _people(conn: sqlite3.Connection, payload: dict) -> list[int]:
    raw = payload.get("person_ids")
    if not isinstance(raw, list) or not all(isinstance(i, int) for i in raw):
        raise OpError("person_ids is missing")
    # People created on the phone carry a contact uid alongside their phone-only id.
    uids = payload.get("contact_uids")
    if not (isinstance(uids, list) and len(uids) == len(raw) and all(isinstance(u, str) for u in uids)):
        uids = [""] * len(raw)
    ids = list(dict.fromkeys(_person(conn, {"person_id": i, "contact_uid": u})["id"] for i, u in zip(raw, uids)))
    if len(ids) < 2:
        raise OpError("Pick at least two different people")
    return ids


def _relationship(payload: dict) -> dict:
    fields = {}
    for key, value in payload.items():
        if key in ("person_id", "contact_uid"):
            continue
        if key == "category":
            if value is not None and value not in relationships.CATEGORIES:
                raise OpError(f"category must be one of {', '.join(relationships.CATEGORIES)}")
        elif key == "closeness":
            if value is not None and not (isinstance(value, (int, float)) and 0 <= value <= 1):
                raise OpError("closeness must be between 0 and 1")
        elif key == "cadence_days":
            if value is not None and not (isinstance(value, (int, float)) and value > 0):
                raise OpError("cadence_days must be a positive number of days")
        elif key == "muted":
            if not isinstance(value, bool):
                raise OpError("muted must be true or false")
            value = int(value)
        else:
            raise OpError(f"Unknown relationship field {key!r}")
        fields[key] = value
    if not fields:
        raise OpError("Nothing to change")
    return fields


def apply(conn: sqlite3.Connection, kind: str, payload: dict) -> str:
    """Apply one operation and commit. Returns a short message for the phone; raises OpError if it can't."""
    if kind == "contact_change":
        from . import replica
        try:
            current = replica.load(conn)
            if payload.get("id") not in current.by_id:
                replica.capture(conn)
            replica.receive(conn, [payload])
        except ValueError as e:
            raise OpError(str(e)) from None
        message = "Contact history merged."
    elif kind == "contact_save":
        from . import contacts
        try:
            raw_id = payload.get("person_id")
            pid = _person(conn, payload)["id"] if isinstance(raw_id, int) and raw_id > 0 else None
            contacts.save(conn, _text(payload, "contact_uid"), payload.get("card"), pid)
        except ValueError as e:
            raise OpError(str(e)) from None
        message = "Contact saved."
    elif kind in ("contact_trash", "contact_restore"):
        p = _person(conn, payload)
        conn.execute("UPDATE people SET trashed=? WHERE id=?", (int(kind == "contact_trash"), p["id"]))
        message = "Moved to trash." if kind == "contact_trash" else "Restored."
    elif kind == "merge_undo":
        from .contacts import undo_merge
        try:
            undo_merge(conn, _person(conn, payload)["id"])
        except ValueError as e:
            raise OpError(str(e)) from None
        message = "Merge undone."
    elif kind == "rename":
        import json
        p, name = _person(conn, payload), _text(payload, "name")
        conn.execute("UPDATE people SET name = ? WHERE id = ?", (name, p["id"]))
        if p["contact_data"]:
            card = json.loads(p["contact_data"])
            card["name"] = name
            conn.execute("UPDATE people SET contact_data=? WHERE id=?", (json.dumps(card), p["id"]))
        message = f"{p['name']} is now {name}."
    elif kind == "alias_add":
        p, alias = _person(conn, payload), _text(payload, "alias")
        identity.add_alias(conn, p["id"], alias)
        message = f"{p['name']} is also called {alias}."
    elif kind == "alias_remove":
        p, alias = _person(conn, payload), _text(payload, "alias")
        conn.execute("DELETE FROM aliases WHERE person_id = ? AND lower(alias) = lower(?)", (p["id"], alias))
        message = f"Removed {alias}."
    elif kind == "event_add":
        p, value = _person(conn, payload), _text(payload, "value")
        type = payload.get("type") if payload.get("type") in EVENT_TYPES else "other"
        eid = add_event(conn, p["id"], type, value, payload.get("date") or None, 1.0, MANUAL)
        message = "Added." if eid else "Already known."
    elif kind == "event_forget":
        cur = conn.execute("UPDATE events SET status = 'rejected' WHERE id = ?", (payload.get("event_id"),))
        if not cur.rowcount:
            raise OpError(f"No fact #{payload.get('event_id')}")
        message = "Forgotten."
    elif kind == "relationship":
        p = _person(conn, payload)
        relationships.set_override(conn, p["id"], **_relationship(payload))
        message = f"Updated {p['name']}."
    elif kind == "profile_status":
        if payload.get("status") not in ("confirmed", "rejected"):
            raise OpError("status must be confirmed or rejected")
        cur = conn.execute("UPDATE profiles SET status = ? WHERE id = ?", (payload["status"], payload.get("profile_id")))
        if not cur.rowcount:
            raise OpError(f"No profile #{payload.get('profile_id')}")
        message = "Confirmed." if payload["status"] == "confirmed" else "Rejected."
    elif kind == "merge":
        from . import dupes

        ids = _people(conn, payload)
        from .contacts import reversible_merge
        keep = reversible_merge(conn, ids, lambda: dupes.merge(conn, [{"id": i} for i in ids], commit=False))
        name = conn.execute("SELECT name FROM people WHERE id = ?", (keep,)).fetchone()["name"]
        message = f"Merged into {name} (#{keep})."
    elif kind == "distinct":
        from . import dupes

        dupes.mark_distinct(conn, _people(conn, payload))
        message = "Noted: different people."
    elif kind == "moment_status":
        if payload.get("status") not in ("done", "dismissed"):
            raise OpError("status must be done or dismissed")
        cur = conn.execute("UPDATE moments SET status = ? WHERE key = ?", (payload["status"], payload.get("key")))
        if not cur.rowcount:
            raise OpError("No such moment")
        message = "Thanks, noted."
    elif kind == "note":
        p, text = _person(conn, payload), _text(payload, "text")
        message = "Noted." if add_note(conn, p["id"], text) else "Already noted."
    elif kind == "extract":
        from .extract import default_model, extract_person

        p = _person(conn, payload)
        added = extract_person(conn, default_model(), p["id"])
        message = f"Read {p['name']}'s new messages: {added} new fact{'s' if added != 1 else ''}."
    elif kind == "find_profiles":
        from . import socials

        p = _person(conn, payload)
        if not socials.searchable(p["name"]):
            raise OpError("Needs a full name first")
        found, cost = socials.find(conn, p["id"])
        message = f"{found} profile{'s' if found != 1 else ''} to review (${cost:.3f})."
    elif kind == "photos":
        from . import photos

        message = " ".join(photos.collect(conn, source) for source in photos.SOURCES)
    else:
        raise OpError(f"Unknown operation {kind!r}")
    conn.commit()
    return message
