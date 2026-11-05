"""Google Contacts import, read through the People API (after `mypeople google login`).

Each contact goes through the same path as a vCard entry, plus a link to the
Google contact so later syncs find it even without a phone or email.
"""

from __future__ import annotations

import sqlite3
import json
import phonenumbers

from .. import identity
from .vcard import Card, import_card

FIELDS = "names,nicknames,emailAddresses,phoneNumbers,birthdays,organizations,addresses,memberships,biographies,urls,relations,events,userDefined,imClients"


def to_card(contact: dict) -> Card:
    names = contact.get("names", [])
    orgs = contact.get("organizations", [])
    addresses = contact.get("addresses", [])
    card = Card(
        name=(names[0].get("displayName") or names[0].get("unstructuredName", "")) if names else "",
        phones=[p.get("canonicalForm") or p.get("value", "") for p in contact.get("phoneNumbers", [])],
        emails=[e.get("value", "") for e in contact.get("emailAddresses", [])],
        org=orgs[0].get("name", "") if orgs else "",
        title=orgs[0].get("title", "") if orgs else "",
        city=next((a["city"] for a in addresses if a.get("city")), ""),
    )
    for b in contact.get("birthdays", []):
        d = b.get("date", {})
        if d.get("month") and d.get("day"):
            card.birthday = f"{d['year']:04d}-{d['month']:02d}-{d['day']:02d}" if d.get("year") else f"--{d['month']:02d}-{d['day']:02d}"
            break
    name = names[0] if names else {}
    card.contact = {
        "name": card.name, "given": name.get("givenName", ""), "family": name.get("familyName", ""),
        "middle": name.get("middleName", ""), "prefix": name.get("honorificPrefix", ""), "suffix": name.get("honorificSuffix", ""),
        "phonetic": name.get("phoneticGivenName", ""), "birthday": card.birthday, "organization": card.org, "title": card.title,
        "notes": "\n".join(b.get("value", "") for b in contact.get("biographies", [])),
        "source_records": [json.dumps(contact, ensure_ascii=False)],
        "fields": [],
    }
    for key, kind in (("phoneNumbers", "phone"), ("emailAddresses", "email"), ("urls", "website"), ("imClients", "im")):
        for field in contact.get(key, []):
            item = {"kind": kind, "value": field.get("value") or field.get("canonicalForm", ""), "label": field.get("type", ""), "preferred": bool(field.get("metadata", {}).get("primary"))}
            if kind == "phone" and not item["value"].lstrip().startswith("+") and field.get("canonicalForm", "").startswith("+"):
                try:
                    region = phonenumbers.region_code_for_number(phonenumbers.parse(field["canonicalForm"], None))
                    if region in phonenumbers.SUPPORTED_REGIONS:
                        item["region"] = region
                except phonenumbers.NumberParseException:
                    pass
            card.contact["fields"].append(item)
    for address in addresses:
        card.contact["fields"].append({"kind": "address", "value": address.get("formattedValue") or "\n".join(address.get(k, "") for k in ("streetAddress", "extendedAddress", "city", "region", "postalCode", "country") if address.get(k)), "label": address.get("type", "")})
    return card


def import_google_contacts(conn: sqlite3.Connection, contacts: list[dict], label: str | None = None) -> dict[str, int]:
    stats = {"contacts": len(contacts), "people": 0, "events": 0, "skipped": 0}
    for c in contacts:
        if label and any(
            m.get("contactGroupMembership", {}).get("contactGroupResourceName") == label for m in c.get("memberships", [])
        ):
            stats["skipped"] += 1  # created by MyPeople itself
            continue
        card = to_card(c)
        person_id, events = import_card(conn, card, "google", "google-contacts", [("google", c["resourceName"])])
        if person_id is None:
            stats["skipped"] += 1
            continue
        for n in c.get("nicknames", []):
            if n.get("value"):
                identity.add_alias(conn, person_id, n["value"])
        stats["people"] += 1
        stats["events"] += events
    conn.commit()
    return stats
