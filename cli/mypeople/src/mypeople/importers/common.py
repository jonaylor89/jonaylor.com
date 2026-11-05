from __future__ import annotations

import re
import sqlite3

from .. import identity


def resolve_counterpart(
    conn: sqlite3.Connection, handle: str, name: str | None, source: str, written_to: set[tuple[str, str]]
) -> int | None:
    """Map a handle to a person, creating one only if it's a real relationship.

    A person exists if they're in the address book or the user has written to
    them at least once. That keeps newsletters and 2FA codes out.
    """
    norm = identity.normalize_handle(handle)
    if norm is None:
        return None
    existing = identity.find_by_identifier(conn, *norm)
    if existing and conn.execute("SELECT is_me FROM people WHERE id = ?", (existing,)).fetchone()["is_me"]:
        return None  # one of the user's own addresses or numbers
    if existing:
        if name and not identity.looks_like_identifier(name):
            # Upgrade a bare number or address to a real name once one shows up.
            current = conn.execute("SELECT name FROM people WHERE id = ?", (existing,)).fetchone()["name"]
            if identity.looks_like_identifier(current):
                conn.execute("UPDATE people SET name = ? WHERE id = ?", (name, existing))
        return existing
    if norm not in written_to:
        return None
    return identity.resolve(conn, [norm], name or handle, source)


def add_interaction(
    conn: sqlite3.Connection,
    person_id: int,
    at: str,
    channel: str,
    direction: str,
    text: str | None,
    thread: str | None,
    source_ref: str,
) -> bool:
    cur = conn.execute(
        "INSERT OR IGNORE INTO interactions (person_id, at, channel, direction, text, thread, source_ref) "
        "VALUES (?, ?, ?, ?, ?, ?, ?)",
        (person_id, at, channel, direction, text, thread, source_ref),
    )
    return cur.rowcount > 0


_MESSAGE_ID = re.compile(r"<[^<>\s]+>")


def email_ref(message_id: str | None, addr: str, fallback: str) -> str:
    """One key per (email, counterpart) whatever the source, so mbox and Mino imports dedupe."""
    m = _MESSAGE_ID.search(message_id or "")
    return f"email:{m.group(0) if m else fallback}:{addr}"
