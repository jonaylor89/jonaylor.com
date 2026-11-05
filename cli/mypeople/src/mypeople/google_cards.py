"""Translate current, user-owned contact cards to conservative People API fields.

Never export historical identifiers or retained import originals. Google updates
append missing list values and fill empty scalar fields; they never remove data.
"""
from __future__ import annotations

import datetime as dt
import re

from . import contacts, identity


def date_value(value: str) -> dict | None:
    try:
        if re.fullmatch(r"--\d{2}-\d{2}", value):
            date = dt.date.fromisoformat("2000" + value[1:])
            return {"month": date.month, "day": date.day}
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", value):
            date = dt.date.fromisoformat(value)
            return {"year": date.year, "month": date.month, "day": date.day}
    except ValueError:
        pass
    return None


def label(value: str) -> str:
    # vCard imports can retain TYPE=HOME parameters rather than a plain label.
    match = re.search(r"(?:^|;)TYPE=([^;]+)", value, re.I)
    tokens = (match[1] if match else value).split(",")
    aliases = {"cell": "mobile", "internet": "", "pref": "", "home": "home", "work": "work", "mobile": "mobile"}
    return next((aliases.get(t.strip().lower(), t.strip()) for t in tokens
                 if aliases.get(t.strip().lower(), t.strip())), "")


def fields(card: dict, *, with_notes: bool) -> dict:
    out: dict = {}
    name = {api: card[key] for key, api in (
        ("given", "givenName"), ("family", "familyName"), ("middle", "middleName"),
        ("prefix", "honorificPrefix"), ("suffix", "honorificSuffix"),
        ("phonetic", "phoneticGivenName"),
    ) if card.get(key)}
    if name:
        if not any(name.get(k) for k in ("givenName", "familyName", "middleName")):
            name["unstructuredName"] = card["name"]
        out["names"] = [name]
    if birthday := date_value(card.get("birthday", "")):
        out["birthdays"] = [{"date": birthday}]
    org = {api: card[key] for key, api in (("organization", "name"), ("title", "title")) if card.get(key)}
    if org:
        out["organizations"] = [org]
    if with_notes and card.get("notes", "").strip():
        out["biographies"] = [{"value": card["notes"], "contentType": "TEXT_PLAIN"}]
    for field in card.get("fields", []):
        kind, value = field.get("kind"), field.get("value", "").strip()
        if not value:
            continue
        item = {"value": value}
        if field.get("label") and (kind_label := label(field["label"])):
            item["type"] = kind_label
        if kind == "phone":
            number, extension = contacts.contact_phone(card, field)
            if not number:
                continue
            item["value"] = number + (f";ext={extension}" if extension else "")
            key = "phoneNumbers"
        elif kind == "email":
            if not identity.normalize_email(value):
                continue
            key = "emailAddresses"
        elif kind == "website":
            if not re.match(r"^https?://", value, re.I):
                continue
            key = "urls"
        elif kind == "address":
            item = {"formattedValue": value, **({"type": item["type"]} if "type" in item else {})}
            key = "addresses"
        elif kind == "im":
            key = "imClients"
            if ":" in value:
                item["protocol"], item["username"] = value.split(":", 1)
            else:
                item["username"] = value
            del item["value"]
        elif kind == "anniversary":
            date = date_value(value)
            if not date:
                continue
            item = {"date": date, "type": "anniversary"}
            key = "events"
        else:
            continue
        out.setdefault(key, [])
        if item not in out[key]:
            out[key].append(item)
    return out


def comparable(key: str, item: dict):
    if key == "phoneNumbers":
        raw = item.get("value") or item.get("canonicalForm", "")
        number, extension = contacts.phone(raw)
        canonical, canonical_extension = contacts.phone(item.get("canonicalForm", ""))
        number = canonical or number
        return (number, extension or canonical_extension) if number else raw.strip()
    if key == "emailAddresses":
        return item.get("value", "").strip().casefold()
    if key == "urls":
        return re.sub(r"^https?://(www\.|m\.)?", "", item.get("value", "").strip().lower()).rstrip("/")
    if key == "addresses":
        value = item.get("formattedValue") or "\n".join(item.get(k, "") for k in (
            "streetAddress", "extendedAddress", "city", "region", "postalCode", "country") if item.get(k))
        return " ".join(value.casefold().split())
    if key == "imClients":
        return item.get("protocol", "").casefold(), item.get("username", "").casefold()
    if key == "events":
        return item.get("type", ""), item.get("date", {})
    return item


def append_missing(key: str, existing: list[dict], incoming: list[dict]) -> list[dict]:
    result = list(existing)
    for item in incoming:
        if not any(comparable(key, item) == comparable(key, old) for old in result):
            result.append(item)
    return result
