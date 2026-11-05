"""Natural-language questions over everything MyPeople knows."""

from __future__ import annotations

import datetime as dt
import os
import re
import sqlite3

from . import identity, llm, relationships
from .events import current_profile, events_for, format_date, is_superseded

SYSTEM = """You answer questions about the people in the user's life, using only the memory provided.
Every fact in the memory carries its source; cite it briefly when it helps (e.g. "from your iMessages").
If the memory doesn't contain the answer, say so plainly instead of guessing. Be brief and warm."""

SEARCH_SYSTEM = """You help search a memory of facts about the people in someone's life.
Each fact is a short sentence such as "Moved to Austin with her partner" or "Roommate at VCU".
Given the user's question, reply with ONE line of comma-separated search words that would appear in
relevant facts: synonyms, related words, word stems (e.g. "roommate, lived, apartment, moved in,
housemate"), and any person or place names in the question. No other text."""

# Characters of memory per question. Local servers run smaller contexts than the hosted models.
LOCAL_CHARS, REMOTE_CHARS = 200_000, 600_000


def person_blocks(conn: sqlite3.Connection, today: dt.date) -> list[tuple[str, float]]:
    """One text block per person with something to say, with their closeness."""
    blocks = []
    for p in conn.execute("SELECT id, name FROM people WHERE merged_into IS NULL AND is_me = 0 ORDER BY name"):
        events = events_for(conn, p["id"])
        rel = relationships.infer(conn, p["id"], today)
        if not events and rel.days_since is None:
            continue
        nicknames = identity.aliases(conn, p["id"])
        also = f", also called {', '.join(nicknames)}" if nicknames else ""
        head = f"## {p['name']} (#{p['id']}{also}, {rel.category}, closeness {rel.closeness:.2f}"
        head += f", last talked {rel.days_since} days ago)" if rel.days_since is not None else ")"
        lines = [head]
        profile = current_profile(events)
        lines += [
            f"- {e['type']}: {e['value']} [{format_date(e['date'])}; source: {e['source']}"
            + ("; superseded by a newer fact]" if is_superseded(e, profile) else "]")
            for e in events
        ]
        blocks.append(("\n".join(lines), rel.closeness))
    return blocks


def memory_dump(conn: sqlite3.Connection, today: dt.date) -> str:
    return "\n\n".join(block for block, _ in person_blocks(conn, today))


def budget() -> int:
    if os.environ.get("MYPEOPLE_ASK_CHARS"):
        return int(os.environ["MYPEOPLE_ASK_CHARS"])
    return LOCAL_CHARS if llm.backend().local else REMOTE_CHARS


def search_terms(question: str) -> list[str]:
    """Words worth looking for, from the question and the model's synonyms for it."""
    reply = llm.complete(SEARCH_SYSTEM, question)
    words = re.findall(r"[^\W\d_][\w'-]{2,}", question.lower())
    terms = [t.strip().lower() for t in reply.replace("\n", ",").split(",")] + words
    stop = {"who", "what", "when", "where", "which", "have", "has", "the", "and", "with", "about", "did", "does",
            "know", "people", "person", "anyone", "someone", "that", "this", "they", "their", "from", "for", "was"}
    return sorted({t for t in terms if len(t) >= 3 and t not in stop})


def select(blocks: list[tuple[str, float]], terms: list[str], limit: int) -> list[str]:
    """The best-matching people first, then the closest, until the memory is full."""
    def hits(block: str) -> int:
        text = block.lower()
        return sum(text.count(t) for t in terms)

    ranked = sorted(blocks, key=lambda b: (-hits(b[0]), -b[1]))
    chosen, size = [], 0
    for block, _ in ranked:
        if size + len(block) > limit:
            continue
        chosen.append(block)
        size += len(block) + 2
    return chosen


def ask(conn: sqlite3.Connection, question: str, today: dt.date | None = None) -> str:
    today = today or dt.date.today()
    blocks = person_blocks(conn, today)
    limit = budget()
    memory = "\n\n".join(block for block, _ in blocks)
    note = ""
    if len(memory) > limit:
        chosen = select(blocks, search_terms(question), limit)
        memory = "\n\n".join(chosen)
        note = (f"\n(This memory is the {len(chosen)} of {len(blocks)} people most relevant to the question. "
                "If the answer isn't here, say it may be about someone not shown.)")
    user = f"Today is {today.isoformat()}.\n\n<memory>\n{memory}\n</memory>{note}\n\n{question}"
    return llm.complete(SYSTEM, user).strip()
