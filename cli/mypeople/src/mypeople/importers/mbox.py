"""Email import from .mbox files (Gmail via Google Takeout, Apple Mail export)."""

from __future__ import annotations

import datetime as dt
import mailbox
import re
import sqlite3
from email import policy
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path

from .. import identity
from .common import add_interaction, email_ref, resolve_counterpart

MAX_BODY = 4000
_BULK_SENDER = re.compile(r"no-?reply|notifications?@|mailer-daemon|newsletter|updates@", re.I)
_REPLY_HEADER = re.compile(r"^On .{5,200} wrote:\s*$", re.M)
# Gmail Takeout tags each message with its labels, including the inbox tabs.
GMAIL_BULK_LABELS = {"spam", "category promotions", "category social", "category updates", "category forums"}


def _messages(path: Path):
    box = mailbox.mbox(path, factory=lambda f: BytesParser(policy=policy.default).parse(f), create=False)
    try:
        for msg in box:
            if msg is not None:
                yield msg
    finally:
        box.close()


def _addresses(msg: EmailMessage, *headers: str) -> list[tuple[str, str]]:
    values = [str(v) for h in headers for v in msg.get_all(h, [])]
    return [(name, addr.lower()) for name, addr in getaddresses(values) if "@" in addr]


def gmail_labels(msg: EmailMessage) -> set[str]:
    return {label.strip().lower() for label in str(msg.get("X-Gmail-Labels", "")).split(",") if label.strip()}


def _is_bulk(msg: EmailMessage, sender: str) -> bool:
    return bool(
        gmail_labels(msg) & GMAIL_BULK_LABELS
        or msg.get("List-Unsubscribe")
        or str(msg.get("Precedence", "")).lower() in ("bulk", "list", "junk")
        or _BULK_SENDER.search(sender)
    )


def body_text(msg: EmailMessage) -> str:
    try:
        part = msg.get_body(preferencelist=("plain",))
        text = part.get_content() if part else ""
    except (KeyError, LookupError):
        return ""
    # Drop the quoted history so each message only contributes what's new.
    if m := _REPLY_HEADER.search(text):
        text = text[: m.start()]
    lines = [line for line in text.splitlines() if not line.startswith(">")]
    return "\n".join(lines).strip()[:MAX_BODY]


def _when(msg: EmailMessage) -> dt.datetime | None:
    try:
        when = parsedate_to_datetime(str(msg["Date"]))
    except (TypeError, ValueError):
        return None
    return when.astimezone().replace(tzinfo=None) if when.tzinfo else when


def import_mbox(conn: sqlite3.Connection, path: Path, me: list[str], since: dt.date | None = None) -> dict[str, int]:
    me_set = {m.lower() for m in me} | identity.my_addresses(conn)
    written_to: set[tuple[str, str]] = set()
    for msg in _messages(path):
        if any(a in me_set for _, a in _addresses(msg, "From")):
            written_to.update(("email", a) for _, a in _addresses(msg, "To", "Cc", "Bcc") if a not in me_set)

    stats = {"messages": 0, "interactions": 0, "skipped": 0}
    for msg in _messages(path):
        stats["messages"] += 1
        when = _when(msg)
        senders = _addresses(msg, "From")
        if not when or not senders or (since and when.date() < since) or "spam" in gmail_labels(msg):
            stats["skipped"] += 1
            continue
        outgoing = senders[0][1] in me_set
        if outgoing:
            others = [(n, a) for n, a in _addresses(msg, "To", "Cc", "Bcc") if a not in me_set]
        elif _is_bulk(msg, senders[0][1]):
            stats["skipped"] += 1
            continue
        else:
            others = senders[:1]
        subject = str(msg.get("Subject", "")).strip()
        text = body_text(msg)
        text = f"Subject: {subject}\n{text}" if subject else text
        msg_id = str(msg.get("Message-ID", ""))
        for name, addr in others:
            person_id = resolve_counterpart(conn, addr, name or None, "email", written_to)
            if not person_id:
                continue
            if add_interaction(
                conn,
                person_id,
                when.isoformat(sep=" ", timespec="seconds"),
                "email",
                "out" if outgoing else "in",
                text,
                subject or None,
                email_ref(msg_id, addr, f"{when.isoformat()}:{subject}"),
            ):
                stats["interactions"] += 1
    conn.commit()
    return stats
