"""Telegram Desktop's machine-readable JSON export (Settings > Advanced).

Contacts have international phone numbers but no Telegram user IDs. Personal
chats supply IDs and display names, not reliable usernames or phone numbers.
Only unique full names bridge those two sources; group membership never creates
people. Message keys include the exporting account and chat for safe re-imports.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3
from collections import defaultdict
from pathlib import Path

from .. import contacts, identity
from .common import add_interaction


class TelegramError(ValueError):
    pass


def _load(root: Path) -> dict:
    path = root / "result.json" if root.is_dir() else root
    try:
        data = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as exc:
        raise TelegramError(f"Couldn't read Telegram JSON at {path}: {exc}") from exc
    if not isinstance(data, dict) or not isinstance(data.get("personal_information"), dict):
        raise TelegramError("Use a full Telegram Desktop export in machine-readable JSON format (result.json), not HTML or a single-chat export.")
    account_id = str(data["personal_information"].get("user_id", ""))
    if not account_id.isdigit() or int(account_id) <= 0:
        raise TelegramError("Telegram export is missing personal_information.user_id; export your full account as JSON.")
    for section in ("contacts", "chats", "left_chats"):
        if section in data and (not isinstance(data[section], dict) or not isinstance(data[section].get("list"), list)):
            raise TelegramError(f"Telegram export has an invalid {section}.list.")
    return data


def _phone(raw: str) -> str:
    """Read explicit international numbers; never guess a country for bare locals."""
    raw = raw.strip()
    if raw.startswith("00"):
        raw = "+" + raw[2:]
    elif raw.isdigit() and len(raw) > 10:
        raw = "+" + raw
    elif not raw.startswith("+"):
        return ""  # retained in source_records, not promoted to a verified phone
    return contacts.phone(raw)[0]


def _contact_key(account_id: str, contact: dict) -> str:
    # Keep the original importer's opaque source keys stable. These are NOT
    # phone identifiers: normalizing their encoding now would duplicate people.
    raw = (contact.get("phone_number") or "").strip()
    original = "+" + raw if raw.isdigit() else raw
    original_number = identity.normalize_phone(original)
    name = _contact_name(contact) or original
    digest = hashlib.sha256(json.dumps([name.casefold(), original_number or original]).encode()).hexdigest()
    return f"{account_id}:{digest}"


def _contact_name(contact: dict) -> str:
    return " ".join(p.strip() for p in (contact.get("first_name") or "", contact.get("last_name") or "") if p.strip())


def _text(message: dict) -> str | None:
    body = message.get("text") or ""
    if isinstance(body, list):
        body = "".join(part if isinstance(part, str) else part.get("text", "") for part in body)
    return body.strip() or None


def _when(message: dict) -> str:
    if message.get("date_unixtime") is not None:
        when = dt.datetime.fromtimestamp(int(message["date_unixtime"])).astimezone()
    else:
        when = dt.datetime.fromisoformat(message["date"]).astimezone()
    return when.replace(tzinfo=None).isoformat(sep=" ", timespec="seconds")


def _sender(message: dict) -> str:
    return message.get("from_id") or message.get("actor_id") or ""


def _conversation(message: dict) -> bool:
    return message.get("type") == "message" or (
        message.get("type") == "service" and message.get("action") == "phone_call"
    )


def _unique_name(conn: sqlite3.Connection, name: str, full_name: bool = True) -> int | None:
    if (full_name and len(name.split()) < 2) or identity.looks_like_identifier(name):
        return None
    rows = conn.execute(
        "SELECT id FROM people WHERE merged_into IS NULL AND trashed=0 AND is_me=0 "
        "AND (lower(name)=lower(?) OR id IN (SELECT person_id FROM aliases WHERE lower(alias)=lower(?)))",
        (name, name),
    ).fetchall()
    return rows[0]["id"] if len(rows) == 1 else None


def _import_contact(conn: sqlite3.Connection, account_id: str, contact: dict, match_name: bool) -> int | None:
    name = _contact_name(contact)
    number = _phone(contact.get("phone_number") or "")
    normalized = identity.normalize_phone(number)
    name = name or number or (contact.get("phone_number") or "").strip()
    if not name:
        return None
    # No Telegram IDs in this list. A source-local key makes even shared-phone
    # and ambiguous-name contacts idempotent without claiming a user ID.
    key = _contact_key(account_id, contact)
    person_id = identity.find_by_identifier(conn, "telegram-contact", key)
    incoming = {
        "name": name, "given": contact.get("first_name") or "", "family": contact.get("last_name") or "",
        "fields": [{"kind": "phone", "value": number, "label": ""}] if number else [],
        "source_records": [json.dumps(contact, ensure_ascii=False, sort_keys=True)],
    }
    if person_id is None:
        matches = contacts.match(conn, incoming)
        if not matches and normalized:
            if identifier_match := identity.find_by_identifier(conn, "phone", normalized):
                matches = [identifier_match]
        if len(matches) == 1:
            candidate = conn.execute("SELECT * FROM people WHERE id=?", (matches[0],)).fetchone()
            if identity.matches_known_name(conn, candidate["id"], name) or identity.looks_like_identifier(candidate["name"]):
                person_id = candidate["id"]
        elif not matches and match_name:
            # Contact-list names are user-curated, unlike chat display names.
            person_id = _unique_name(conn, name, full_name=False)
    if person_id is None:
        person_id = identity.create_person(conn, name)
    person = conn.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
    if person["is_me"] or person["trashed"]:
        return None
    identity.add_identifier(conn, person_id, "telegram-contact", key, "telegram")
    previous = contacts.card_for(person) or {}
    card = incoming | {k: v for k, v in previous.items() if v not in ("", [], None)}
    if not identity.looks_like_identifier(person["name"]):
        card["name"] = person["name"]  # an old merged nickname must not rename the survivor
    # Telegram's list can contain stale or mis-internationalized numbers. A
    # name-only match is not permission to append/replace address-book phones,
    # strip labels, or clear a legacy verification flag. Keep the raw source as
    # provenance instead. This also avoids redundant differently formatted fields.
    have_phones = any(f.get("kind") == "phone" and f.get("value", "").strip() for f in previous.get("fields", []))
    card["fields"] = previous.get("fields", []) if previous.get("user_edited") or have_phones else previous.get("fields", []) + incoming["fields"]
    if normalized and any(f.get("kind") == "phone" and contacts.contact_phone(card, f)[0] == number for f in card["fields"]):
        identity.add_identifier(conn, person_id, "phone", normalized, "telegram")
    card["source_records"] = list(dict.fromkeys(previous.get("source_records", []) + incoming["source_records"]))
    contacts.save(conn, person["contact_uid"], card, person_id)
    return person_id


def import_telegram(conn: sqlite3.Connection, root: Path, since: dt.date | None = None) -> dict[str, int]:
    data = _load(root)
    account = data["personal_information"]
    me_id = str(account["user_id"])
    me_sender = f"user{me_id}"
    my_phone = identity.normalize_phone(_phone(account.get("phone_number") or ""))
    if user := identity.me(conn):
        identity.add_identifier(conn, user["id"], "telegram", me_id, "telegram")

    stats = {"contacts": 0, "conversations": 0, "messages": 0, "calls": 0, "interactions": 0, "skipped": 0}
    exported_contacts = data.get("contacts", {}).get("list", [])
    contact_numbers: dict[str, set[str]] = defaultdict(set)
    for contact in exported_contacts:
        name = _contact_name(contact).casefold()
        contact_numbers[name].add((contact.get("phone_number") or "").strip())
    for contact in exported_contacts:
        name = _contact_name(contact)
        number = _phone(contact.get("phone_number") or "")
        normalized = identity.normalize_phone(number)
        existing = identity.find_by_identifier(conn, "phone", normalized) if normalized else None
        if (my_phone and normalized == my_phone) or (existing and conn.execute("SELECT is_me FROM people WHERE id=?", (existing,)).fetchone()["is_me"]):
            continue
        if _import_contact(conn, me_id, contact, match_name=len(contact_numbers[name.casefold()]) == 1):
            stats["contacts"] += 1

    chats = data.get("chats", {}).get("list", []) + data.get("left_chats", {}).get("list", [])
    personal = [c for c in chats if c.get("type") == "personal_chat" and str(c["id"]) not in (me_id, "777000")]
    people: dict[str, int] = {}
    name_accounts: dict[str, set[str]] = defaultdict(set)
    for chat in personal:
        name_accounts[(chat.get("name") or "").strip().casefold()].add(str(chat["id"]))
    # Resolve all personal chats first: group messages may precede their 1:1 thread.
    for chat in personal:
        account_id, name = str(chat["id"]), (chat.get("name") or "").strip()
        person_id = identity.find_by_identifier(conn, "telegram", account_id)
        if person_id is None and name and len(name_accounts[name.casefold()]) == 1:
            person_id = _unique_name(conn, name)
        written_to = any(_conversation(m) and _sender(m) == me_sender for m in chat.get("messages", []))
        if person_id is None and written_to:
            person_id = identity.create_person(conn, name or f"Telegram user {account_id}")
        if person_id:
            person = conn.execute("SELECT is_me, trashed FROM people WHERE id=?", (person_id,)).fetchone()
            if person["is_me"] or person["trashed"]:
                continue
            identity.add_identifier(conn, person_id, "telegram", account_id, "telegram")
            people[account_id] = person_id

    cutoff = since.isoformat() if since else ""
    for chat in chats:
        group = chat.get("type") in ("private_group", "private_supergroup", "public_supergroup")
        if not group and (chat.get("type") != "personal_chat" or str(chat["id"]) in (me_id, "777000")):
            continue  # saved messages, bots, channels, and Telegram's service account
        stats["conversations"] += 1
        for message in chat.get("messages", []):
            if not _conversation(message):
                continue
            call = message.get("action") == "phone_call"
            stats["calls" if call else "messages"] += 1
            sender = _sender(message)
            outgoing = sender == me_sender
            counterpart = sender.removeprefix("user") if group else str(chat["id"])
            person_id = people.get(counterpart)
            if group and not sender.startswith("user"):
                person_id = None  # anonymous/channel senders aren't user accounts
            if not person_id or not sender or (group and outgoing):
                stats["skipped"] += 1
                continue
            try:
                when = _when(message)
            except (KeyError, TypeError, ValueError, OverflowError, OSError):
                stats["skipped"] += 1
                continue
            if when < cutoff or (not group and sender not in (me_sender, f"user{chat['id']}")):
                stats["skipped"] += 1
                continue
            ref = f"telegram:{me_id}:{chat['id']}:{message['id']}"
            if add_interaction(
                conn, person_id, when, "telegram-call" if call else "telegram", "out" if outgoing else "in",
                None if call else _text(message), "group chat" if group else None, ref,
            ):
                stats["interactions"] += 1
            else:
                stats["skipped"] += 1
    conn.commit()
    stats["people"] = len(set(people.values()))
    return stats
