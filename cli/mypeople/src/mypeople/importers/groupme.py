"""GroupMe's unzipped account export (profile/ and conversation folders).

Display names are not identity evidence. Only people you've directly written to
become new people; groups contribute incoming messages from already linked IDs.
"""

from __future__ import annotations

import datetime as dt
import json
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

from .. import identity, photos
from .common import add_interaction


class GroupMeError(ValueError):
    pass


def _id(value) -> str:
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return ""
    value = str(value)
    return value if value.isascii() and value.isdigit() and int(value) > 0 else ""


def _json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, UnicodeError):
        raise GroupMeError(f"Couldn't read GroupMe JSON at {path}.") from None


def _when(message: dict) -> str:
    timestamp = message.get("created_at")
    if isinstance(timestamp, bool) or not isinstance(timestamp, (int, float)) or timestamp <= 0:
        raise ValueError("invalid created_at")
    return dt.datetime.fromtimestamp(timestamp).astimezone().replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")


def _message(message: dict) -> bool:
    if message.get("sender_type") != "user" or message.get("system") or message.get("hidden"):
        return False
    if not _id(message.get("id")) or not _id(message.get("sender_id")):
        return False
    try:
        _when(message)
    except (ValueError, OverflowError, OSError):
        return False
    return True


def _load(root: Path) -> tuple[str, list[tuple[str, str, str, list[dict]]]]:
    profile = _json(root / "profile" / "profile.json")
    account = _id(profile.get("id")) if isinstance(profile, dict) else ""
    if not account:
        raise GroupMeError("GroupMe export is missing profile.id; pass the full unzipped account export folder.")
    conversations = []
    for path in sorted(root.glob("*/conversation.json")):
        data = _json(path)
        messages = _json(path.with_name("message.json"))
        if not isinstance(data, dict) or not isinstance(messages, list) or any(not isinstance(m, dict) for m in messages):
            raise GroupMeError(f"Invalid GroupMe conversation or message list in {path.parent}.")
        if "chat" in data:
            chat = data["chat"]
            other = chat.get("other_user") if isinstance(chat, dict) else None
            uid = _id(other.get("id")) if isinstance(other, dict) else ""
            name = other.get("name") if isinstance(other, dict) else ""
            kind = "direct"
        else:
            uid, name, kind = _id(data.get("group_id") or data.get("id")), data.get("name"), "group"
        if not uid or (name is not None and not isinstance(name, str)):
            raise GroupMeError(f"GroupMe conversation is missing a valid ID or name at {path}.")
        conversations.append((kind, uid, (name or "").strip(), messages))
    if not conversations:
        raise GroupMeError("No GroupMe conversations found; pass the folder containing profile/ and the conversation folders.")
    return account, conversations


_MAX_PHOTO_BYTES = 5 * 1024 * 1024


def _photo_url(value) -> bool:
    if not isinstance(value, str):
        return False
    try:
        url = urllib.parse.urlsplit(value)
        return (url.scheme == "https" and url.hostname == "i.groupme.com" and url.port in (None, 443)
                and not url.username and not url.password)
    except ValueError:
        return False


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None  # export URLs must never redirect downloads to arbitrary hosts


def _fetch_photo(url: str) -> bytes:
    if not _photo_url(url):
        raise ValueError("Unsupported GroupMe photo URL")
    opener = urllib.request.build_opener(_NoRedirect())
    with opener.open(url, timeout=15) as response:
        data = response.read(_MAX_PHOTO_BYTES + 1)
    if len(data) > _MAX_PHOTO_BYTES:
        raise ValueError("GroupMe photo exceeds size limit")
    return data


def _collect_photos(conn: sqlite3.Connection, root: Path, account: str, fetch) -> dict[str, int]:
    candidates: dict[str, list[str]] = {}

    def add(uid, url):
        uid = _id(uid)
        if uid and uid != account and _photo_url(url):
            urls = candidates.setdefault(uid, [])
            if url not in urls:
                urls.append(url)

    # Current DM avatars take precedence over group nicknames and historical message avatars.
    records = [_json(path) for path in sorted(root.glob("*/conversation.json"))]
    for data in records:
        if "chat" in data:
            other = data["chat"]["other_user"]
            add(other.get("id"), other.get("avatar_url"))
    for data in records:
        members = data.get("members", [])
        if isinstance(members, list):
            for member in members:
                if isinstance(member, dict):
                    add(member.get("user_id"), member.get("image_url"))
    stats = {"photos_saved": 0, "photos_failed": 0}
    for uid, urls in candidates.items():
        person = identity.find_by_identifier(conn, "groupme", uid)
        row = conn.execute("SELECT is_me, trashed FROM people WHERE id=?", (person,)).fetchone() if person else None
        if not row or row["is_me"] or row["trashed"]:
            continue
        for url in urls:
            try:
                data = fetch(url)
                if len(data) > _MAX_PHOTO_BYTES or not photos.image_width(data):
                    raise ValueError("Invalid GroupMe photo")
                stats["photos_saved"] += photos.save(conn, person, "groupme", data, source_identity=uid)
                break
            except (OSError, ValueError, urllib.error.URLError):
                continue  # expired URLs must not undo the message import; try the next avatar
        else:
            stats["photos_failed"] += 1
    return stats


def import_groupme(
    conn: sqlite3.Connection, root: Path, since: dt.date | None = None, *,
    with_photos: bool = False, fetch=_fetch_photo,
) -> dict[str, int]:
    # Validate all files before writing anything. Never read credentials.
    account, conversations = _load(root)
    if user := identity.me(conn):
        identity.add_identifier(conn, user["id"], "groupme", account, "groupme")
    stats = {"conversations": 0, "messages": 0, "interactions": 0, "skipped": 0}
    people = set()
    # Resolve DMs first so folder order cannot affect the group history imported.
    for kind, uid, name, messages in conversations:
        if kind != "direct" or uid == account:
            continue
        person = identity.find_by_identifier(conn, "groupme", uid)
        written = any(_message(m) and str(m["sender_id"]) == account
                      and str(m.get("recipient_id")) == uid for m in messages)
        if person is None and written:
            person = identity.create_person(conn, name or f"GroupMe user {uid}")
            identity.add_identifier(conn, person, "groupme", uid, "groupme")

    cutoff = since.isoformat() if since else ""
    for kind, uid, name, messages in conversations:
        if kind == "direct" and uid == account:
            continue
        stats["conversations"] += 1
        for message in messages:
            stats["messages"] += 1
            if not _message(message):
                stats["skipped"] += 1
                continue
            sender = str(message["sender_id"])
            outgoing = sender == account
            counterpart = sender if kind == "group" else uid
            person = identity.find_by_identifier(conn, "groupme", counterpart)
            row = conn.execute("SELECT is_me, trashed FROM people WHERE id=?", (person,)).fetchone() if person else None
            when = _when(message)
            valid_direct = (sender == account and str(message.get("recipient_id")) == uid) or (
                sender == uid and str(message.get("recipient_id")) == account
            )
            if (not row or row["is_me"] or row["trashed"] or when < cutoff
                    or (kind == "group" and outgoing) or (kind == "direct" and not valid_direct)):
                stats["skipped"] += 1
                continue
            body = message.get("text")
            text = body.strip() or None if isinstance(body, str) else None
            # Never depend on folder names, source_guid, names, or text for deduplication.
            ref = f"groupme:{account}:{kind}:{uid}:{message['id']}"
            if add_interaction(conn, person, when, "groupme", "out" if outgoing else "in", text,
                               "group chat" if kind == "group" else None, ref):
                stats["interactions"] += 1
            else:
                stats["skipped"] += 1
            people.add(person)
    conn.commit()
    if with_photos:
        stats.update(_collect_photos(conn, root, account, fetch))
        conn.commit()
    stats["people"] = len(people)
    return stats
