"""Address book import from .vcf (vCard 3/4), as exported by Apple, Google, etc."""

from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from .. import identity
from ..events import add_event


@dataclass
class Card:
    name: str = ""
    phones: list[str] = field(default_factory=list)
    emails: list[str] = field(default_factory=list)
    birthday: str = ""
    org: str = ""
    title: str = ""
    city: str = ""
    contact: dict = field(default_factory=dict)


def _unfold(text: str) -> list[str]:
    lines: list[str] = []
    for line in text.splitlines():
        if line[:1] in (" ", "\t") and lines:
            lines[-1] += line[1:]
        else:
            lines.append(line)
    return lines


def _unescape(value: str) -> str:
    return value.replace("\\n", "\n").replace("\\N", "\n").replace("\\,", ",").replace("\\;", ";").replace("\\\\", "\\")


def _split_unescaped(value: str, sep: str) -> list[str]:
    return [_unescape(p) for p in re.split(rf"(?<!\\){re.escape(sep)}", value)]


def parse_birthday(raw: str, params: str) -> str:
    raw = raw.strip()
    m = re.match(r"^(\d{4}|--)-?(\d{2})-?(\d{2})", raw)
    if not m:
        return ""
    year, month, day = m.groups()
    # Apple writes year-less birthdays as 1604 with X-APPLE-OMIT-YEAR.
    if year == "--" or "OMIT-YEAR" in params.upper():
        return f"--{month}-{day}"
    return f"{year}-{month}-{day}"


def parse(text: str) -> list[Card]:
    cards: list[Card] = []
    card: Card | None = None
    original: list[str] = []
    labels: dict[str, str] = {}
    original_phones: dict[str, str] = {}
    for line in _unfold(text):
        if card is not None:
            original.append(line)
        if ":" not in line:
            continue
        head, value = line.split(":", 1)
        prop, _, params = head.partition(";")
        prop = prop.split(".")[-1].upper()  # drop "item1." groups
        if prop == "BEGIN" and value.strip().upper() == "VCARD":
            card = Card(contact={"fields": []})
            original = [line]
            labels = {}
            original_phones = {}
        elif prop == "END" and card is not None:
            card.contact.update(name=card.name, birthday=card.birthday, organization=card.org, title=card.title, originals=["\r\n".join(original) + "\r\n"])
            for f in card.contact["fields"]:
                group = f.pop("_group", "")
                if group in labels:
                    f["label"] = labels[group]
                if f["kind"] == "phone" and group in original_phones:
                    from ..contacts import phone
                    region = f.get("region") or card.contact.get("region")
                    original = original_phones[group]
                    if phone(f["value"], region)[0] and phone(original, region) == phone(f["value"], region):
                        f["value"] = original
            card.phones = [f["value"] for f in card.contact["fields"] if f["kind"] == "phone"]
            if card.name:
                cards.append(card)
            card = None
        elif card is None:
            continue
        elif prop == "X-ABLABEL":
            labels[head.split(".")[0]] = _unescape(value).replace("_$!<", "").replace(">!$_", "")
        elif prop == "X-SHERLOQ-LEGACY-UNVERIFIED":
            card.contact["legacy_unverified"] = value.strip() == "1"
        elif prop == "X-SHERLOQ-REGION":
            card.contact["region"] = value.strip().upper()
        elif prop == "X-SHERLOQ-ORIGINAL-PHONE":
            original_phones[head.split(".")[0]] = _unescape(value)
        elif prop == "NOTE":
            card.contact["notes"] = _unescape(value)
        elif prop in ("URL", "IMPP", "ANNIVERSARY"):
            card.contact["fields"].append({"kind": {"URL": "website", "IMPP": "im", "ANNIVERSARY": "anniversary"}[prop], "value": _unescape(value), "label": params})
        elif prop == "PHOTO" and ("ENCODING=b" in params or "ENCODING=B" in params):
            card.contact["photo"] = value.strip()
        elif prop == "FN":
            card.name = _unescape(value).strip()
        elif prop == "N":
            parts = _split_unescaped(value, ";") + [""] * 5
            card.contact.update(zip(("family", "given", "middle", "prefix", "suffix"), parts[:5]))
            if not card.name:
                card.name = " ".join(p for p in (parts[1], parts[0]) if p).strip()
        elif prop in ("TEL", "EMAIL"):
            raw = value.strip().removeprefix("tel:") if prop == "TEL" else value.strip()
            (card.phones if prop == "TEL" else card.emails).append(raw)
            kind = "phone" if prop == "TEL" else "email"
            label = re.search(r"(?:^|;)TYPE=([^;]+)", params, re.I)
            contact_field = {"kind": kind, "value": _unescape(raw), "label": label[1] if label else "", "preferred": "PREF" in params.upper(), "_group": head.split(".")[0] if "." in head else ""}
            region = re.search(r"(?:^|;)X-SHERLOQ-REGION=([A-Z]{2})(?:;|$)", params, re.I)
            if region:
                contact_field["region"] = region[1].upper()
            card.contact["fields"].append(contact_field)
        elif prop == "BDAY":
            card.birthday = parse_birthday(value, params)
        elif prop == "ORG":
            card.org = _split_unescaped(value, ";")[0].strip()
        elif prop == "TITLE":
            card.title = _unescape(value).strip()
        elif prop == "ADR":
            parts = _split_unescaped(value, ";") + [""] * 7
            card.contact["fields"].append({"kind": "address", "value": "\n".join(p for p in parts[:7] if p), "label": params, "structured": value})
            if not card.city:
                card.city = ", ".join(p.strip() for p in (parts[3], parts[4]) if p.strip())
    return cards


def import_vcards(conn: sqlite3.Connection, path: Path) -> dict[str, int]:
    cards = parse(path.read_text(encoding="utf-8", errors="replace"))
    stats = {"cards": len(cards), "events": 0}
    ref = path.name
    for card in cards:
        stats["events"] += import_card(conn, card, "vcard", ref)[1]
    conn.commit()
    return stats


def import_card(
    conn: sqlite3.Connection, card: Card, source: str, ref: str, extra_ids: list[tuple[str, str]] = ()
) -> tuple[int | None, int]:
    """One address-book entry -> (person, new events). Facts are recorded with source "vcard",
    which ranks them below what people say in messages."""
    phone_fields = [f for f in card.contact.get("fields", []) if f.get("kind") == "phone"] or [{"value": raw} for raw in card.phones]
    ids = [("phone", value) for f in phone_fields if (value := identity.normalize_phone(f["value"], f.get("region") or card.contact.get("region")))]
    ids += [("email", e) for e in map(identity.normalize_email, card.emails) if e]
    if not ids and not card.name:
        return None, 0  # nothing to know them by
    ids = list(extra_ids) + ids
    from .. import contacts
    import json
    import uuid
    data = card.contact or {"name": card.name, "birthday": card.birthday, "organization": card.org, "title": card.title,
                            "fields": [{"kind": kind, "value": value, "label": ""} for kind, values in (("phone", card.phones), ("email", card.emails)) for value in values]}
    data["name"] = card.name
    # Shared household identifiers are not proof that two named people are one.
    matches = contacts.match(conn, data)
    candidate = next((pid for kind, value in ids if (pid := identity.find_by_identifier(conn, kind, value)) is not None), None)
    # A stable imported account/contact ID survives renames and explicit merges.
    linked = {pid for kind, value in extra_ids if kind not in ("phone", "email")
              if (pid := identity.find_by_identifier(conn, kind, value)) is not None}
    named = conn.execute("SELECT id FROM people WHERE merged_into IS NULL AND lower(name)=lower(?)", (card.name,)).fetchall()
    if len(linked) == 1:
        candidate = next(iter(linked))
    elif len(named) == 1 and (not matches or named[0]["id"] in matches):
        candidate = named[0]["id"]
    elif len(matches) == 1:
        candidate = matches[0]
    elif len(matches) > 1:
        candidate = None
    if candidate is not None:
        existing = conn.execute("SELECT * FROM people WHERE id=?", (candidate,)).fetchone()
        if not (len(linked) == 1 and candidate in linked) and not identity.matches_known_name(conn, candidate, card.name) and not identity.looks_like_identifier(existing["name"]):
            candidate = None
    person_id = candidate if candidate is not None else identity.create_person(conn, card.name)
    for kind, value in ids:
        identity.add_identifier(conn, person_id, kind, value, source)
    existing = conn.execute("SELECT * FROM people WHERE id=?", (person_id,)).fetchone()
    # Re-import fills missing structured details; manual contact edits always win.
    previous = contacts.card_for(existing)
    if not identity.looks_like_identifier(existing["name"]):
        data["name"] = existing["name"]
    if previous:
        incoming = data
        data = incoming | {k: v for k, v in previous.items() if v not in ("", [], None)}
        data["fields"] = previous.get("fields", []) if previous.get("user_edited") else list({json.dumps(f, sort_keys=True): f for f in previous.get("fields", []) + incoming.get("fields", [])}.values())
        verified_phones = [f for f in incoming.get("fields", []) if f.get("kind") == "phone" and (f["value"].lstrip().startswith("+") or f.get("region") or incoming.get("region"))]
        if previous.get("legacy_unverified") and not incoming.get("legacy_unverified") and verified_phones:
            data["fields"] = [f for f in previous.get("fields", []) if f.get("kind") != "phone"] + incoming.get("fields", [])
            data["legacy_unverified"] = False
        data["originals"] = list(dict.fromkeys(previous.get("originals", []) + incoming.get("originals", [])))
        data["source_records"] = list(dict.fromkeys(previous.get("source_records", []) + incoming.get("source_records", [])))
    # Unsupported/oversized embedded photos remain in the preserved original.
    try:
        contacts.validate(data)
    except ValueError:
        data.pop("photo", None)
    contacts.save(conn, existing["contact_uid"] or str(uuid.uuid4()), data, person_id)
    if conn.execute("SELECT is_me FROM people WHERE id = ?", (person_id,)).fetchone()["is_me"]:
        return person_id, 0  # your own card
    new = []
    if card.birthday:
        new.append(add_event(conn, person_id, "birthday", "Birthday", card.birthday, 1.0, "vcard", ref))
    if card.org or card.title:
        role = " at ".join(p for p in (card.title, card.org) if p)
        new.append(add_event(conn, person_id, "job", f"Works as {role}" if card.title else f"Works at {card.org}", None, 0.7, "vcard", ref))
    if card.city:
        new.append(add_event(conn, person_id, "move", f"Lives in {card.city}", None, 0.6, "vcard", ref))
    return person_id, sum(1 for e in new if e)
