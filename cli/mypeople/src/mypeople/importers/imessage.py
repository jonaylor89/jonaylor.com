"""iMessage import, read directly from the local Messages database on macOS.

iMessage has no API, but ~/Library/Messages/chat.db is a plain SQLite file.
Reading it requires granting the terminal Full Disk Access.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
from pathlib import Path

from .. import identity
from .common import add_interaction, resolve_counterpart

DEFAULT_DB = Path.home() / "Library" / "Messages" / "chat.db"
APPLE_EPOCH = dt.datetime(2001, 1, 1, tzinfo=dt.timezone.utc)
GROUP_STYLE = 43

QUERY = """
SELECT m.guid, m.text, m.attributedBody, m.date, m.is_from_me,
       h.id AS handle, c.chat_identifier, c.style, c.guid AS chat_guid
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.associated_message_type = 0 AND m.item_type = 0 AND m.date >= ?
ORDER BY m.date
"""


def apple_time(value: int) -> dt.datetime:
    # Newer macOS stores nanoseconds, older stores seconds.
    seconds = value / 1e9 if value > 1e12 else value
    return (APPLE_EPOCH + dt.timedelta(seconds=seconds)).astimezone().replace(tzinfo=None)


def to_apple_time(when: dt.datetime) -> int:
    return int((when.astimezone(dt.timezone.utc) - APPLE_EPOCH).total_seconds() * 1e9)


def decode_attributed_body(blob: bytes | None) -> str | None:
    """Pull the plain string out of an NSAttributedString typedstream.

    Since macOS Ventura most message text lives here instead of message.text.
    """
    if not blob:
        return None
    start = blob.find(b"NSString")
    if start < 0:
        return None
    plus = blob.find(b"+", start)
    if plus < 0:
        return None
    i = plus + 1
    length = blob[i]
    i += 1
    if length == 0x81:
        length = int.from_bytes(blob[i : i + 2], "little")
        i += 2
    elif length == 0x82:
        length = int.from_bytes(blob[i : i + 4], "little")
        i += 4
    return blob[i : i + length].decode("utf-8", errors="replace") or None


def counterpart(row: sqlite3.Row) -> str | None:
    """Who the message is with, or None for the user's own messages in groups."""
    if row["style"] == GROUP_STYLE:
        return None if row["is_from_me"] else row["handle"]
    return row["handle"] or row["chat_identifier"]


def import_imessage(conn: sqlite3.Connection, db_path: Path = DEFAULT_DB, since: dt.date | None = None) -> dict[str, int]:
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    since_dt = dt.datetime.combine(since or dt.date(2001, 1, 2), dt.time())
    rows = src.execute(QUERY, (to_apple_time(since_dt),)).fetchall()
    src.close()

    written_to = {
        norm
        for r in rows
        if r["is_from_me"] and r["style"] != GROUP_STYLE and (h := counterpart(r))
        if (norm := identity.normalize_handle(h))
    }
    stats = {"messages": len(rows), "interactions": 0, "skipped": 0}
    for r in rows:
        handle = counterpart(r)
        person_id = handle and resolve_counterpart(conn, handle, None, "imessage", written_to)
        if not person_id:
            stats["skipped"] += 1
            continue
        text = r["text"] or decode_attributed_body(r["attributedBody"])
        if text:
            text = text.replace("￼", "").strip() or None  # attachment placeholders
        thread = "group chat" if r["style"] == GROUP_STYLE else None
        if add_interaction(
            conn,
            person_id,
            apple_time(r["date"]).isoformat(sep=" ", timespec="seconds"),
            "imessage",
            "out" if r["is_from_me"] else "in",
            text,
            thread,
            f"imessage:{r['guid']}",
        ):
            stats["interactions"] += 1
    conn.commit()
    return stats
