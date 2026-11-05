"""LinkedIn import, read from "Get a copy of your data" (Settings > Data privacy).

Connections.csv lists each connection's profile URL, current company and title.
messages.csv holds DMs and InMail, naming people by display name and profile URL.
People are keyed by the slug of their profile URL (linkedin.com/in/<slug>).

A connection only becomes a person if you've messaged them; otherwise they're
linked to someone already known, by email or by a full name only one person has.
Linked connections get a confirmed LinkedIn profile and their current job.
"""

from __future__ import annotations

import csv
import datetime as dt
import hashlib
import html
import re
import sqlite3
import urllib.parse
from collections import Counter
from pathlib import Path

from .. import identity
from ..events import add_event
from .common import add_interaction

DELETED = "LinkedIn Member"
_TAG = re.compile(r"<[^>]+>")
_BREAK = re.compile(r"</p>|<br\s*/?>", re.I)


def slug(url: str) -> str | None:
    path = [p for p in urllib.parse.urlparse(url if "//" in url else "https://" + url).path.split("/") if p]
    if len(path) >= 2 and path[0] in ("in", "pub"):
        return urllib.parse.unquote(path[1]).lower()
    return None


def _handle(url: str) -> tuple[str, str] | None:
    s = slug(url)
    return ("linkedin", s) if s else None


def clean_name(name: str) -> str:
    """Drop the emoji people put around their names: "🖋  Johannes Naylor" -> "Johannes Naylor"."""
    return " ".join(re.sub(r"^[\W_]+|[^\w.)]+$", "", name.strip()).split())


def _when(raw: str) -> str:
    """'2026-10-22 15:46:36 UTC' -> local time, like the other importers."""
    utc = dt.datetime.strptime(raw.removesuffix(" UTC"), "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    return utc.astimezone().replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")


def _text(m: dict) -> str | None:
    body = m.get("CONTENT") or ""
    if "<" in body:
        body = html.unescape(_TAG.sub("", _BREAK.sub("\n", body)))
    body = body.strip()
    subject = (m.get("SUBJECT") or "").strip()
    if subject:
        body = f"{subject}\n\n{body}" if body else subject
    return body or None


def read_connections(root: Path) -> list[dict]:
    """Connections.csv starts with a notes preamble before its header row."""
    lines = (root / "Connections.csv").read_text(encoding="utf-8-sig").splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("First Name,"))
    out = []
    for row in csv.DictReader(lines[start:]):
        name = clean_name(f"{row['First Name']} {row['Last Name']}")
        if name and _handle(row["URL"]):
            out.append({**row, "name": name})
    return out


def _my_url(root: Path, messages: list[dict]) -> str | None:
    invitations = root / "Invitations.csv"
    if invitations.exists():
        for row in csv.DictReader(invitations.open(encoding="utf-8-sig", newline="")):
            if row["Direction"] == "OUTGOING" and row["inviterProfileUrl"]:
                return row["inviterProfileUrl"]
    # Failing that, you're whoever sent the most messages.
    senders = Counter(m["SENDER PROFILE URL"] for m in messages if m["SENDER PROFILE URL"])
    return senders.most_common(1)[0][0] if senders else None


def link_connection(conn: sqlite3.Connection, person_id: int, c: dict, said_at: str = "") -> None:
    """Attach a connection to a person: their LinkedIn handle, a confirmed profile, and current job."""
    identity.add_identifier(conn, person_id, *_handle(c["URL"]), "linkedin")
    if email := identity.normalize_email(c.get("Email Address") or ""):
        identity.add_identifier(conn, person_id, "email", email, "linkedin")
    url = f"https://linkedin.com/in/{slug(c['URL'])}"
    title = " · ".join(x for x in (c.get("Position"), c.get("Company")) if x)
    conn.execute(
        "INSERT INTO profiles (person_id, site, url, title, confidence, reason, status) "
        "VALUES (?, 'linkedin', ?, ?, 1.0, 'LinkedIn connection', 'confirmed') "
        "ON CONFLICT (person_id, url) DO UPDATE SET status = 'confirmed', title = excluded.title",
        (person_id, url, title),
    )
    position, company = (c.get("Position") or "").strip(), (c.get("Company") or "").strip()
    if position or company:
        job = f"Works as {position} at {company}" if position and company else f"Works {'as ' + position if position else 'at ' + company}"
        # A current title isn't news: '' marks it as known, not just learned.
        add_event(conn, person_id, "job", job, None, 0.9, "linkedin", url, f"LinkedIn: {title}", said_at)


def _unique_name(conn: sqlite3.Connection, name: str) -> int | None:
    if len(name.split()) < 2:
        return None
    rows = conn.execute(
        "SELECT id FROM people WHERE merged_into IS NULL AND is_me = 0 AND (lower(name) = lower(?) "
        "OR id IN (SELECT person_id FROM aliases WHERE lower(alias) = lower(?)))",
        (name, name),
    ).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def import_linkedin(conn: sqlite3.Connection, root: Path, since: dt.date | None = None) -> dict[str, int]:
    messages = list(csv.DictReader((root / "messages.csv").open(encoding="utf-8-sig", newline="")))
    connections = read_connections(root) if (root / "Connections.csv").exists() else []
    by_slug = {slug(c["URL"]): c for c in connections}

    my_url = _my_url(root, messages)
    me_handle = _handle(my_url) if my_url else None
    if me_handle and (user := identity.me(conn)):
        identity.add_identifier(conn, user["id"], *me_handle, "linkedin")

    conversations: dict[str, list[dict]] = {}
    for m in messages:
        if m["FOLDER"] != "SPAM" and m["CONVERSATION TITLE"] != "Sponsored Conversation":
            conversations.setdefault(m["CONVERSATION ID"], []).append(m)

    def participants(msgs: list[dict]) -> dict[tuple[str, str], str]:
        found = {}
        for m in msgs:
            names = [m["FROM"]] + m["TO"].split(",")
            urls = [m["SENDER PROFILE URL"]] + m["RECIPIENT PROFILE URLS"].split(",")
            for name, url in zip(names, urls):
                if (h := _handle(url.strip())) and h != me_handle:
                    found.setdefault(h, clean_name(name))
        return found

    # A real relationship: someone you've written to one-on-one.
    written_to = {
        h
        for msgs in conversations.values()
        if len(people := participants(msgs)) == 1 and any(_handle(m["SENDER PROFILE URL"]) == me_handle for m in msgs)
        for h in people
    }
    stats = {"connections": len(connections), "linked": 0, "messages": 0, "interactions": 0, "skipped": 0}
    resolved: dict[tuple[str, str], int | None] = {}

    def person_for(h: tuple[str, str], name: str) -> int | None:
        if h in resolved:
            return resolved[h]
        c = by_slug.get(h[1])
        person_id = identity.find_by_identifier(conn, *h)
        if person_id is None and c and (email := identity.normalize_email(c.get("Email Address") or "")):
            person_id = identity.find_by_identifier(conn, "email", email)
        if person_id is None:
            person_id = _unique_name(conn, c["name"] if c else name)
        if person_id is None and h in written_to and name and name != DELETED:
            person_id = identity.resolve(conn, [h], c["name"] if c else name, "linkedin")
        if person_id and conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
            person_id = None
        if person_id:
            identity.add_identifier(conn, person_id, *h, "linkedin")
            if c:
                link_connection(conn, person_id, c)
                stats["linked"] += 1
        resolved[h] = person_id
        return person_id

    for c in connections:
        person_for(_handle(c["URL"]), c["name"])

    cutoff = since.isoformat() if since else ""
    for cid, msgs in conversations.items():
        people = participants(msgs)
        group = len(people) > 1
        for m in msgs:
            stats["messages"] += 1
            when = _when(m["DATE"])
            outgoing = _handle(m["SENDER PROFILE URL"]) == me_handle
            if when < cutoff or (group and outgoing):
                stats["skipped"] += 1  # your own group messages aren't with anyone in particular
                continue
            if outgoing:
                counterpart = next(iter(people.items()), None)
            else:
                h = _handle(m["SENDER PROFILE URL"])
                counterpart = (h, clean_name(m["FROM"])) if h else None
            person_id = counterpart and person_for(*counterpart)
            text = _text(m)
            digest = hashlib.sha1((text or "").encode()).hexdigest()[:8]
            ref = f"linkedin:{cid}:{m['DATE']}:{m['SENDER PROFILE URL']}:{digest}"
            if person_id and add_interaction(
                conn, person_id, when, "linkedin", "out" if outgoing else "in", text, "group chat" if group else None, ref
            ):
                stats["interactions"] += 1
            else:
                stats["skipped"] += 1
    conn.commit()
    return stats
