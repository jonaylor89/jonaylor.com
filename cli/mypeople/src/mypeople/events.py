"""Events: dated facts about a person, each carrying its source and confidence."""

from __future__ import annotations

import datetime as dt
import re
import sqlite3

EVENT_TYPES = (
    "birthday",
    "job",
    "education",
    "move",
    "engagement",
    "wedding",
    "birth",
    "loss",
    "health",
    "trip",
    "achievement",
    "plan",
    "interest",
    "family",
    "promise",
    "other",
)

# Life events worth a nudge when they are fresh.
LIFE_EVENTS = {"job", "education", "move", "engagement", "wedding", "birth", "loss", "health", "achievement"}
# Events whose anniversaries matter, including the hard ones.
ANNIVERSARY_EVENTS = {"loss", "wedding", "birth"}

_DATE_RE = re.compile(r"^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$")
_NOYEAR_RE = re.compile(r"^--(\d{2})-(\d{2})$")


def normalize_date(raw: str | None) -> str:
    """Accept YYYY, YYYY-MM, YYYY-MM-DD or --MM-DD; anything else becomes unknown ('')."""
    if not raw:
        return ""
    raw = raw.strip()
    if _NOYEAR_RE.match(raw):
        return raw
    m = _DATE_RE.match(raw)
    if not m:
        return ""
    try:
        if m.group(3):
            dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        elif m.group(2) and not 1 <= int(m.group(2)) <= 12:
            return ""
    except ValueError:
        return ""
    return raw


def full_date(date: str) -> dt.date | None:
    """The exact day, if the event has one."""
    m = _DATE_RE.match(date)
    if m and m.group(3):
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    return None


def approx_date(date: str) -> dt.date | None:
    """Best guess at a day: the first of the month or year for partial dates."""
    m = _DATE_RE.match(date)
    if not m:
        return None
    return dt.date(int(m.group(1)), int(m.group(2) or 1), int(m.group(3) or 1))


def month_day(date: str) -> tuple[int, int] | None:
    m = _NOYEAR_RE.match(date)
    if m:
        return int(m.group(1)), int(m.group(2))
    day = full_date(date)
    return (day.month, day.day) if day else None


def next_occurrence(md: tuple[int, int], today: dt.date) -> dt.date:
    month, day = md
    for year in (today.year, today.year + 1):
        try:
            candidate = dt.date(year, month, day)
        except ValueError:  # Feb 29 outside a leap year
            candidate = dt.date(year, 3, 1)
        if candidate >= today:
            return candidate
    raise AssertionError("unreachable")


def format_date(date: str) -> str:
    if not date:
        return "date unknown"
    if _NOYEAR_RE.match(date):
        return dt.date(2000, *month_day(date)).strftime("%b %-d")
    m = _DATE_RE.match(date)
    if m.group(3):
        return full_date(date).strftime("%b %-d, %Y")
    if m.group(2):
        return dt.date(int(m.group(1)), int(m.group(2)), 1).strftime("%b %Y")
    return m.group(1)


def add_event(
    conn: sqlite3.Connection,
    person_id: int,
    type: str,
    value: str,
    date: str | None,
    confidence: float,
    source: str,
    source_ref: str | None = None,
    evidence: str | None = None,
    said_at: str | None = None,
) -> int | None:
    """Insert an event; returns its id, or None if it was already known.

    said_at is when the fact came up (its message's time); left out, it counts as just now."""
    if type not in EVENT_TYPES:
        type = "other"
    cur = conn.execute(
        "INSERT OR IGNORE INTO events (person_id, type, value, date, confidence, source, source_ref, evidence, said_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now', 'localtime')))",
        (
            person_id,
            type,
            value.strip(),
            normalize_date(date),
            max(0.0, min(1.0, confidence)),
            source,
            source_ref,
            evidence,
            said_at,
        ),
    )
    return cur.lastrowid if cur.rowcount else None


def said_on(event: sqlite3.Row) -> dt.date | None:
    """The day a fact came up in conversation, or None if unknown."""
    when = event["said_at"]
    return dt.date.fromisoformat(when[:10]) if when else None


# Facts where only the latest one is true now.
CURRENT_STATE = ("job", "move", "education")


def when_known(event: sqlite3.Row) -> str:
    """Sort key: the event's own date, or when MyPeople learned it if undated."""
    date = event["date"]
    return event["created_at"][:10] if not date or date.startswith("--") else date


def current_profile(events: list[sqlite3.Row]) -> dict[str, sqlite3.Row]:
    """The person as they are now, derived from their events."""
    profile: dict[str, sqlite3.Row] = {}
    for e in events:
        if e["type"] in CURRENT_STATE:
            best = profile.get(e["type"])
            # Prefer what people said over address-book fields of unknown age.
            rank = (e["source"] != "vcard", when_known(e))
            if best is None or rank > (best["source"] != "vcard", when_known(best)):
                profile[e["type"]] = e
    return profile


def is_superseded(event: sqlite3.Row, profile: dict[str, sqlite3.Row]) -> bool:
    current = profile.get(event["type"])
    return current is not None and current["id"] != event["id"]


def events_for(conn: sqlite3.Connection, person_id: int) -> list[sqlite3.Row]:
    return conn.execute(
        "SELECT * FROM events WHERE person_id = ? AND status = 'active' "
        "ORDER BY CASE WHEN date = '' OR date LIKE '--%' THEN created_at ELSE date END DESC",
        (person_id,),
    ).fetchall()
