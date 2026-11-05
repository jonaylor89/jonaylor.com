"""Email import from the Mino mail client's local store.

Mino keeps synced mail in ~/Library/Application Support/Mino/mail.sqlite, with
quoted history already split from each message body. It only holds what Mino
has synced, so re-running the import picks up new mail as Mino fetches it.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
from pathlib import Path

from .. import identity
from .common import add_interaction, email_ref, resolve_counterpart
from .mbox import _BULK_SENDER, MAX_BODY

DEFAULT_DB = Path.home() / "Library" / "Application Support" / "Mino" / "mail.sqlite"
# Gmail tabs that are never a conversation with a person.
BULK_LABELS = ("SPAM", "CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_UPDATES", "CATEGORY_FORUMS")

QUERY = f"""
SELECT m.account_id, m.message_id, m.subject, m.sender_name, m.sender_email, m.date,
       m.body_text, m.is_from_me, m.list_unsubscribe IS NOT NULL AS is_list, m.reply_context
FROM messages m
WHERE m.date >= ?
  AND NOT EXISTS (
      SELECT 1 FROM labels l
      WHERE l.account_id = m.account_id AND l.message_id = m.message_id
        AND l.name IN ({", ".join("?" * len(BULK_LABELS))}))
ORDER BY m.date
"""

RECIPIENTS = """
SELECT name, normalized_email FROM participants
WHERE account_id = ? AND message_id = ? AND role IN ('to', 'cc', 'bcc')
ORDER BY position
"""


def rfc_message_id(reply_context: bytes | str | None) -> str | None:
    """Mino keeps the Message-ID header inside its JSON reply context."""
    if not reply_context:
        return None
    try:
        return json.loads(reply_context).get("messageID")
    except (ValueError, AttributeError):
        return None


def my_addresses(src: sqlite3.Connection) -> set[str]:
    """Account ids are the user's addresses, with IMAP ones prefixed 'imap:'."""
    rows = src.execute("SELECT account_id FROM accounts").fetchall()
    return {r["account_id"].removeprefix("imap:").lower() for r in rows if "@" in r["account_id"]}


def import_mino(conn: sqlite3.Connection, db_path: Path = DEFAULT_DB, since: dt.date | None = None) -> dict[str, int]:
    src = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    src.row_factory = sqlite3.Row
    me = my_addresses(src) | identity.my_addresses(conn)
    # Everyone the user has ever written to counts as a real relationship.
    written_to = {
        ("email", r["normalized_email"])
        for r in src.execute(
            "SELECT DISTINCT p.normalized_email FROM participants p "
            "JOIN messages m ON m.account_id = p.account_id AND m.message_id = p.message_id "
            "WHERE m.is_from_me = 1 AND p.role IN ('to', 'cc', 'bcc')"
        )
        if r["normalized_email"] not in me
    }
    # Mino's synced contacts give names to bare addresses.
    names = {r["normalized_email"]: r["name"] for r in src.execute("SELECT normalized_email, name FROM directory_contacts") if r["name"]}

    since_ts = dt.datetime.combine(since, dt.time()).timestamp() if since else 0
    rows = src.execute(QUERY, (since_ts, *BULK_LABELS)).fetchall()
    stats = {"messages": len(rows), "interactions": 0, "skipped": 0}
    for r in rows:
        outgoing = bool(r["is_from_me"])
        sender = r["sender_email"].lower()
        if outgoing:
            others = [(n, a) for n, a in src.execute(RECIPIENTS, (r["account_id"], r["message_id"])) if a not in me]
        elif r["is_list"] or _BULK_SENDER.search(sender) or sender in me:
            stats["skipped"] += 1
            continue
        else:
            others = [(r["sender_name"], sender)]

        subject = r["subject"].strip()
        body = r["body_text"].strip()[:MAX_BODY]
        text = (f"Subject: {subject}\n{body}" if subject else body) or None
        when = dt.datetime.fromtimestamp(r["date"]).isoformat(sep=" ", timespec="seconds")
        message_id = rfc_message_id(r["reply_context"])
        recorded = False
        for name, addr in others:
            person_id = resolve_counterpart(conn, addr, name or names.get(addr), "email", written_to)
            if person_id and add_interaction(
                conn,
                person_id,
                when,
                "email",
                "out" if outgoing else "in",
                text,
                subject or None,
                email_ref(message_id, addr, f"mino:{r['account_id']}:{r['message_id']}"),
            ):
                stats["interactions"] += 1
                recorded = True
        if not recorded:
            stats["skipped"] += 1
    src.close()
    conn.commit()
    return stats
