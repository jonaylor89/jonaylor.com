"""Instagram import, read from a "Download your information" export in JSON or HTML.

DMs live under your_instagram_activity/messages/inbox/<thread>/message_N.json.
Threads name people only by display name, so that's what identifies them here.
Instagram writes text as UTF-8 bytes escaped as Latin-1 ("Ã©" for "é"), which
is undone on the way in.
"""

from __future__ import annotations

import datetime as dt
from collections import Counter
import hashlib
import json
import re
import sqlite3
from pathlib import Path

from .. import identity
from .common import add_interaction

# Notices Instagram writes into threads, which aren't conversation.
NOTICE = re.compile(
    r"(sent an attachment\.|^Liked a message|liked a message$|^Reacted .* to your message\s*$|shared a story\.$"
    r"|started a video chat$|started an audio call$|chat ended$|left the group\.$|named the group|"
    r"added .+ to the group|removed .+ from the group|changed the group photo|joined the video chat"
    r"|^Messages and calls are)",
)
DELETED = "Instagram User"


def fix(text: str | None) -> str | None:
    if not text:
        return text
    try:
        return text.encode("latin-1").decode("utf-8")
    except (UnicodeEncodeError, UnicodeDecodeError):
        return text


def _handle(name: str) -> tuple[str, str]:
    return ("instagram", " ".join(name.lower().split()))


def _own_name(root: Path) -> str | None:
    path = root / "personal_information" / "personal_information" / "personal_information.json"
    if not path.exists():
        from .instagram_html import own_name

        html = path.with_suffix(".html")
        return own_name(html) if html.exists() else None
    data = json.loads(path.read_text())["profile_user"][0]["string_map_data"]
    return fix(data.get("Name", {}).get("value"))


def _threads(root: Path, me: str | None = None) -> list[tuple[str, list[dict], list[dict]]]:
    """(thread id, participants, messages) for each inbox thread, merging message_N.json files."""
    inbox = root / "your_instagram_activity" / "messages" / "inbox"
    out = []
    for folder in sorted(p for p in inbox.iterdir() if p.is_dir()):
        participants, messages = [], []
        for f in sorted(folder.glob("message_*.json")):
            data = json.loads(f.read_text())
            participants = participants or data.get("participants", [])
            messages += data.get("messages", [])
        if not list(folder.glob("message_*.json")):
            from .instagram_html import thread

            occurrences = Counter()
            for f in sorted(folder.glob("message_*.html")):
                parts, msgs = thread(f, me)
                participants = list({p["name"]: p for p in participants + parts}.values())
                for m in msgs:
                    key = (m["timestamp_ms"], m["sender_name"], m["content"])
                    occurrences[key] += 1
                    m["html_occurrence"] = occurrences[key]
                messages += msgs
        out.append((folder.name.rsplit("_", 1)[-1], participants, messages))
    return out


def import_instagram(conn: sqlite3.Connection, root: Path, since: dt.date | None = None) -> dict[str, int]:
    me = _own_name(root)
    if not me:
        raise ValueError("Instagram export has no account name; include Personal information in the export.")
    threads = _threads(root, me)
    user = identity.me(conn)
    if me and user:
        identity.add_identifier(conn, user["id"], *_handle(me), "instagram")
    # A real relationship: someone you've written to one-on-one.
    written_to = {
        _handle(fix(p["name"]))
        for _, parts, msgs in threads
        if len(parts) == 2 and any(fix(m["sender_name"]) == me for m in msgs)
        for p in parts
        if fix(p["name"]) not in (me, DELETED)
    }
    cutoff = since.isoformat() if since else ""
    people: dict[tuple[str, str], int | None] = {}

    def person_for(name: str) -> int | None:
        handle = _handle(name)
        if handle not in people:
            person_id = identity.find_by_identifier(conn, *handle)
            if person_id is None and handle in written_to:
                # Display names are mostly real names here; still, only trust a full name for matching.
                person_id = identity.resolve(conn, [handle], name, "instagram", match_name=len(name.split()) >= 2)
            elif person_id and conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
                person_id = None
            people[handle] = person_id
        return people[handle]

    stats = {"threads": len(threads), "messages": 0, "interactions": 0, "skipped": 0}
    for thread_id, parts, msgs in threads:
        group = len(parts) > 2
        names = [fix(p["name"]) for p in parts]
        other = next((n for n in names if n != me), None)
        for m in msgs:
            stats["messages"] += 1
            sender = fix(m["sender_name"])
            text = (fix(m.get("content")) or "").strip() or None
            when = dt.datetime.fromtimestamp(m["timestamp_ms"] / 1000).isoformat(sep=" ", timespec="seconds")
            if (text and NOTICE.search(text)) or when < cutoff or sender == DELETED or (group and sender == me):
                stats["skipped"] += 1  # notices, deleted accounts, and your own group messages
                continue
            counterpart = sender if group else other
            person_id = counterpart and counterpart != DELETED and person_for(counterpart)
            digest = hashlib.sha1((text or "").encode()).hexdigest()[:8]
            ref = f"instagram:{thread_id}:{m['timestamp_ms']}:{sender}:{digest}"
            if "html_occurrence" in m:
                ref += f":html:{m['html_occurrence']}"
            if person_id and add_interaction(
                conn, person_id, when, "instagram", "out" if sender == me else "in", text, "group chat" if group else None, ref
            ):
                stats["interactions"] += 1
            else:
                stats["skipped"] += 1
    conn.commit()
    return stats
