"""Snapchat import, read from a "My Data" export (Settings > My Data, with JSON selected).

The export's json/ folder has chat_history.json and snap_history.json, keyed by
the other person's username (or a UUID for group chats), and friends.json, which
maps usernames to display names. Media and snaps have no text but still count as
contact.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from pathlib import Path

from .. import identity
from .common import add_interaction

# Notices about saving or erasing messages aren't conversation.
SKIP_TYPES = {"STATUSERASEDMESSAGE", "STATUSSAVETOCAMERAROLL"}


def _json_dir(root: Path) -> Path:
    return root / "json" if (root / "json").is_dir() else root


def _when(created: str) -> str:
    """'2026-10-19 02:38:21 UTC' -> local time, like the other importers."""
    utc = dt.datetime.strptime(created.removesuffix(" UTC"), "%Y-%m-%d %H:%M:%S").replace(tzinfo=dt.timezone.utc)
    return utc.astimezone().replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")


def _is_group(key: str, messages: list[dict]) -> bool:
    return any(m.get("Conversation Title") for m in messages)


def _handle(username: str) -> tuple[str, str]:
    return ("snapchat", username.strip().lower())


def import_snapchat(conn: sqlite3.Connection, root: Path, since: dt.date | None = None) -> dict[str, int]:
    folder = _json_dir(root)
    load = lambda name: json.loads((folder / name).read_text()) if (folder / name).exists() else {}
    chats, snaps, friends = load("chat_history.json"), load("snap_history.json"), load("friends.json")
    account = load("account.json").get("Basic Information", {})

    # Your own username belongs to you, so it's never mistaken for someone else.
    me_username = (account.get("Username") or "").lower()
    if me_username and (user := identity.me(conn)):
        identity.add_identifier(conn, user["id"], *_handle(me_username), "snapchat")

    names = {
        f["Username"].lower(): f["Display Name"].strip()
        for group in ("Friends", "Deleted Friends")
        for f in friends.get(group, [])
        if f.get("Display Name", "").strip()
    }
    # A real relationship: someone you've messaged one-on-one.
    written_to = {key.lower() for key, msgs in chats.items() if not _is_group(key, msgs) and any(m["IsSender"] for m in msgs)}
    cutoff = since.isoformat() if since else ""
    people: dict[str, int | None] = {}

    def person_for(username: str) -> int | None:
        username = username.lower()
        if username not in people:
            handle = _handle(username)
            person_id = identity.find_by_identifier(conn, *handle)
            if person_id is None and username in written_to:
                name = names.get(username)
                # Display names are self-chosen, so only trust a full name that matches one person exactly.
                person_id = identity.resolve(
                    conn, [handle], name or username, "snapchat", match_name=bool(name and len(name.split()) >= 2)
                )
            elif person_id and conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
                person_id = None
            people[username] = person_id
        return people[username]

    stats = {"messages": 0, "snaps": 0, "interactions": 0, "skipped": 0}
    for kind, history in (("messages", chats), ("snaps", snaps)):
        for key, messages in history.items():
            group = _is_group(key, messages)
            for m in messages:
                stats[kind] += 1
                when = _when(m["Created"])
                if m["Media Type"] in SKIP_TYPES or when < cutoff or (group and m["IsSender"]):
                    stats["skipped"] += 1  # your own group messages aren't with anyone in particular
                    continue
                person_id = person_for(key if not group else m["From"])
                text = (m.get("Content") or "").strip() or None
                digest = hashlib.sha1((text or m["Media Type"]).encode()).hexdigest()[:8]
                ref = f"snapchat:{key}:{m['Created(microseconds)']}:{m['From']}:{digest}"
                thread = "group chat" if group else None
                if person_id and add_interaction(
                    conn, person_id, when, "snapchat", "out" if m["IsSender"] else "in", text, thread, ref
                ):
                    stats["interactions"] += 1
                else:
                    stats["skipped"] += 1
    from ..snapchat_links import backfill
    backfill(conn)
    conn.commit()
    return stats
