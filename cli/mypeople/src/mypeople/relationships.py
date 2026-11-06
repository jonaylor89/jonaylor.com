"""Relationship modeling, inferred from interaction history. The user can override any of it."""

from __future__ import annotations

import datetime as dt
import math
import sqlite3
import statistics
from dataclasses import dataclass

CATEGORIES = ("family", "partner", "friend", "work", "acquaintance", "unknown")
MIN_DAYS_FOR_CADENCE = 4


@dataclass
class Relationship:
    person_id: int
    category: str
    closeness: float  # 0..1
    cadence_days: float | None  # typical gap between conversations
    days_since: int | None
    trend: str  # growing | steady | drifting | new | none
    days_365: int  # distinct days in contact over the last year
    last_channel: str | None
    muted: bool

    @property
    def overdue_ratio(self) -> float:
        if not self.cadence_days or self.days_since is None:
            return 0.0
        return self.days_since / self.cadence_days


def _parse_day(at: str) -> dt.date:
    return dt.date.fromisoformat(at[:10])


def infer(conn: sqlite3.Connection, person_id: int, today: dt.date | None = None) -> Relationship:
    today = today or dt.date.today()
    rows = conn.execute(
        "SELECT at, direction, channel FROM interactions WHERE person_id = ? AND at <= ? ORDER BY at",
        (person_id, f"{today.isoformat()} 23:59:59"),
    ).fetchall()
    override = conn.execute("SELECT * FROM relationship_overrides WHERE person_id = ?", (person_id,)).fetchone()

    days = sorted({_parse_day(r["at"]) for r in rows})
    year_ago = today - dt.timedelta(days=365)
    recent_days = [d for d in days if d > year_ago]
    days_since = (today - days[-1]).days if days else None

    cadence = None
    if len(recent_days) >= MIN_DAYS_FOR_CADENCE:
        gaps = [(b - a).days for a, b in zip(recent_days, recent_days[1:])]
        cadence = max(1.0, float(statistics.median(gaps)))

    last90 = sum(1 for d in days if (today - d).days < 90)
    prior = sum(1 for d in days if 90 <= (today - d).days < 360) / 3  # per 90 days
    if not days:
        trend = "none"
    elif days[0] > today - dt.timedelta(days=90):
        trend = "new"
    elif last90 >= 3 and last90 > prior * 1.5:
        trend = "growing"
    elif (prior >= 3 and last90 < prior * 0.5) or (cadence and days_since >= max(21, 3 * cadence)):
        trend = "drifting"
    else:
        trend = "steady"

    # Closeness: how often you talk, whether it goes both ways, and how recently.
    outgoing = sum(1 for r in rows if r["direction"] == "out" and _parse_day(r["at"]) > year_ago)
    incoming = sum(1 for r in rows if r["direction"] == "in" and _parse_day(r["at"]) > year_ago)
    frequency = min(1.0, math.log1p(len(recent_days)) / math.log1p(120))
    reciprocity = 0.5 + 0.5 * (min(outgoing, incoming) / max(outgoing, incoming)) if outgoing and incoming else 0.5
    recency = math.exp(-days_since / 180) if days_since is not None else 0.0
    closeness = round(0.75 * frequency * reciprocity + 0.25 * recency, 3)

    category = "unknown"
    muted = False
    if override:
        category = override["category"] or category
        closeness = override["closeness"] if override["closeness"] is not None else closeness
        cadence = override["cadence_days"] if override["cadence_days"] is not None else cadence
        muted = bool(override["muted"])

    return Relationship(
        person_id=person_id,
        category=category,
        closeness=closeness,
        cadence_days=cadence,
        days_since=days_since,
        trend=trend,
        days_365=len(recent_days),
        last_channel=rows[-1]["channel"] if rows else None,
        muted=muted,
    )


def view_hints(rel: Relationship) -> dict:
    """Rebuildable screen hints, shared by normal sync and read-only migration.

    These are calculated from interactions/overrides, not columns on people.
    Keep the existing scoring formula and published precision unchanged.
    """
    return {
        "category": rel.category,
        "closeness": round(rel.closeness, 2),
        "cadence_days": rel.cadence_days,
        "trend": rel.trend,
        "days_365": rel.days_365,
        "muted": rel.muted,
    }


def set_override(conn: sqlite3.Connection, person_id: int, **fields) -> None:
    conn.execute("INSERT OR IGNORE INTO relationship_overrides (person_id) VALUES (?)", (person_id,))
    for key, value in fields.items():
        if key not in ("category", "closeness", "cadence_days", "muted"):
            raise ValueError(f"Unknown relationship field {key!r}")
        conn.execute(f"UPDATE relationship_overrides SET {key} = ? WHERE person_id = ?", (value, person_id))
    conn.commit()
