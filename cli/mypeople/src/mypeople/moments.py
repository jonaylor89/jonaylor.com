"""Moment ranking: choose the few things worth surfacing today. Silence beats noise."""

from __future__ import annotations

import datetime as dt
import sqlite3
from dataclasses import dataclass

from . import relationships
from .events import (
    ANNIVERSARY_EVENTS,
    LIFE_EVENTS,
    approx_date,
    current_profile,
    events_for,
    format_date,
    full_date,
    is_superseded,
    month_day,
    next_occurrence,
    said_on,
)

DEFAULT_LIMIT = 5
MIN_SCORE = 0.2
RECENT_EVENT_DAYS = 21
UPCOMING_DAYS = 7
BIRTHDAY_DAYS = 7
DRIFT_COOLDOWN_DAYS = 30
PROMISE_DAYS = 60


@dataclass
class Moment:
    key: str
    person_id: int
    name: str
    kind: str
    reason: str
    context: str
    score: float


def _when(day: dt.date, today: dt.date) -> str:
    delta = (day - today).days
    if delta == 0:
        return "today"
    if delta == 1:
        return "tomorrow"
    if delta == -1:
        return "yesterday"
    if 0 < delta < 7:
        return day.strftime("on %A")
    if delta < 0:
        return f"{-delta} days ago"
    return f"in {delta} days"


def _ago(days: int | None) -> str:
    if days is None:
        return "You haven't talked in any connected source."
    if days == 0:
        return "You talked today."
    if days < 60:
        return f"Last talked {days} day{'s' if days != 1 else ''} ago."
    if days < 730:
        return f"Last talked about {round(days / 30)} months ago."
    return f"Last talked about {days // 365} years ago."


def _weight(rel: relationships.Relationship, confidence: float = 1.0) -> float:
    return (0.3 + 0.7 * rel.closeness) * confidence


def candidates(conn: sqlite3.Connection, today: dt.date) -> list[Moment]:
    people = conn.execute("SELECT id, name FROM people WHERE merged_into IS NULL AND is_me = 0").fetchall()
    out: list[Moment] = []
    for person in people:
        pid, name = person["id"], person["name"]
        rel = relationships.infer(conn, pid, today)
        if rel.muted:
            continue
        events = events_for(conn, pid)
        profile = current_profile(events)

        def context(skip_id: int) -> str:
            lines = [_ago(rel.days_since)]
            for e in events:
                if e["id"] != skip_id and e["type"] in LIFE_EVENTS | {"interest", "plan"} and not is_superseded(e, profile):
                    lines.append(f"Also: {e['value']} ({format_date(e['date'])}).")
                    break
            return " ".join(lines)

        for e in events:
            eid, etype, value = e["id"], e["type"], e["value"]
            day = full_date(e["date"])

            if etype == "birthday" and (md := month_day(e["date"])):
                nxt = next_occurrence(md, today)
                delta = (nxt - today).days
                if delta <= BIRTHDAY_DAYS:
                    out.append(Moment(
                        f"birthday:{pid}:{nxt.year}", pid, name, "birthday",
                        f"{name}'s birthday is {_when(nxt, today)}.",
                        context(eid), 0.7 * (1 - delta / 14) * _weight(rel),
                    ))
                continue

            if etype in ANNIVERSARY_EVENTS and day and day.year < today.year:
                nxt = next_occurrence((day.month, day.day), today)
                delta = (nxt - today).days
                years = nxt.year - day.year
                if delta <= 1 and years >= 1:
                    span = "One year" if years == 1 else f"{years} years"
                    out.append(Moment(
                        f"anniversary:{eid}:{nxt.year}", pid, name, "anniversary",
                        f"{span} ago {'today' if delta == 0 else 'tomorrow'}: {value}.",
                        context(eid), (1.0 if etype == "loss" else 0.6) * _weight(rel, e["confidence"]),
                    ))

            approx = approx_date(e["date"])
            said = said_on(e)  # when it came up in conversation; None if unknown

            if day and 0 <= (day - today).days <= UPCOMING_DAYS and etype not in ("interest", "family"):
                delta = (day - today).days
                out.append(Moment(
                    f"upcoming:{eid}", pid, name, "upcoming",
                    f"{name}: {value}, {_when(day, today)}.",
                    context(eid), 0.8 * (1 - delta / 14) * _weight(rel, e["confidence"]),
                ))
            elif etype in LIFE_EVENTS:
                # Fresh by its own date or, if undated, by when it came up (not when MyPeople read it).
                anchor = approx if approx and approx <= today else (None if approx else said)
                age = (today - anchor).days if anchor else None
                if age is not None and 0 <= age <= RECENT_EVENT_DAYS and e["source"] != "vcard":
                    out.append(Moment(
                        f"life:{eid}", pid, name, "life_event",
                        f"{name}: {value} ({format_date(e['date'])}).",
                        context(eid), 0.9 * (1 - age / (2 * RECENT_EVENT_DAYS)) * _weight(rel, e["confidence"]),
                    ))
            elif etype == "promise" and said:
                age = (today - said).days
                if 0 <= age <= PROMISE_DAYS:
                    out.append(Moment(
                        f"promise:{eid}", pid, name, "promise",
                        f"Open thread with {name}: {value}.",
                        context(eid), 0.6 * _weight(rel, e["confidence"]),
                    ))

        # Drifting: someone you talk to regularly has gone quiet for well past their rhythm.
        if rel.cadence_days and rel.days_since and rel.closeness >= 0.3:
            overdue = rel.overdue_ratio
            if overdue >= 2.5 and rel.days_since >= 21:
                week = today.isocalendar()
                out.append(Moment(
                    f"drift:{pid}:{week.year}-{week.week}", pid, name, "drifting",
                    f"You usually talk with {name} every {round(rel.cadence_days)} days; it's been {rel.days_since}.",
                    context(-1), 0.5 * min(1.0, overdue / 5) * _weight(rel),
                ))
    return out


def _suppressed(conn: sqlite3.Connection, m: Moment, today: dt.date) -> bool:
    row = conn.execute("SELECT surfaced_on FROM moments WHERE key = ?", (m.key,)).fetchone()
    if row and row["surfaced_on"] != today.isoformat():
        return True  # each moment is shown once (re-running today shows the same set)
    if m.kind == "drifting":
        cutoff = (today - dt.timedelta(days=DRIFT_COOLDOWN_DAYS)).isoformat()
        recent = conn.execute(
            "SELECT 1 FROM moments WHERE person_id = ? AND kind = 'drifting' AND surfaced_on >= ? AND surfaced_on < ?",
            (m.person_id, cutoff, today.isoformat()),
        ).fetchone()
        return bool(recent)
    return False


def today_moments(
    conn: sqlite3.Connection, today: dt.date | None = None, limit: int = DEFAULT_LIMIT, record: bool = True
) -> list[Moment]:
    today = today or dt.date.today()
    ranked = sorted(candidates(conn, today), key=lambda m: m.score, reverse=True)
    chosen: list[Moment] = []
    seen_people: set[int] = set()
    for m in ranked:
        if m.score < MIN_SCORE or len(chosen) >= limit:
            break
        if m.person_id in seen_people or _suppressed(conn, m, today):
            continue
        chosen.append(m)
        seen_people.add(m.person_id)
    if record:
        for m in chosen:
            conn.execute(
                "INSERT INTO moments (key, person_id, kind, reason, context, score, surfaced_on) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING",
                (m.key, m.person_id, m.kind, m.reason, m.context, m.score, today.isoformat()),
            )
        conn.commit()
    return chosen
