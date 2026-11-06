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

# events.source for what you wrote yourself. Every other source was derived or imported.
MANUAL = "manual"
# Your own words about someone, kept verbatim. Not in EVENT_TYPES: only you write notes, the model doesn't.
NOTE = "note"
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
    if type not in EVENT_TYPES and type != NOTE:
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


def add_note(conn: sqlite3.Connection, person_id: int, text: str) -> int | None:
    """Save a note as written. Needs no model; `mypeople extract` reads it later for facts."""
    return remember(conn, person_id, NOTE, text, None)


# Facts reconcile between devices without clocks or conflicts. Each fact is identified by its
# contact, type, text and date, and has a generation: odd is present, even is forgotten. Adding
# or forgetting moves it to the next generation, and devices keep the higher one, so any devices
# reach the same answer whatever order they sync in. The model can't undo a choice of yours:
# add_event never revives a forgotten fact. Only `remember`, for what you add yourself, does.

def _fact(conn: sqlite3.Connection, person_id: int, type: str, value: str, date: str | None) -> sqlite3.Row | None:
    return conn.execute("SELECT id, generation, status, source FROM events WHERE person_id = ? AND type = ? AND value = ? AND date = ?",
                        (person_id, type, value.strip(), normalize_date(date))).fetchone()


def remember(conn: sqlite3.Connection, person_id: int, type: str, value: str, date: str | None) -> int | None:
    """Add a fact you stated, bringing it back if it was forgotten. None if it's already known."""
    row = _fact(conn, person_id, type, value, date)
    if row is None:
        return add_event(conn, person_id, type, value, date, 1.0, MANUAL)
    if row["status"] == "active":
        return None
    conn.execute("UPDATE events SET generation = generation + 1, status = 'active', source = ?, source_ref = NULL WHERE id = ?",
                 (MANUAL, row["id"]))
    return row["id"]


def forget(conn: sqlite3.Connection, person_id: int, type: str, value: str, date: str | None) -> None:
    """Forget a fact, even one this device hasn't received yet: it stays gone when it arrives."""
    if _fact(conn, person_id, type, value, date) is None:
        add_event(conn, person_id, type, value, date, 1.0, MANUAL)
    row = _fact(conn, person_id, type, value, date)
    if row["status"] == "active":
        conn.execute("UPDATE events SET generation = generation + 1, status = 'rejected' WHERE id = ?", (row["id"],))


def reconcile(conn: sqlite3.Connection, person_id: int, fact: dict, generation: int, source_ref: str | None = None) -> str | None:
    """Join another device's fact into this database. Says what changed: 'added', 'forgotten' or None."""
    type, value, date = fact["type"], fact["value"], fact.get("date")
    now = "active" if generation % 2 else "rejected"
    row = _fact(conn, person_id, type, value, date)
    if row is None:
        rowid = add_event(conn, person_id, type, value, date, float(fact.get("confidence", 1.0)), str(fact.get("source") or MANUAL),
                          source_ref, fact.get("evidence"), fact.get("said_at"))
        if rowid is None:
            return None
        conn.execute("UPDATE events SET generation = ?, status = ? WHERE id = ?", (generation, now, rowid))
        return "added" if now == "active" else None  # forgotten there, and never shown here
    if generation >= row["generation"] and fact.get("source") == MANUAL:
        conn.execute("UPDATE events SET source = ? WHERE id = ?", (MANUAL, row["id"]))  # the same on every device
    if generation > row["generation"]:
        conn.execute("UPDATE events SET generation = ?, status = ? WHERE id = ?", (generation, now, row["id"]))
        if row["status"] != now:
            return "added" if now == "active" else "forgotten"
    return None


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
