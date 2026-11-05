"""LLM event extraction: message history in, dated events about one person out."""

from __future__ import annotations

import datetime as dt
from dataclasses import dataclass, replace
import sqlite3
from typing import Callable, Literal

from pydantic import BaseModel, ValidationError

from . import identity, llm
from .events import EVENT_TYPES, NOTE, add_event, add_note, events_for, format_date

CONTEXT_MESSAGES = 20
MAX_MESSAGE_CHARS = 1500
MIN_CONFIDENCE = 0.5


class ExtractedEvent(BaseModel):
    type: Literal[EVENT_TYPES]  # type: ignore[valid-type]
    summary: str
    date: str | None
    confidence: float
    evidence: str


class Extraction(BaseModel):
    events: list[ExtractedEvent]


# (system, user) -> Extraction. Swappable so tests don't need the API.
Model = Callable[[str, str], Extraction]


@dataclass(frozen=True)
class ExtractionPlan:
    person_id: int
    name: str
    messages: int
    batches: int
    work: int  # formatted input characters, with a floor for small-call overhead


@dataclass(frozen=True)
class ExtractionUpdate:
    plan: ExtractionPlan
    phase: Literal["start", "batch_start", "saving", "batch_done", "skipped", "done"]
    batch: int = 0
    messages_done: int = 0
    batches_done: int = 0
    work_done: int = 0
    events: int = 0
    skipped: int = 0  # messages read by another worker, not this model
    batch_messages: int = 0
    batch_work: int = 0
    first_at: str = ""
    last_at: str = ""


ProgressCallback = Callable[[ExtractionUpdate], None]


def default_model() -> Model:
    def call(system: str, user: str) -> Extraction:
        schema = Extraction.model_json_schema()
        for attempt in range(2):
            output = llm.complete(system, user, schema=schema, name="extraction")
            try:
                return Extraction.model_validate_json(output)
            except ValidationError as e:
                if attempt:
                    raise llm.LLMError(f"Model returned malformed events: {e}") from None
                # Local models without constrained decoding occasionally slip; show them what went wrong once.
                user = f"{user}\n\nYour previous answer was not valid for the schema ({e.error_count()} errors). Answer again with only the JSON object."
        raise AssertionError("unreachable")

    return call


SYSTEM = """You maintain a private memory of the people in one user's life, so they can show up for them at the right moments.

You will read the user's own conversations with one person and record durable facts about that person as dated events. Event types:
- birthday: their birthday
- job: new job, promotion, role change, leaving a job, starting a company
- education: starting or finishing school, a degree, a program
- move: moving, or where they live now
- engagement, wedding: theirs
- birth: a child born to them (or expected, with the due date)
- loss: a death of someone close to them, a pet, or another serious loss
- health: an illness, surgery, injury, or recovery
- trip: travel, with dates if known
- achievement: a race, launch, award, publication, milestone
- plan: something upcoming on their calendar (an event, an interview, a big day)
- interest: something they want, love, or want to learn; useful for gifts
- family: facts about their partner, kids, parents (names, ages, milestones)
- promise: something the user promised them or an open thread the user should follow up on
- other: anything else genuinely worth remembering

Rules:
- Only record what the conversation actually says. Never guess.
- Summaries are short third-person facts about the person, e.g. "Started as product designer at Figma", "Daughter Maya starts kindergarten", "Wants to learn to make fresh pasta". For promises, phrase from the user's side, e.g. "You said you'd send him the book recommendation".
- date is when the event happens or happened, not when it was mentioned. Resolve relative dates ("next Sunday", "last week") against the message timestamps. Use YYYY-MM-DD, YYYY-MM, or YYYY; null if unknown.
- confidence is 0 to 1: how sure you are the fact is true and correctly dated.
- evidence is a short verbatim quote from the conversation.
- Skip logistics, small talk, jokes, hypotheticals, and anything already in the known list. Skip facts about the user unless they are a promise.
- Most chunks contain nothing worth recording. An empty list is a good answer."""


def _format_messages(rows: list[sqlite3.Row], name: str) -> list[str]:
    lines = []
    for r in rows:
        who = "Me" if r["direction"] == "out" else name
        where = f" ({r['thread']})" if r["thread"] == "group chat" else ""
        text = r["text"]
        if len(text) > MAX_MESSAGE_CHARS:
            text = text[:MAX_MESSAGE_CHARS] + " […]"  # long emails: life news is near the top
        lines.append(f"[{r['at'][:16]} {r['channel']}{where}] {who}: {text}")
    return lines


def _chunks(rows: list[sqlite3.Row], name: str, limit: int | None = None) -> list[list[sqlite3.Row]]:
    """Split messages into model-sized batches, keeping each message whole."""
    limit = limit or llm.backend().chunk_chars
    chunks: list[list[sqlite3.Row]] = [[]]
    size = 0
    for row, line in zip(rows, _format_messages(rows, name)):
        if size + len(line) > limit and chunks[-1]:
            chunks.append([])
            size = 0
        chunks[-1].append(row)
        size += len(line)
    return [c for c in chunks if c]


def _batch_work(rows: list[sqlite3.Row], name: str, limit: int) -> int:
    # Short batches still pay request/context overhead. ETA is work-weighted,
    # rather than assuming a two-word text costs as much as a long email.
    return max(limit // 4, sum(map(len, _format_messages(rows, name))))


def _plan(person_id: int, name: str, chunks: list[list[sqlite3.Row]], limit: int) -> ExtractionPlan:
    return ExtractionPlan(person_id, name, sum(map(len, chunks)), len(chunks),
                          sum(_batch_work(chunk, name, limit) for chunk in chunks))


def plan_person(conn: sqlite3.Connection, person_id: int, since: dt.date | None = None) -> ExtractionPlan:
    """Read-only estimate using the same batching/truncation as extraction."""
    name = conn.execute("SELECT name FROM people WHERE id=?", (person_id,)).fetchone()["name"]
    rows = conn.execute(
        "SELECT * FROM interactions WHERE person_id=? AND extracted=0 AND text IS NOT NULL AND at>=? ORDER BY at",
        (person_id, since.isoformat() if since else ""),
    ).fetchall()
    limit = llm.backend().chunk_chars
    return _plan(person_id, name, _chunks(rows, name, limit), limit)


def _known(conn: sqlite3.Connection, person_id: int) -> str:
    # Not notes: as "known" facts they'd tell the model there's nothing to find in them.
    rows = [r for r in events_for(conn, person_id) if r["type"] != NOTE]
    if not rows:
        return "(nothing yet)"
    return "\n".join(f"- {r['type']}: {r['value']} ({format_date(r['date'])})" for r in rows)


def _names(conn: sqlite3.Connection, person_id: int) -> str:
    """'Name' or 'Name (also called A, B)'."""
    name = conn.execute("SELECT name FROM people WHERE id = ?", (person_id,)).fetchone()["name"]
    others = identity.aliases(conn, person_id)
    return f"{name} (also called {', '.join(others)})" if others else name


def _who(conn: sqlite3.Connection, person_id: int) -> str:
    user = identity.me(conn)
    line = f"The person is {_names(conn, person_id)}."
    if user:
        line += f' The user, shown as "Me", is {_names(conn, user["id"])}.'
    return line


def _prompt(who: str, name: str, known: str, context: list[str], new: list[str], today: dt.date) -> str:
    parts = [f"Today is {today.isoformat()}. {who}", f"<known_events>\n{known}\n</known_events>"]
    if context:
        parts.append("<earlier_messages note=\"already processed, for context only\">\n" + "\n".join(context) + "\n</earlier_messages>")
    parts.append("<messages>\n" + "\n".join(new) + "\n</messages>")
    parts.append(f"Record new events about {name} from <messages>.")
    return "\n\n".join(parts)


def _store(
    conn: sqlite3.Connection, person_id: int, result: Extraction, source: str, source_ref: str | None, rows=()
) -> int:
    from .db import evidence_time

    added = 0
    for e in result.events:
        if e.confidence < MIN_CONFIDENCE:
            continue
        # When it was said: the quoted message's time, else the end of the batch it came from.
        said_at = evidence_time(rows, e.evidence) or (rows[-1]["at"] if rows else None)
        if add_event(conn, person_id, e.type, e.summary, e.date, e.confidence, source, source_ref, e.evidence, said_at):
            added += 1
    return added


def extract_person(
    conn: sqlite3.Connection, model: Model, person_id: int, since: dt.date | None = None, today: dt.date | None = None,
    *, progress: ProgressCallback | None = None,
) -> int:
    """Extract unread messages; report completed batches only after committing them."""
    today = today or dt.date.today()
    name = conn.execute("SELECT name FROM people WHERE id = ?", (person_id,)).fetchone()["name"]
    new = conn.execute(
        "SELECT * FROM interactions WHERE person_id = ? AND extracted = 0 AND text IS NOT NULL AND at >= ? ORDER BY at",
        (person_id, since.isoformat() if since else ""),
    ).fetchall()
    limit = llm.backend().chunk_chars
    chunks = _chunks(new, name, limit)
    state = ExtractionUpdate(_plan(person_id, name, chunks, limit), "start")

    def notify(phase, **changes):
        nonlocal state
        state = replace(state, phase=phase, **changes)
        if progress:
            progress(state)

    notify("start")
    if not new:
        notify("done")
        return 0
    context = conn.execute(
        "SELECT * FROM (SELECT * FROM interactions WHERE person_id = ? AND extracted = 1 AND text IS NOT NULL "
        "AND at <= ? ORDER BY at DESC LIMIT ?) ORDER BY at",
        (person_id, new[0]["at"], CONTEXT_MESSAGES),
    ).fetchall()

    added = 0
    for number, original in enumerate(chunks, 1):
        chunk = original
        work = _batch_work(original, name, limit)
        # Another run working from the other end may have read these already.
        ids = [r["id"] for r in chunk]
        done = {r["id"] for r in conn.execute(
            f"SELECT id FROM interactions WHERE extracted = 1 AND id IN ({','.join('?' * len(ids))})", ids)}
        chunk = [r for r in chunk if r["id"] not in done]
        remaining_work = _batch_work(chunk, name, limit) if chunk else 0
        notify("skipped" if not chunk else "batch_start", batch=number,
               messages_done=state.messages_done + len(done), skipped=state.skipped + len(done),
               work_done=state.work_done + work - remaining_work,
               batches_done=number if not chunk else number - 1,
               batch_messages=len(chunk), batch_work=remaining_work,
               first_at=original[0]["at"], last_at=original[-1]["at"])
        if not chunk:
            continue
        lines = _format_messages(chunk, name)
        prompt = _prompt(_who(conn, person_id), name, _known(conn, person_id), _format_messages(context, name), lines, today)
        result = model(SYSTEM, prompt)
        notify("saving")
        added += _store(conn, person_id, result, chunk[0]["channel"], None, chunk)
        # Mark each batch as read as soon as it's stored, so an interrupted run resumes here.
        conn.executemany("UPDATE interactions SET extracted = 1 WHERE id = ?", [(r["id"],) for r in chunk])
        conn.commit()
        notify("batch_done", messages_done=state.messages_done + len(chunk), batches_done=number,
               work_done=state.work_done + remaining_work, events=added)
        context = chunk[-CONTEXT_MESSAGES:]
    notify("done")
    return added


# events.source_ref of a note whose facts have been read, or that another machine reads.
NOTE_READ = "read"


def extract_note(conn: sqlite3.Connection, model: Model, person_id: int, note: str, today: dt.date | None = None) -> int:
    """Quick capture: keep what the user wrote, then read it for facts. A model failure loses nothing."""
    today = today or dt.date.today()
    add_note(conn, person_id, note)
    conn.commit()
    name = conn.execute("SELECT name FROM people WHERE id = ?", (person_id,)).fetchone()["name"]
    line = f"[{today.isoformat()} note] Me (a note to myself about {name}): {note}"
    result = model(SYSTEM, _prompt(_who(conn, person_id), name, _known(conn, person_id), [], [line], today))
    added = _store(conn, person_id, result, "note", today.isoformat())
    conn.execute("UPDATE events SET source_ref = ? WHERE person_id = ? AND type = ? AND value = ?",
                 (NOTE_READ, person_id, NOTE, note.strip()))
    conn.commit()
    return added


def pending_notes(conn: sqlite3.Connection, person_id: int | None = None) -> list[sqlite3.Row]:
    """Notes written in the apps, or saved while the model was unavailable, that haven't been read yet."""
    only, args = (" AND e.person_id = ?", (person_id,)) if person_id is not None else ("", ())
    return conn.execute(
        "SELECT e.person_id, e.value, p.name FROM events e JOIN people p ON p.id = e.person_id "
        f"WHERE e.type = ? AND e.status = 'active' AND e.source_ref IS NULL AND p.merged_into IS NULL{only} ORDER BY e.id",
        (NOTE, *args),
    ).fetchall()


def pending_people(conn: sqlite3.Connection, since: dt.date | None = None) -> list[sqlite3.Row]:
    """People with unread messages, closest first, so a long run does the most valuable people early."""
    from .relationships import infer

    rows = conn.execute(
        "SELECT p.id, p.name, COUNT(*) AS pending FROM interactions i JOIN people p ON p.id = i.person_id "
        "WHERE p.merged_into IS NULL AND p.is_me = 0 AND i.extracted = 0 AND i.text IS NOT NULL AND i.at >= ? "
        "GROUP BY p.id",
        (since.isoformat() if since else "",),
    ).fetchall()
    return sorted(rows, key=lambda r: (-infer(conn, r["id"]).closeness, -r["pending"]))
