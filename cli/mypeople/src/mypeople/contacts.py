"""User-owned address-book data. Never overwritten by inferred life events.

Legacy identifiers are discovery/matching hints, not a lossless address book.
Contact cards keep original values, labels and unknown vCard properties separately.
"""
from __future__ import annotations

import base64
import json
import os
import sqlite3
import uuid

import phonenumbers

MAX_PHOTO = 2 * 1024 * 1024


def phone(raw: str, region: str | None = None) -> tuple[str, str]:
    """Return E.164 and extension, without guessing a country from a suffix."""
    try:
        number = phonenumbers.parse(raw, region or os.environ.get("MYPEOPLE_PHONE_REGION", "US"))
        if not phonenumbers.is_possible_number(number):
            return "", ""
        international = phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164)
        if len(international.removeprefix("+")) > 15:
            return "", ""
        return international, number.extension or ""
    except phonenumbers.NumberParseException:
        return "", ""


def validate(card: dict) -> dict:
    if not isinstance(card, dict):
        raise ValueError("Contact must be an object")
    # Retain extensible fields but bound all serialized input, including imported originals.
    if len(json.dumps(card).encode()) > 4 * 1024 * 1024:
        raise ValueError("Contact is too large")
    if not isinstance(card.get("name"), str) or not card["name"].strip():
        raise ValueError("A contact needs a name")
    for key in ("given", "family", "middle", "prefix", "suffix", "phonetic", "notes", "birthday", "organization", "title", "photo", "preferred_channel", "edit_id"):
        if key in card and not isinstance(card[key], str):
            raise ValueError(f"Invalid {key}")
    fields = card.get("fields", [])
    if not isinstance(fields, list) or len(fields) > 500:
        raise ValueError("Too many contact fields")
    for field in fields:
        if not isinstance(field, dict) or not all(isinstance(field.get(k, ""), str) for k in ("kind", "value", "label", "structured", "region")):
            raise ValueError("Invalid contact field")
        if field.get("region") and field["region"] not in phonenumbers.SUPPORTED_REGIONS:
            raise ValueError("Use a supported country code for each phone override")
        for key in ("preferred", "user_added"):
            if key in field and not isinstance(field[key], bool):
                raise ValueError(f"Invalid {key} field")
    for key in ("favorite", "user_edited", "legacy_unverified"):
        if key in card and not isinstance(card[key], bool):
            raise ValueError(f"Invalid {key}")
    if "region" in card and (not isinstance(card["region"], str) or card["region"] not in phonenumbers.SUPPORTED_REGIONS):
        raise ValueError("Use a supported two-letter country code")
    for key in ("originals", "source_records"):
        originals = card.get(key, [])
        if not isinstance(originals, list) or not all(isinstance(s, str) for s in originals):
            raise ValueError(f"Invalid {key}")
    if card.get("photo"):
        try:
            data = base64.b64decode(card["photo"], validate=True)
        except (ValueError, TypeError):
            raise ValueError("Invalid photo") from None
        if len(data) > MAX_PHOTO or not (data.startswith(b"\xff\xd8\xff") or data.startswith(b"\x89PNG\r\n\x1a\n")):
            raise ValueError("Choose a JPEG/PNG photo under 2 MiB")
    return card


def card_for(row) -> dict | None:
    return json.loads(row["contact_data"]) if row["contact_data"] else None


def save(conn: sqlite3.Connection, uid: str, card: dict, person_id: int | None = None) -> int:
    uuid.UUID(uid)
    validate(card)
    row = conn.execute("SELECT * FROM people WHERE contact_uid = ?", (uid,)).fetchone()
    if row:
        from .identity import canonical
        person_id = canonical(conn, row["id"])
        uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (person_id,)).fetchone()[0]
    elif person_id is None:
        person_id = conn.execute("INSERT INTO people (name, contact_uid) VALUES (?, ?)", (card["name"].strip(), uid)).lastrowid
    else:
        existing = conn.execute("SELECT contact_uid FROM people WHERE id = ?", (person_id,)).fetchone()
        if existing is None or (existing[0] and existing[0] != uid):
            raise ValueError("Contact identity changed; sync and try again")
    conn.execute("UPDATE people SET name=?, contact_uid=?, contact_data=? WHERE id=?",
                 (card["name"].strip(), uid, json.dumps(card, ensure_ascii=False), person_id))
    rebuild_keys(conn, person_id, card)
    confirm_manual_profiles(conn, person_id, card)
    return person_id


def mark_manual_websites(card: dict, previous: dict | None = None) -> dict:
    """Mark only newly entered website values, never an entire edited/imported card."""
    known = {f["value"].strip() for f in (previous or {}).get("fields", []) if f.get("kind") == "website"}
    return card | {"fields": [
        f | {"user_added": True} if f.get("kind") == "website" and f["value"].strip() not in known else f
        for f in card.get("fields", [])
    ]}


def confirm_manual_profiles(conn, person_id: int, card: dict) -> None:
    """Project per-link user assertions into profiles in the caller's transaction.

    Card imports carry no user_added assertion. Replication retains it, and later
    review rejections take precedence. Removing a website is not a profile rejection.
    """
    from .profile_urls import profile_url, site

    urls = {url for f in card.get("fields", [])
            if f.get("kind") == "website" and f.get("user_added") is True
            and (url := profile_url(f["value"].strip()))}
    for url in sorted(urls):
        row = conn.execute("SELECT * FROM profiles WHERE person_id=? AND url=?", (person_id, url)).fetchone()
        origin = {"source": "manual_contact", "url": url}
        if row:
            if row["status"] == "rejected":
                continue
            sources = json.loads(row["sources"])
            if origin not in sources:
                sources.append(origin)
            conn.execute("UPDATE profiles SET status='confirmed', confidence=1, sources=? WHERE id=?",
                         (json.dumps(sources), row["id"]))
        else:
            conn.execute("INSERT INTO profiles (person_id, site, url, confidence, status, reason, sources) "
                         "VALUES (?, ?, ?, 1, 'confirmed', ?, ?)",
                         (person_id, site(url), url, "Profile URL explicitly added to the contact by the user.", json.dumps([origin])))


def contact_phone(card: dict, field: dict) -> tuple[str, str]:
    raw = field["value"].strip()
    if card.get("legacy_unverified") and not raw.lower().startswith(("+", "tel:+")):
        return "", ""  # a suffix-only legacy identifier has no proven country
    return phone(field["value"], field.get("region") or card.get("region"))


VCARD_PROPERTIES = {"phone": "TEL", "email": "EMAIL", "address": "ADR", "website": "URL", "im": "IMPP", "anniversary": "ANNIVERSARY"}
# Properties this exporter writes itself; anything else in a card's originals is carried through.
VCARD_OWNED = {"BEGIN", "END", "VERSION", "FN", "N", "TEL", "EMAIL", "ADR", "URL", "IMPP", "ANNIVERSARY", "BDAY", "ORG", "TITLE",
               "NOTE", "PHOTO", "X-ABLABEL", "X-SHERLOQ-FAVORITE", "X-SHERLOQ-CHANNEL", "X-SHERLOQ-REGION", "UID", "X-PHONETIC-FIRST-NAME",
               "X-SHERLOQ-SOURCE-RECORD", "X-SHERLOQ-ORIGINAL-PHONE", "X-SHERLOQ-LEGACY-UNVERIFIED"}


def _vcard_escape(value: str) -> str:
    for char, escaped in (("\\", "\\\\"), ("\n", "\\n"), (";", "\\;"), (",", "\\,"), ("\r", "")):
        value = value.replace(char, escaped)
    return value


def _vcard_fold(line: str) -> str:
    """Fold by UTF-8 length, never inside a code point."""
    out, used = [], 0
    for char in line:
        size = len(char.encode("utf-8", "replace"))
        if used + size > 74:
            out.append("\r\n ")
            used = 1
        out.append(char)
        used += size
    return "".join(out)


def vcard_export(cards: list[dict]) -> str:
    """vCard 3.0, matching VCards.export on Android, so a file from either side reads the same."""
    result = []
    for card in cards:
        family, given, middle, prefix, suffix = (card.get(k, "") for k in ("family", "given", "middle", "prefix", "suffix"))
        lines = ["BEGIN:VCARD", "VERSION:3.0", f"FN:{_vcard_escape(card['name'])}",
                 "N:" + ";".join(map(_vcard_escape, (family, given, middle, prefix, suffix)))]
        for i, field in enumerate(card.get("fields", [])):
            prop = VCARD_PROPERTIES.get(field["kind"])
            if prop is None:
                continue
            value = field["value"]
            if field["kind"] == "phone":
                number, extension = contact_phone(card, field)
                if number:
                    value = f"{number};ext={extension}" if extension else number
            if field["kind"] == "address":
                raw = field.get("structured") or f";;{_vcard_escape(value)};;;;"
            else:
                raw = _vcard_escape(value)
            params = (";TYPE=PREF" if field.get("preferred") else "") + (f";X-SHERLOQ-REGION={field['region']}" if field.get("region") else "")
            lines.append(f"item{i}.{prop}{params}:{raw}")
            if field["kind"] == "phone" and value != field["value"]:
                lines.append(f"item{i}.X-SHERLOQ-ORIGINAL-PHONE:{_vcard_escape(field['value'])}")
            if field.get("label", "").strip():
                lines.append(f"item{i}.X-ABLabel:{_vcard_escape(field['label'])}")
        for prop, key in (("BDAY", "birthday"), ("ORG", "organization"), ("TITLE", "title"), ("NOTE", "notes"), ("X-SHERLOQ-CHANNEL", "preferred_channel"),
                          ("X-SHERLOQ-REGION", "region"), ("X-PHONETIC-FIRST-NAME", "phonetic")):
            if card.get(key):
                lines.append(f"{prop}:{_vcard_escape(card[key])}")
        if card.get("photo"):
            lines.append(f"PHOTO;ENCODING=b;TYPE=JPEG:{card['photo']}")
        if card.get("favorite"):
            lines.append("X-SHERLOQ-FAVORITE:1")
        if card.get("legacy_unverified"):
            lines.append("X-SHERLOQ-LEGACY-UNVERIFIED:1")
        # Unknown properties survive import, edit and export instead of silently disappearing.
        seen = set()
        for original in card.get("originals", []):
            for line in original.replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "").split("\n"):
                name = line.split(":", 1)[0].split(";", 1)[0].rsplit(".", 1)[-1].upper()
                if ":" in line and name not in VCARD_OWNED and line not in seen:
                    seen.add(line)
                    lines.append(line)
        lines.append("END:VCARD")
        result.append("".join(_vcard_fold(line) + "\r\n" for line in lines))
    return "".join(result)


def rebuild_keys(conn, person_id, card):
    conn.execute("DELETE FROM contact_keys WHERE person_id=?", (person_id,))
    for f in card.get("fields", []):
        kind = f["kind"]
        if kind not in ("phone", "email"):
            continue
        key = contact_phone(card, f)[0] if kind == "phone" else f["value"].lower().strip()
        if key:
            conn.execute("INSERT OR IGNORE INTO contact_keys VALUES (?, ?, ?)", (person_id, kind, key))


def match(conn: sqlite3.Connection, card: dict) -> list[int]:
    keys = {(f["kind"], contact_phone(card, f)[0] if f["kind"] == "phone" else f["value"].strip().lower())
            for f in card.get("fields", []) if f.get("kind") in ("phone", "email")}
    keys = {k for k in keys if k[1]}
    matches = []
    for row in conn.execute("SELECT id, contact_data FROM people WHERE merged_into IS NULL AND contact_data <> ''"):
        other = json.loads(row["contact_data"])
        other_keys = {(f["kind"], contact_phone(other, f)[0] if f["kind"] == "phone" else f["value"].strip().lower())
                      for f in other.get("fields", []) if f.get("kind") in ("phone", "email")}
        if keys & other_keys:
            matches.append(row["id"])
    return matches


def migration_report(conn: sqlite3.Connection) -> dict:
    report = {"contacts": 0, "legacy_without_originals": [], "shared_identifiers": [], "invalid_numbers": [], "trashed": 0}
    seen: dict[tuple, list[int]] = {}
    for row in conn.execute("SELECT * FROM people WHERE merged_into IS NULL AND is_me=0"):
        report["contacts"] += 1
        report["trashed"] += bool(row["trashed"])
        card = card_for(row)
        if card is None or card.get("legacy_unverified"):
            report["legacy_without_originals"].append({"id": row["id"], "name": row["name"], "action": "Re-import original address book; country codes and labels may have been lost"})
            continue
        for f in card.get("fields", []):
            if f["kind"] not in ("phone", "email"):
                continue
            value = contact_phone(card, f)[0] if f["kind"] == "phone" else f["value"].lower().strip()
            if not value:
                report["invalid_numbers"].append({"id": row["id"], "value": f["value"]})
            else:
                seen.setdefault((f["kind"], value), []).append(row["id"])
    report["shared_identifiers"] = [{"kind": k[0], "value": k[1], "people": sorted(set(ids))} for k, ids in seen.items() if len(set(ids)) > 1]
    return report


# Only these person-scoped tables may be rewound. Never restore an entire database
# over newer edits. Fingerprint comparison refuses undo after an affected row changes.
TABLES = {"people": "id", "contact_keys": "person_id", "identifiers": "person_id", "aliases": "person_id", "events": "person_id",
          "interactions": "person_id", "moments": "person_id", "photos": "person_id", "profiles": "person_id",
          "relationship_overrides": "person_id", "profile_searches": "person_id", "extraction_state": "person_id"}


def capture(conn, ids):
    marks = ",".join("?" for _ in ids)
    result = {table: [dict(r) for r in conn.execute(f"SELECT * FROM {table} WHERE {column} IN ({marks}) ORDER BY rowid", ids)] for table, column in TABLES.items()}
    return json.dumps(result, sort_keys=True)


def reversible_merge(conn, ids, action):
    before = capture(conn, ids)
    keep = action()
    after = capture(conn, ids)
    conn.execute("INSERT INTO contact_merge_undo (keep_id, person_ids, before_data, after_data) VALUES (?, ?, ?, ?)",
                 (keep, json.dumps(ids), before, after))
    return keep


def undo_merge(conn, keep):
    from . import replica
    person = conn.execute("SELECT contact_uid FROM people WHERE id=?", (keep,)).fetchone()
    linked = replica.load(conn).contact(person[0]) if person else None
    if linked and len(linked.members) > 1:
        raise ValueError("Splitting replicated identities is not supported yet; contact history has been retained")
    row = conn.execute("SELECT * FROM contact_merge_undo WHERE keep_id=? AND undone=0 ORDER BY id DESC LIMIT 1", (keep,)).fetchone()
    if row is None:
        raise ValueError("No merge to undo")
    ids = json.loads(row["person_ids"])
    if capture(conn, ids) != row["after_data"]:
        raise ValueError("These contacts changed after merging. Restore from a backup instead; newer edits were not overwritten.")
    snapshot = json.loads(row["before_data"])
    marks = ",".join("?" for _ in ids)
    for table, column in reversed(list(TABLES.items())):
        if table != "people":
            conn.execute(f"DELETE FROM {table} WHERE {column} IN ({marks})", ids)
    for table, rows in snapshot.items():
        for data in rows:
            if table == "people":
                cols = [c for c in data if c != "id"]
                conn.execute(f"UPDATE people SET {','.join(c+'=?' for c in cols)} WHERE id=?", [data[c] for c in cols] + [data["id"]])
            else:
                cols = list(data)
                conn.execute(f"INSERT INTO {table} ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})", list(data.values()))
    conn.execute("UPDATE contact_merge_undo SET undone=1 WHERE id=?", (row["id"],))
