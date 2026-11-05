"""Expose known Snapchat accounts as confirmed contact links, including old imports."""

import json
import sqlite3
from urllib.parse import quote

from .profile_urls import profile_url


def backfill(conn: sqlite3.Connection) -> int:
    """Idempotent projection of account identifiers; never undo a profile rejection.

    No network calls, contact-card edits, or new people. The caller commits.
    """
    added = 0
    rows = conn.execute(
        "SELECT i.person_id, i.value, i.source FROM identifiers i JOIN people p ON p.id=i.person_id "
        "WHERE i.kind='snapchat' AND i.source IN ('snapchat', 'manual') "
        "AND p.is_me=0 AND p.merged_into IS NULL AND p.trashed=0"
    ).fetchall()
    for row in rows:
        url = profile_url("https://www.snapchat.com/add/" + quote(row["value"].strip(), safe=""))
        if not url:
            continue
        existing = [p for p in conn.execute("SELECT * FROM profiles WHERE person_id=?", (row["person_id"],))
                    if profile_url(p["url"]) == url]
        if any(p["status"] in ("confirmed", "rejected") for p in existing):
            continue
        origin = {"source": row["source"], "kind": "snapchat", "value": row["value"]}
        reason = "Known Snapchat account from an imported or manually added username."
        if existing:
            profile = existing[0]
            sources = json.loads(profile["sources"])
            if origin not in sources:
                sources.append(origin)
            conn.execute("UPDATE profiles SET status='confirmed', confidence=1, reason=?, sources=? WHERE id=?",
                         (reason, json.dumps(sources), profile["id"]))
        else:
            conn.execute(
                "INSERT INTO profiles (person_id, site, url, confidence, status, reason, sources) "
                "VALUES (?, 'snapchat', ?, 1, 'confirmed', ?, ?)",
                (row["person_id"], url, reason, json.dumps([origin])),
            )
        added += 1
    return added
