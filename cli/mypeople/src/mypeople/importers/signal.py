"""Import private JSONL snapshots produced by signal_export.py.

Only explicit Signal IDs / international phones link identities; names never
merge people. Group membership alone does not create people. Disappearing,
view-once, erased, and deleted messages are deliberately not retained.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path
import sqlite3
import uuid

from .. import contacts, identity
from .common import add_interaction
from .signal_export import FORMAT, VERSION


class SignalError(ValueError):
    pass


def _aci(value) -> str:
    if not isinstance(value, str):
        return ""
    try:
        return str(uuid.UUID(value.lower().removeprefix("aci:")))
    except ValueError:
        return ""  # PNIs are not account identities


def _device_value(value) -> str:
    if not isinstance(value, str):
        return ""
    head, dot, tail = value.rpartition(".")
    return head if dot and tail.isdigit() else value


def _phone(value) -> str:
    if not isinstance(value, str) or not value.strip().startswith("+"):
        return ""  # never infer a country or treat a UUID as a phone
    return contacts.phone(value)[0]


def _records(path: Path):
    try:
        with path.open(encoding="utf-8") as stream:
            for number, line in enumerate(stream, 1):
                try:
                    record = json.loads(line)
                except ValueError:
                    raise SignalError(f"Invalid Signal snapshot JSON at line {number}.") from None
                if not isinstance(record, dict):
                    raise SignalError(f"Invalid Signal snapshot record at line {number}.")
                yield record
    except (OSError, UnicodeError):
        raise SignalError(f"Couldn't read Signal snapshot at {path}.") from None


def _conversation_message(message: dict) -> bool:
    timer = message.get("expireTimer")
    return (
        message.get("type") in ("incoming", "outgoing")
        and not any(message.get(key) for key in ("isErased", "deletedForEveryone", "isViewOnce"))
        and not timer  # do not turn disappearing messages into permanent records
        and (bool(_text(message)) or bool(message.get("hasAttachments")))
    )


def _text(message: dict) -> str | None:
    value = message.get("body")
    if not isinstance(value, str):
        return None
    return value.strip() or None


def _scan(path: Path) -> tuple[str, str, dict[str, dict], set[str]]:
    records = iter(_records(path))
    header = next(records, {})
    if header.get("kind") != "header" or header.get("format") != FORMAT or header.get("version") != VERSION:
        raise SignalError("Use a MyPeople Signal JSONL snapshot made with signal_export.py, not Signal's encrypted database or backup.")
    account = _aci(_device_value(header.get("aci")))
    if not account:
        raise SignalError("Signal snapshot is missing a valid exporting account ID.")
    my_phone = _phone(_device_value(header.get("number")))
    conversations, written_to = {}, set()
    ids: set[str] = set()
    messages = 0
    ended = False
    for record in records:
        kind = record.get("kind")
        if ended:
            raise SignalError("Signal snapshot has records after its end marker.")
        if kind == "end":
            if record.get("conversations") != len(conversations) or record.get("messages") != messages:
                raise SignalError("Signal snapshot counts don't match; export it again.")
            ended = True
            continue
        data = record.get("data")
        if kind not in ("conversation", "message") or not isinstance(data, dict):
            raise SignalError("Signal snapshot contains an unsupported record.")
        key = data.get("id")
        if not isinstance(key, str) or not key:
            raise SignalError("Signal snapshot contains a record without an ID.")
        if kind == "conversation":
            if messages or key in conversations:
                raise SignalError("Signal snapshot has duplicate or out-of-order conversations.")
            conversations[key] = data
        else:
            if key in ids:
                raise SignalError("Signal snapshot contains duplicate message IDs.")
            ids.add(key)
            messages += 1
            if _conversation_message(data) and data.get("type") == "outgoing" and isinstance(data.get("conversationId"), str):
                try:
                    _when(data)
                except (ValueError, OverflowError, OSError):
                    continue
                written_to.add(data["conversationId"])
    if not ended:
        raise SignalError("Signal snapshot is incomplete (missing end marker); export it again.")
    return account, my_phone, conversations, written_to


def _service(conversation: dict) -> str:
    return _aci(conversation.get("serviceId")) or _aci(conversation.get("uuid"))


def _name(conversation: dict) -> str:
    def joined(*keys):
        return " ".join(conversation[k].strip() for k in keys if isinstance(conversation.get(k), str) and conversation[k].strip())
    return joined("systemGivenName", "systemFamilyName") or joined("name") or joined("profileName", "profileFamilyName")


def _person(conn: sqlite3.Connection, account: str, conversation: dict, written: bool, match_phone: bool) -> int | None:
    service, number = _service(conversation), _phone(conversation.get("e164"))
    local = f"{account}:{conversation['id']}"
    linked = {pid for kind, value in (("signal", service), ("signal-conversation", local))
              if value and (pid := identity.find_by_identifier(conn, kind, value))}
    if len(linked) > 1:
        return None  # conflicting explicit mappings require manual review
    person = next(iter(linked), None)
    normalized = identity.normalize_phone(number) if number else None
    if person is None and normalized and match_phone:
        person = identity.find_by_identifier(conn, "phone", normalized)
        if person and service and conn.execute(
            "SELECT 1 FROM identifiers WHERE person_id=? AND kind='signal' AND value<>?", (person, service)
        ).fetchone():
            person = None  # a recycled historical number isn't proof of a new ACI
    if person is None:
        if not written:
            return None
        person = identity.create_person(conn, _name(conversation) or number or f"Signal user {service or conversation['id']}")
    row = conn.execute("SELECT is_me, trashed, name FROM people WHERE id=?", (person,)).fetchone()
    if not row or row["is_me"] or row["trashed"]:
        return None
    identity.add_identifier(conn, person, "signal-conversation", local, "signal")
    if service:
        identity.add_identifier(conn, person, "signal", service, "signal")
    # Signal is historical evidence, not permission to edit a contact card or
    # restore a phone the user removed. Keep phones only in the source snapshot.
    name = _name(conversation)
    if name and identity.looks_like_identifier(row["name"]):
        conn.execute("UPDATE people SET name=? WHERE id=?", (name, person))
    return person


def _when(message: dict) -> str:
    milliseconds = message.get("sent_at")
    if isinstance(milliseconds, bool) or not isinstance(milliseconds, (int, float)) or milliseconds <= 0:
        raise ValueError("invalid sent_at")
    when = dt.datetime.fromtimestamp(milliseconds / 1000).astimezone().replace(tzinfo=None)
    return when.isoformat(sep=" ", timespec="seconds")


def import_signal(conn: sqlite3.Connection, path: Path, since: dt.date | None = None) -> dict[str, int]:
    # Validate the entire snapshot before changing identities or interactions.
    account, my_phone, conversations, written_to = _scan(path)
    stats = {"conversations": 0, "messages": 0, "interactions": 0, "skipped": 0, "people": 0}
    people: dict[str, int] = {}
    senders: dict[tuple[str, str], set[int]] = {}
    phone_accounts: dict[str, set[str]] = {}
    for cid, conversation in conversations.items():
        if conversation.get("type") == "private" and (number := _phone(conversation.get("e164"))):
            phone_accounts.setdefault(number, set()).add(_service(conversation) or cid)
    with conn:
        for cid, conversation in conversations.items():
            if conversation.get("type") != "private":
                continue
            service, number = _service(conversation), _phone(conversation.get("e164"))
            if service == account or (my_phone and number == my_phone):
                continue  # Note to Self
            person = _person(conn, account, conversation, cid in written_to, len(phone_accounts.get(number, set())) == 1)
            if person:
                people[cid] = person
                for kind, value in (("aci", service), ("phone", number)):
                    if value:
                        senders.setdefault((kind, value), set()).add(person)
        cutoff = since.isoformat() if since else ""
        seen_conversations = set()
        for record in _records(path):
            if record.get("kind") != "message":
                continue
            message = record["data"]
            stats["messages"] += 1
            cid = message.get("conversationId")
            conversation = conversations.get(cid) if isinstance(cid, str) else None
            group = bool(conversation and conversation.get("type") == "group")
            outgoing = message.get("type") == "outgoing"
            if not conversation or not _conversation_message(message) or (group and outgoing):
                stats["skipped"] += 1
                continue
            person = people.get(cid)
            sender = _aci(message.get("sourceServiceId")) or _aci(message.get("sourceUuid"))
            phone = _phone(message.get("source"))
            if group:
                candidates = senders.get(("aci", sender), set()) if sender else senders.get(("phone", phone), set())
                person = next(iter(candidates)) if len(candidates) == 1 else None
                if sender == account or (my_phone and phone == my_phone):
                    person = None
            elif conversation.get("type") != "private":
                person = None
            elif not outgoing:
                # A contradictory sender must not be attributed to the DM partner.
                service, number = _service(conversation), _phone(conversation.get("e164"))
                if (sender and service and sender != service) or (not sender and phone and number and phone != number):
                    person = None
            try:
                when = _when(message)
            except (ValueError, OverflowError, OSError):
                when = ""
            if not person or not when or when < cutoff:
                stats["skipped"] += 1
                continue
            # Desktop-local UUIDs are stable for repeated exports of this history.
            # Different independently linked desktops may have different UUIDs.
            ref = f"signal:{account}:{message['id']}"
            if add_interaction(conn, person, when, "signal", "out" if outgoing else "in", _text(message), "group chat" if group else None, ref):
                stats["interactions"] += 1
            else:
                stats["skipped"] += 1
            seen_conversations.add(cid)
        stats["conversations"] = len(seen_conversations)
        stats["people"] = len(set(people.values()))
    return stats
