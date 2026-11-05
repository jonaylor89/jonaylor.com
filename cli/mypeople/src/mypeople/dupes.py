"""Reviewing people who share a name: enough side by side to tell one person from two.

Each record shows its identifiers, when and where you talked, what's known about
them, and a few things they said. Groups the user marks as different people are
remembered and not asked about again.
"""

from __future__ import annotations

import re
import sqlite3
import unicodedata
from dataclasses import dataclass, field

from pydantic import BaseModel, ValidationError

from . import identity, llm
from .events import current_profile, events_for, format_date
from .relationships import infer

SAMPLE_MESSAGES = 3
SAMPLE_CHARS = 90
MAX_CANDIDATES = 3  # a first name shared with more full names than this is too common to review
_PLAIN_NAME = re.compile(r"[^\W\d_][\w .'’-]*")
_WORD = re.compile(r"[A-Z][\w'’&.-]+(?:\s+[A-Z][\w'’&.-]+)*")


@dataclass
class Card:
    person: sqlite3.Row
    ids: list[str]
    channels: list[tuple[str, int]]
    first: str | None
    last: str | None
    closeness: float
    now: list[str]
    facts: list[str]
    said: list[tuple[str, str]]  # (date, text), their own words
    photos: list[str] = field(default_factory=list)

    @property
    def total(self) -> int:
        return sum(n for _, n in self.channels)


def _identifier(kind: str, value: str) -> str | None:
    if kind == "phone":
        return f"({value[:3]}) {value[3:6]}-{value[6:]}" if len(value) == 10 else value
    if kind == "google":
        return None  # a Google Contacts record id says nothing to a person
    if kind in ("email",):
        return value
    return f"{value} ({kind})"


def card(conn: sqlite3.Connection, person: sqlite3.Row) -> Card:
    pid = person["id"]
    ids = [
        s for r in conn.execute("SELECT kind, value FROM identifiers WHERE person_id = ? ORDER BY kind", (pid,))
        if (s := _identifier(r["kind"], r["value"]))
    ]
    if conn.execute("SELECT 1 FROM identifiers WHERE person_id = ? AND kind = 'google'", (pid,)).fetchone():
        ids.append("in Google Contacts")
    span = conn.execute("SELECT MIN(at) AS first, MAX(at) AS last FROM interactions WHERE person_id = ?", (pid,)).fetchone()
    channels = [
        (r["channel"], r["n"]) for r in conn.execute(
            "SELECT channel, COUNT(*) AS n FROM interactions WHERE person_id = ? GROUP BY channel ORDER BY n DESC", (pid,))
    ]
    events = events_for(conn, pid)
    profile = current_profile(events)
    now = [profile[t]["value"] for t in ("job", "move", "education") if t in profile]
    facts = [
        e["value"] + (f" ({format_date(e['date'])})" if e["date"] else "")
        for e in events
        if e["type"] not in ("promise", "plan") and e["value"] not in now
    ][:4]
    said = [
        (r["at"][:10], " ".join(r["text"].split())[:SAMPLE_CHARS])
        for r in conn.execute(
            "SELECT at, text FROM interactions WHERE person_id = ? AND direction = 'in' AND length(text) > 12 "
            "AND (thread IS NULL OR thread != 'group chat') ORDER BY at DESC LIMIT ?",
            (pid, SAMPLE_MESSAGES),
        )
    ]
    photos = [r["path"] for r in conn.execute("SELECT path FROM photos WHERE person_id = ?", (pid,))]
    return Card(person, ids, channels, span["first"], span["last"], infer(conn, pid).closeness, now, facts, said, photos)


def _fold(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode().lower()


def shared_clues(cards: list[Card], conn: sqlite3.Connection | None = None) -> list[str]:
    """What the records have in common or what sets them apart, in plain words."""
    clues = []
    short = [c for c in cards if len(c.person["name"].split()) == 1]
    if conn and short and len(short) < len(cards):
        # Does the first-name-only record's history ever use a candidate's surname?
        for s in short:
            texts = _fold(" ".join(r["text"] for r in conn.execute(
                "SELECT text FROM interactions WHERE person_id = ? AND text IS NOT NULL", (s.person["id"],))))
            handles = _fold(" ".join(s.ids))
            for c in cards:
                for last in [w for w in _fold(c.person["name"]).split()[1:] if len(w) >= 3]:
                    if re.search(rf"\b{re.escape(last)}\b", texts):
                        clues.append(f"Messages with #{s.person['id']} mention “{last.title()}”, #{c.person['id']}'s surname")
                    elif last in re.sub(r"[._-]", "", handles):
                        clues.append(f"#{s.person['id']}'s handle contains “{last}”, #{c.person['id']}'s surname")
    names = {w.lower() for c in cards for w in c.person["name"].split()}
    def places(c: Card) -> set[str]:
        return {m.lower() for text in c.now + c.facts for m in _WORD.findall(text)} - names
    common = set.intersection(*(places(c) for c in cards))
    if common:
        clues.append("Both mention " + ", ".join(sorted(common)[:4]))
    talked = [c for c in cards if c.first]
    if len(talked) == 2:  # with more, pairwise timing gets confusing
        a, b = sorted(talked, key=lambda c: c.first)
        if a.last < b.first:
            clues.append(f"#{a.person['id']}'s chats end ({a.last[:7]}) before #{b.person['id']}'s start ({b.first[:7]}): could be a switch of app or number")
        else:
            clues.append(f"Talked to both in the same period ({b.first[:7]} – {min(a.last, b.last)[:7]})")
    if sum(1 for c in cards if c.total == 0) == len(cards) - 1:
        clues.append("Only one record has any conversations; the others are address-book entries or handles")
    for c in cards:
        if "@" in c.person["name"]:
            clues.append(f"#{c.person['id']} is only an email address; its username looks like the others' name")
    named = [c for c in cards if "@" not in c.person["name"] and len(c.person["name"].split()) > 1]
    for a in named:
        for b in named:
            if _words(a.person["name"]) < _words(b.person["name"]):
                clues.append(f"“{b.person['name']}” contains all of “{a.person['name']}”: maybe a married or middle name")
    if len(short) == len(cards):
        clues.append("A first name only, so it's weak evidence on its own")
    elif short:
        clues.append("Only the first name matches; check the details")
    return clues


def render(cards: list[Card]) -> str:
    lines = []
    for i, c in enumerate(cards, 1):
        talk = ", ".join(f"{n} {ch}" for ch, n in c.channels) or "no conversations"
        when = f" ({c.first[:7]} → {c.last[:7]})" if c.first else ""
        lines.append(f"  [{i}] #{c.person['id']}  {c.person['name']}  · closeness {c.closeness:.2f}")
        lines.append(f"      {talk}{when}")
        if c.ids:
            lines.append(f"      ids: {' · '.join(c.ids[:5])}")
        if c.now:
            lines.append(f"      now: {' · '.join(c.now)}")
        for f in c.facts:
            lines.append(f"      - {f}")
        for date, text in c.said:
            lines.append(f"      “{text}” ({date})")
        if c.photos:
            lines.append(f"      {len(c.photos)} photo{'s' if len(c.photos) > 1 else ''}")
    return "\n".join(lines)


# --- remembering "not the same person" -------------------------------------------

def _pairs(ids: list[int]) -> list[tuple[int, int]]:
    return [(min(a, b), max(a, b)) for i, a in enumerate(ids) for b in ids[i + 1:]]


def mark_distinct(conn: sqlite3.Connection, ids: list[int]) -> None:
    conn.executemany("INSERT OR IGNORE INTO distinct_people (a, b) VALUES (?, ?)", _pairs(ids))
    conn.commit()


def first_name_groups(conn: sqlite3.Connection) -> list[list[sqlite3.Row]]:
    """A person known by a first name only, with the few people whose full name starts with it."""
    rows = conn.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM interactions i WHERE i.person_id = p.id) AS n "
        "FROM people p WHERE merged_into IS NULL AND is_me = 0 ORDER BY n DESC"
    ).fetchall()
    full: dict[str, list[sqlite3.Row]] = {}
    for r in rows:
        words = _fold(r["name"]).split()
        if len(words) >= 2 and len(words[0]) >= 2:
            full.setdefault(words[0], []).append(r)
    groups = []
    for r in rows:
        if len(r["name"].split()) == 1 and re.fullmatch(r"[^\W\d_]{2,}", r["name"]):
            if 0 < len(candidates := full.get(_fold(r["name"]), [])) <= MAX_CANDIDATES:
                groups.append([r, *candidates])
    return groups


def _words(name: str) -> set[str]:
    return set(_fold(name).replace(".", " ").split())


def variant_groups(conn: sqlite3.Connection) -> list[list[sqlite3.Row]]:
    """Names that look like another version of someone's: one full name inside a longer one
    ("Colleen Connolly" and "Colleen Connolly Forte", as after a wedding), or a record named
    after an email address whose username holds someone's surname and initial."""
    rows = conn.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM interactions i WHERE i.person_id = p.id) AS n "
        "FROM people p WHERE merged_into IS NULL AND is_me = 0 ORDER BY n DESC"
    ).fetchall()
    full = [r for r in rows if sum(len(w) >= 2 for w in _words(r["name"])) >= 2 and not identity.looks_like_identifier(r["name"])]
    by_first: dict[str, list[sqlite3.Row]] = {}
    for r in full:
        by_first.setdefault(_fold(r["name"]).replace(".", " ").split()[0], []).append(r)
    aliases: dict[int, list[str]] = {}
    for a in conn.execute("SELECT person_id, alias FROM aliases"):
        if len(_words(a["alias"])) >= 2:
            aliases.setdefault(a["person_id"], []).append(a["alias"])
    groups = []
    for r in full:
        words = _words(r["name"])
        longer = [o for o in by_first[_fold(r["name"]).replace(".", " ").split()[0]] if words < _words(o["name"])]
        if 0 < len(longer) <= MAX_CANDIDATES:
            groups.append([r, *longer])
    for r in rows:
        if "@" not in r["name"]:
            continue
        local = re.sub(r"[^a-z]", "", _fold(r["name"].split("@")[0]))
        matches = []
        for o in full:
            for name in [o["name"], *aliases.get(o["id"], [])]:  # a maiden name kept as a nickname counts
                words = _fold(name).replace(".", " ").split()
                first, last = words[0], words[-1]
                if len(words) >= 2 and len(last) >= 4 and last in local and (first in local or local.replace(last, "", 1).startswith(first[0])):
                    matches.append(o)
                    break
        if 0 < len(matches) <= MAX_CANDIDATES:
            groups.append([r, *matches])
    return groups


def to_review(conn: sqlite3.Connection, first_names: bool = True, same_names: bool = True) -> list[list[sqlite3.Row]]:
    """Groups with at least one pair not yet marked as different people: shared full names first,
    then shared first names, then name variants (maiden names, email-named records), then a first
    name next to full names, each by how close you are."""
    known = {(r["a"], r["b"]) for r in conn.execute("SELECT a, b FROM distinct_people")}
    open_pairs = lambda g: any(p not in known for p in _pairs([r["id"] for r in g]))
    groups = [g for g in identity.name_duplicates(conn) if open_pairs(g)] if same_names else []
    groups.sort(key=lambda g: len(g[0]["name"].split()) < 2)
    if same_names:
        variants = [g for g in variant_groups(conn) if open_pairs(g)]
        variants.sort(key=lambda g: -max(infer(conn, r["id"]).closeness for r in g))
        groups += variants
    if first_names:
        partial = []
        for g in first_name_groups(conn):
            # Drop candidates already ruled out for this first-name record.
            g = [g[0]] + [r for r in g[1:] if (min(g[0]["id"], r["id"]), max(g[0]["id"], r["id"])) not in known]
            if len(g) > 1:
                partial.append(g)
        partial.sort(key=lambda g: -max(infer(conn, r["id"]).closeness for r in g))
        groups += partial
    return groups


def _better_name(keep: sqlite3.Row, chosen: list[sqlite3.Row]) -> str | None:
    """A fuller name for the kept record: a real name over an address, a full name over a first
    name, a longer name that contains this one (a married name over a maiden one)."""
    mine = _words(keep["name"])
    for r in sorted(chosen, key=lambda r: -len(_words(r["name"]))):
        if identity.looks_like_identifier(r["name"]) or not _PLAIN_NAME.fullmatch(r["name"]):
            continue  # not "Alex Muresan | Work Archetypes"
        theirs = _words(r["name"])
        if identity.looks_like_identifier(keep["name"]) or (len(theirs) > len(mine) and (len(mine) == 1 or mine < theirs)):
            return r["name"]
    return None


def merge(conn: sqlite3.Connection, chosen: list[sqlite3.Row], *, commit: bool = True) -> int:
    """Fold the chosen records into the one with the most history. It takes the fullest name
    among them, keeping its old name as a nickname."""
    # Earlier merges in the same review may have folded some of these together already.
    ids = list(dict.fromkeys(identity.canonical(conn, r["id"]) for r in chosen))
    chosen = conn.execute(
        f"SELECT p.*, (SELECT COUNT(*) FROM interactions i WHERE i.person_id = p.id) AS n FROM people p "
        f"WHERE id IN ({', '.join('?' * len(ids))})", ids,
    ).fetchall()
    keep = max(chosen, key=lambda r: r["n"])
    for r in chosen:
        if r["id"] != keep["id"]:
            identity.merge(conn, keep["id"], r["id"])
    if name := _better_name(keep, chosen):
        if not identity.looks_like_identifier(keep["name"]):
            identity.add_alias(conn, keep["id"], keep["name"])
        conn.execute("UPDATE people SET name = ? WHERE id = ?", (name, keep["id"]))
    import json
    row = conn.execute("SELECT contact_data FROM people WHERE id=?", (keep["id"],)).fetchone()
    if row["contact_data"]:
        card = json.loads(row["contact_data"]); card["name"] = name or keep["name"]
        conn.execute("UPDATE people SET contact_data=? WHERE id=?", (json.dumps(card), keep["id"]))
    if commit:
        conn.commit()
    return keep["id"]


# --- asking the model --------------------------------------------------------------

class Verdict(BaseModel):
    same_person: bool
    confidence: float  # 0 to 1
    reason: str


JUDGE_SYSTEM = """You help the user decide whether records in their contacts that share a name are one person.
Each record lists how the user reaches them, when they talked, what's known, and a few things they said.
Records often differ because someone changed apps, numbers, or jobs; that alone doesn't make them different people.
Look for shared or conflicting specifics: places, employers, schools, people, plans, writing style.
A shared first name alone is NOT evidence. same_person: your best call. confidence: probability it's one person (0 to 1).
reason: one or two short sentences naming the specifics you relied on."""


def judge(cards: list[Card]) -> Verdict:
    """Ask the configured model. Sends names, facts, and the sample messages shown on screen."""
    user = "Records:\n\n" + render(cards) + "\n\nAre these the same person?"
    schema = Verdict.model_json_schema()
    for attempt in range(2):
        output = llm.complete(JUDGE_SYSTEM, user, schema=schema, name="verdict")
        try:
            return Verdict.model_validate_json(output)
        except ValidationError:
            if attempt:
                raise llm.LLMError("The model's verdict wasn't valid JSON.") from None
            user += "\n\nAnswer with only the JSON object."
    raise AssertionError("unreachable")
