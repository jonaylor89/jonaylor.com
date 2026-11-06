"""Derived UI/inference records accompanying the complete trusted-peer graph.

People, relationship stats, facts, profiles, photos, moments and duplicate review
records. Raw conversations are absent from this small view, not from replication:
the full graph/blob bundle carries their complete contents to every trusted peer.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from pathlib import Path

from . import contacts, dupes, moments, relationships, socials, identity

HIDDEN_IDENTIFIERS = ("google",)  # resource names mean nothing outside the Google API
MOMENT_DAYS = 30  # how far back the phone sees moments


def digest(data: dict) -> str:
    return hashlib.sha1(json.dumps(data, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def photo_hash(path: str) -> str | None:
    try:
        return hashlib.sha256(Path(path).read_bytes()).hexdigest()
    except OSError:
        return None


def _grouped(rows, key: str = "person_id") -> dict[int, list[sqlite3.Row]]:
    out: dict[int, list[sqlite3.Row]] = {}
    for r in rows:
        out.setdefault(r[key], []).append(r)
    return out


def records(
    conn: sqlite3.Connection, today: dt.date | None = None, *, people: set[int] | None = None, hash_photo=photo_hash,
) -> tuple[dict[tuple[str, str], dict], dict[str, str]]:
    """Everything the phone sees, keyed by (kind, id), plus the photo files they reference by hash.

    `people` limits the result to those ids, for a caller that knows what an edit touched. That
    skips the whole-database work: no moments are picked, and duplicate groups and contact
    history are left out.
    """
    today = today or dt.date.today()
    scoped = people is not None
    ids = ", ".join(str(int(i)) for i in people) if scoped else ""
    only = f" AND person_id IN ({ids})" if scoped else ""
    if not scoped:
        # Pick today's moments the way `mypeople today` does, so the phone and the CLI agree.
        moments.today_moments(conn, today)

    people_rows = conn.execute(
        "SELECT * FROM people WHERE merged_into IS NULL AND is_me = 0" + (f" AND id IN ({ids})" if scoped else "")).fetchall()
    visible = {p["id"] for p in people_rows}
    aliases = _grouped(conn.execute(f"SELECT person_id, alias FROM aliases WHERE 1{only} ORDER BY alias"))
    identifiers = _grouped(conn.execute(
        f"SELECT person_id, kind, value FROM identifiers WHERE kind NOT IN ({', '.join('?' * len(HIDDEN_IDENTIFIERS))}){only} "
        "ORDER BY kind, value", HIDDEN_IDENTIFIERS))
    channels = _grouped(conn.execute(
        f"SELECT person_id, channel, COUNT(*) AS n, MIN(at) AS first, MAX(at) AS last FROM interactions WHERE 1{only} "
        "GROUP BY person_id, channel ORDER BY n DESC"))
    best_photos = {r["person_id"]: r["path"] for r in conn.execute(
        f"SELECT person_id, path FROM photos p WHERE width = (SELECT MAX(width) FROM photos q WHERE q.person_id = p.person_id){only}")}

    redirects: dict[int, list[str]] = {}
    for merged in conn.execute("SELECT id, contact_uid FROM people WHERE merged_into IS NOT NULL"):
        redirects.setdefault(identity.canonical(conn, merged["id"]), []).append(merged["contact_uid"])
    from . import replica, graph_runtime
    history = replica.load(conn)
    graph_mode = graph_runtime.enabled(conn)
    out: dict[tuple[str, str], dict] = {}
    files: dict[str, str] = {}
    for p in people_rows:
        pid = p["id"]
        contact = history.contact(p["contact_uid"])
        rel = relationships.infer(conn, pid, today)
        used = channels.get(pid, [])
        photo = None
        if pid in best_photos and (photo := hash_photo(best_photos[pid])):
            files[photo] = best_photos[pid]
        out[("person", str(pid))] = {
            "name": p["name"],
            "contact_uid": p["contact_uid"],
            "contact_aliases": redirects.get(pid, []),
            "card": json.loads(p["contact_data"]) if p["contact_data"] else None,
            "trashed": bool(p["trashed"]),
            "can_undo_merge": bool(contact and len(contact.members) > 1) if graph_mode else contacts.merge_can_be_undone(conn, pid),
            "contact_conflicts": contact.conflicts if contact else {},
            "aliases": [a["alias"] for a in aliases.get(pid, [])],
            "identifiers": [{"kind": i["kind"], "value": i["value"]} for i in identifiers.get(pid, [])],
            "photo": photo,
            "category": rel.category,
            "closeness": round(rel.closeness, 2),
            "cadence_days": rel.cadence_days,
            "trend": rel.trend,
            "days_365": rel.days_365,
            "muted": rel.muted,
            "channels": [{"channel": c["channel"], "count": c["n"]} for c in used],
            "first_contact": min((c["first"] for c in used), default=None),
            "last_contact": max((c["last"] for c in used), default=None),
        }

    for e in conn.execute(f"SELECT * FROM events WHERE status = 'active'{only}"):
        if e["person_id"] in visible:
            out[("event", str(e["id"]))] = {
                k: e[k] for k in ("person_id", "type", "value", "date", "confidence", "source", "evidence", "said_at", "created_at")
            }

    reviewable = {r["id"] for r in socials.suggestions(conn)}
    for r in conn.execute(f"SELECT * FROM profiles WHERE status IN ('confirmed', 'suggested'){only}"):
        if r["person_id"] in visible and (r["status"] == "confirmed" or r["id"] in reviewable):
            out[("profile", str(r["id"]))] = {
                k: r[k] for k in ("person_id", "site", "url", "title", "status", "assessment", "reason", "confidence")
            }

    since = (today - dt.timedelta(days=MOMENT_DAYS)).isoformat()
    for m in conn.execute(f"SELECT * FROM moments WHERE surfaced_on >= ?{only}", (since,)):
        if m["person_id"] in visible:
            out[("moment", m["key"])] = {k: m[k] for k in ("person_id", "kind", "reason", "context", "score", "surfaced_on", "status")}

    if scoped:
        return out, files
    for group in dupes.to_review(conn):
        group_ids = sorted(r["id"] for r in group)
        if all(i in visible for i in group_ids):
            clues = dupes.shared_clues([dupes.card(conn, r) for r in group], conn)
            out[("dupes", "-".join(map(str, group_ids)))] = {"person_ids": group_ids, "clues": clues}
    from . import graph_runtime
    if not graph_runtime.enabled(conn):
        for change in history.changes:
            out[("contact_change", change["id"])] = change
    return out, files
