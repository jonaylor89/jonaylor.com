"""Instagram usernames for DM contacts, read from your own signed-in session.

Exports name DM partners only by display name, but every imported 1:1 message keeps
its thread id, and instagram.com/direct/t/<id>/ shows that thread's partner with
their username. Only that header is read; profiles shared inside a chat never are.
A header whose display name isn't one imported for the contact becomes a suggestion
for `socials review`, not a confirmation. Rejected profiles stay rejected.
"""

from __future__ import annotations

import json
import random
import time

from . import identity
from .social_photos import account_url

MAX_FAILURE_STREAK = 8


def _name(name: str) -> str:
    return " ".join(name.lower().split())


def targets(conn, person_id: int | None = None, again: bool = False) -> list[dict]:
    """Imported 1:1 threads, busiest first, skipping threads already read (unless again)."""
    counts: dict[str, int] = {}
    owners: dict[str, int] = {}
    for r in conn.execute("SELECT person_id, source_ref FROM interactions WHERE channel = 'instagram' AND thread IS NULL"):
        thread = r["source_ref"].split(":")[1]
        counts[thread] = counts.get(thread, 0) + 1
        owners.setdefault(thread, r["person_id"])
    checks = dict(conn.execute("SELECT thread, status FROM instagram_thread_checks").fetchall())
    out = []
    # Unread threads first; earlier failures are retried last.
    for thread in sorted(counts, key=lambda t: (checks.get(t) == "failed", -counts[t])):
        pid = identity.canonical(conn, owners[thread])
        person = conn.execute("SELECT name, is_me, trashed FROM people WHERE id = ?", (pid,)).fetchone()
        if (not again and checks.get(thread, "failed") != "failed") or person["is_me"] or person["trashed"] or person_id not in (None, pid):
            continue
        names = {_name(r["value"]) for r in conn.execute(
            "SELECT value FROM identifiers WHERE person_id = ? AND kind = 'instagram'", (pid,))}
        out.append({"thread": thread, "person_id": pid, "name": person["name"], "names": names,
                    "retry": checks.get(thread) == "failed"})
    return out


def save(conn, target: dict, username: str, shown: str) -> str:
    """Store the thread partner's account; returns confirmed, suggested, or rejected."""
    url = account_url("instagram", username)
    if url is None:
        raise ValueError(f"Not an Instagram username: {username!r}")
    pid, origin = target["person_id"], {"source": "instagram_dm", "thread": target["thread"]}
    status = "confirmed" if _name(shown) in target["names"] else "suggested"
    reason = ("Header of your Instagram DM thread with this person." if status == "confirmed" else
              f"Your Instagram DM thread with this person shows them as “{shown}”, not a name imported for them.")
    row = conn.execute("SELECT * FROM profiles WHERE person_id = ? AND url = ?", (pid, url)).fetchone()
    if row is None:
        conn.execute("INSERT INTO profiles (person_id, site, url, title, confidence, reason, status, sources) "
                     "VALUES (?, 'instagram', ?, ?, ?, ?, ?, ?)",
                     (pid, url, shown, 1.0 if status == "confirmed" else 0.8, reason, status, json.dumps([origin])))
        return status
    if row["status"] == "rejected":
        return "rejected"
    sources = json.loads(row["sources"])
    if origin not in sources:
        sources.append(origin)
    status = "confirmed" if "confirmed" in (row["status"], status) else status
    conn.execute("UPDATE profiles SET status = ?, confidence = max(confidence, ?), reason = ?, sources = ? WHERE id = ?",
                 (status, 1.0 if status == "confirmed" else 0.8,
                  row["reason"] if row["status"] == "confirmed" else reason, json.dumps(sources), row["id"]))
    return status


def collect(conn, selected: list[dict], browser, delay: float = 4.0, echo=print) -> dict[str, int]:
    """Read each thread's header in the dedicated browser, pausing between threads.

    Progress is committed per thread, so an interrupted run resumes where it stopped.
    """
    stats = {"confirmed": 0, "suggested": 0, "rejected": 0, "unavailable": 0, "failed": 0}
    streak = 0
    for i, t in enumerate(selected):
        if streak >= MAX_FAILURE_STREAK:
            echo(f"Stopped after {streak} unreadable threads in a row; Instagram may be throttling or showing a "
                 "checkpoint in the browser. Rerun later; failed threads are retried.")
            break
        if i:
            time.sleep(random.uniform(delay, delay * 2))
        username, shown, detail = browser.instagram_thread(t["thread"])
        if username and account_url("instagram", username) is None:
            # Not an Instagram account (e.g. "Facebook user"); retrying won't change that.
            status, detail, username = "unavailable", f"header shows {username!r}, not an Instagram account", None
        else:
            status = save(conn, t, username, shown) if username else "failed"
        conn.execute("INSERT OR REPLACE INTO instagram_thread_checks (thread, person_id, checked_at, status, detail) "
                     "VALUES (?, ?, ?, ?, ?)", (t["thread"], t["person_id"], time.time(), status,
                                               f"@{username} ({shown})" if username else detail))
        conn.commit()
        stats[status] += 1
        if not t["retry"]:  # old failures are often gone for good; only fresh ones signal throttling
            streak = streak + 1 if status == "failed" else 0
        echo(f"[{i + 1}/{len(selected)}] {t['name']}: " + (f"@{username} {status}" if username else f"skipped, {detail}"))
    return stats
