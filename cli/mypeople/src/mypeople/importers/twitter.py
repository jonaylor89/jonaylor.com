"""X (Twitter) import, read from "Download an archive of your data" (Settings > Your account).

data/direct-messages.js and direct-messages-group.js hold DMs, but name people only by
account id. Handles and display names come from your own tweets, since every mention and
reply names the account. A names file fills the gaps: one account per line, as
"ID @handle Display Name" (the handle or the name may be left out).

Someone you wrote to one-on-one becomes a person once they have a name. The rest can be
named one by one with `mypeople import twitter PATH --review`, which shows each conversation.
People are matched by X account, by a confirmed x.com profile, or by a full display name
only one person has.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .. import identity
from .common import add_interaction

_PLAIN_NAME = re.compile(r"[^\W\d_][\w .'’-]*")
_TWEET_AUTHOR = re.compile(r"(?:twitter|x)\.com/(\w{1,15})/status", re.I)


def load(root: Path, name: str) -> list:
    """Archive files are JavaScript: `window.YTD.<name>.part0 = [...]`."""
    path = root / "data" / name
    if not path.exists():
        return []
    text = path.read_text(encoding="utf-8")
    return json.loads(text[text.index("["):])


def directory(root: Path) -> dict[str, tuple[str | None, str | None]]:
    """Account id -> (handle, display name), from the accounts your tweets mention or reply to."""
    found: dict[str, tuple[str | None, str | None]] = {}
    for file in ("tweets.js", "deleted-tweets.js"):
        for item in load(root, file):
            tweet = item.get("tweet") or {}
            for m in tweet.get("entities", {}).get("user_mentions", []):
                found[m["id_str"]] = (m.get("screen_name"), m.get("name"))
            reply_to, handle = tweet.get("in_reply_to_user_id_str"), tweet.get("in_reply_to_screen_name")
            if reply_to and handle and reply_to not in found:
                found[reply_to] = (handle, None)
    return found


def read_names(path: Path) -> dict[str, tuple[str | None, str | None]]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split("#", 1)[0].split()
        if not parts or not parts[0].isdigit():
            continue
        handle = parts[1].removeprefix("@") if len(parts) > 1 and parts[1].startswith("@") else None
        name = " ".join(parts[2 if handle else 1:]) or None
        out[parts[0]] = (handle, name)
    return out


def _when(raw: str) -> str:
    """'2022-08-27T05:50:37.804Z' -> local time, like the other importers."""
    utc = dt.datetime.fromisoformat(raw.replace("Z", "+00:00"))
    return utc.astimezone().replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")


def _text(m: dict) -> str | None:
    text = m.get("text") or ""
    for u in m.get("urls", []):
        if u.get("url") and u.get("expanded"):
            text = text.replace(u["url"], u["expanded"])
    return text.strip() or None


def _messages(conversation: dict) -> list[dict]:
    return [m["messageCreate"] for m in conversation["messages"] if "messageCreate" in m]


def _add_profile(conn: sqlite3.Connection, person_id: int, handle: str, title: str) -> None:
    conn.execute(
        "INSERT INTO profiles (person_id, site, url, title, confidence, reason, status) "
        "VALUES (?, 'x', ?, ?, 1.0, 'X DM conversation', 'confirmed') ON CONFLICT (person_id, url) DO NOTHING",
        (person_id, f"https://x.com/{handle.lower()}", title),
    )


def _by_profile(conn: sqlite3.Connection, handle: str) -> int | None:
    row = conn.execute(
        "SELECT person_id FROM profiles WHERE status = 'confirmed' AND site = 'x' AND lower(url) = ?",
        (f"https://x.com/{handle.lower()}",),
    ).fetchone()
    return identity.canonical(conn, row["person_id"]) if row else None


def import_twitter(
    conn: sqlite3.Connection, root: Path, since: dt.date | None = None, names: Path | None = None
) -> dict[str, int]:
    account = load(root, "account.js")[0]["account"]
    me_id = account["accountId"]
    if user := identity.me(conn):
        identity.add_identifier(conn, user["id"], "x", me_id, "twitter")
    known = directory(root)
    if names:
        known.update(read_names(names))

    one_to_one = [c["dmConversation"] for c in load(root, "direct-messages.js")]
    groups = [c["dmConversation"] for c in load(root, "direct-messages-group.js")]

    def other(conversation: dict) -> str | None:
        return next((i for i in conversation["conversationId"].split("-") if i != me_id), None)

    # A real relationship: someone you've written to one-on-one.
    written_to = {other(c) for c in one_to_one if any(m["senderId"] == me_id for m in _messages(c))}
    people: dict[str, int | None] = {}
    unnamed: dict[str, int] = {}

    def person_for(account_id: str, create: bool) -> int | None:
        if account_id in people:
            return people[account_id]
        handle, name = known.get(account_id, (None, None))
        person_id = identity.find_by_identifier(conn, "x", account_id)
        if person_id is None and handle:
            person_id = _by_profile(conn, handle)
        if person_id is None and create and account_id in written_to:
            label = name or (f"@{handle}" if handle else None)
            if label is None:
                unnamed[account_id] = 0
            else:
                full = bool(name) and len(name.split()) >= 2 and bool(_PLAIN_NAME.fullmatch(name))
                person_id = identity.resolve(conn, [("x", account_id)], label, "twitter", match_name=full)
        if person_id and conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
            person_id = None
        if person_id:
            identity.add_identifier(conn, person_id, "x", account_id, "twitter")
            if handle:
                _add_profile(conn, person_id, handle, name or handle)
        people[account_id] = person_id
        return person_id

    cutoff = since.isoformat() if since else ""
    stats = {"conversations": len(one_to_one) + len(groups), "messages": 0, "interactions": 0, "skipped": 0}
    for conversation, group in [(c, False) for c in one_to_one] + [(c, True) for c in groups]:
        for m in _messages(conversation):
            stats["messages"] += 1
            when, outgoing = _when(m["createdAt"]), m["senderId"] == me_id
            if when < cutoff or (group and outgoing):
                stats["skipped"] += 1  # your own group messages aren't with anyone in particular
                continue
            counterpart = m["senderId"] if group else other(conversation)
            person_id = counterpart and person_for(counterpart, create=not group)
            if counterpart in unnamed:
                unnamed[counterpart] += 1
            ref = f"x:{m['id']}" + (f":{counterpart}" if group else "")
            if person_id and add_interaction(
                conn, person_id, when, "x", "out" if outgoing else "in", _text(m), "group chat" if group else None, ref
            ):
                stats["interactions"] += 1
            else:
                stats["skipped"] += 1
    conn.commit()
    stats["people"] = sum(1 for p in set(people.values()) if p)
    stats["unnamed"] = len(unnamed)
    stats["unnamed_accounts"] = sorted(unnamed.items(), key=lambda kv: -kv[1])  # type: ignore[assignment]
    return stats


# --- naming the accounts the archive doesn't -----------------------------------------------


@dataclass
class Unnamed:
    account_id: str
    messages: list[tuple[str, bool, str]]  # (local time, from you, text), oldest first
    tweets_shared: list[str] = field(default_factory=list)  # authors of tweets they sent you, most shared first

    @property
    def link(self) -> str:
        return f"https://x.com/i/user/{self.account_id}"


def unnamed(conn: sqlite3.Connection, root: Path) -> list[Unnamed]:
    """People you wrote to one-on-one whom MyPeople can't name or match yet, most messages first."""
    me_id = load(root, "account.js")[0]["account"]["accountId"]
    known = directory(root)
    out = []
    for c in (c["dmConversation"] for c in load(root, "direct-messages.js")):
        msgs = _messages(c)
        account_id = next((i for i in c["conversationId"].split("-") if i != me_id), None)
        if (not account_id or account_id in known or not any(m["senderId"] == me_id for m in msgs)
                or identity.find_by_identifier(conn, "x", account_id)):
            continue
        authors: dict[str, int] = {}
        for m in msgs:
            if m["senderId"] != me_id:
                for u in m.get("urls", []):
                    if (hit := _TWEET_AUTHOR.search(u.get("expanded") or "")) and hit.group(1).lower() not in ("i", "intent"):
                        authors[hit.group(1)] = authors.get(hit.group(1), 0) + 1
        lines = sorted((_when(m["createdAt"]), m["senderId"] == me_id, _text(m) or "(attachment)") for m in msgs)
        out.append(Unnamed(account_id, lines, sorted(authors, key=lambda a: -authors[a])))
    return sorted(out, key=lambda u: -len(u.messages))


def name_account(conn: sqlite3.Connection, account_id: str, name: str | None = None, handle: str | None = None,
                 person_id: int | None = None) -> int:
    """Tie an X account to an existing person, or to a new one called name (or @handle)."""
    if person_id is None:
        if handle:
            person_id = _by_profile(conn, handle)
        if person_id is None:
            person_id = identity.create_person(conn, name or f"@{handle}")
    identity.add_identifier(conn, person_id, "x", account_id, "twitter")
    if handle:
        _add_profile(conn, person_id, handle, name or handle)
    conn.commit()
    return person_id
