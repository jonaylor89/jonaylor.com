"""Explicit identity decisions must survive re-imports with old display names."""
import json
import uuid

import pytest

from mypeople import contacts, contact_cli, identity, replica
from mypeople.importers import gcontacts, telegram, vcard
from mypeople.importers.common import resolve_counterpart


NUMBER = "+442079460018"


def create(conn, name, number=NUMBER):
    return contacts.save(conn, str(uuid.uuid4()), {
        "name": name, "fields": [{"kind": "phone", "value": number, "label": "work"}],
        "notes": "Keep this note", "region": "GB",
    })


def merge(conn, keep, drop, replicated):
    if replicated:
        rows = {r["id"]: r for r in conn.execute("SELECT * FROM people")}
        contact_cli.merge(conn, [rows[keep]["contact_uid"], rows[drop]["contact_uid"]], preferred=rows[keep]["contact_uid"])
        return identity.canonical(conn, keep)
    identity.merge(conn, keep, drop)
    return keep


def import_variant(conn, tmp_path, source, name):
    if source == "telegram":
        path = tmp_path / "result.json"
        path.write_text(json.dumps({"personal_information": {"user_id": 1}, "contacts": {"list": [
            {"first_name": name, "last_name": "", "phone_number": "00442079460018"},
        ]}}))
        telegram.import_telegram(conn, path)
        return identity.find_by_identifier(conn, "telegram-contact", telegram._contact_key("1", {"first_name": name, "phone_number": "00442079460018"}))
    return vcard.import_card(conn, vcard.Card(name=name, phones=[NUMBER]), "vcard", "test")[0]


@pytest.mark.parametrize("replicated", [False, True])
@pytest.mark.parametrize("source", ["vcard", "telegram"])
def test_reimport_old_merged_name_keeps_surviving_identity(conn, tmp_path, source, replicated):
    full = create(conn, "Elizabeth Wood")
    short = create(conn, "Liz")
    keep = merge(conn, full, short, replicated)
    # Even a later rename should not erase the old merge decision.
    row = conn.execute("SELECT * FROM people WHERE id=?", (keep,)).fetchone()
    data = contacts.card_for(row) | {"name": "Elizabeth Wren", "user_edited": True}
    contacts.save(conn, row["contact_uid"], data, keep)
    count = conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
    for _ in range(2):
        assert import_variant(conn, tmp_path, source, "Liz") == keep
        assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == count
        after = conn.execute("SELECT * FROM people WHERE id=?", (keep,)).fetchone()
        assert after["name"] == "Elizabeth Wren"
        assert contacts.card_for(after)["fields"] == data["fields"]
        assert contacts.card_for(after)["notes"] == "Keep this note"


@pytest.mark.parametrize("source", ["vcard", "telegram"])
def test_pre_fix_merge_recovers_overwritten_root_name_from_history(conn, tmp_path, source):
    short = contacts.save(conn, "00000000-0000-4000-8000-000000000001", {"name": "Liz", "fields": [{"kind": "phone", "value": NUMBER}]})
    full = contacts.save(conn, "ffffffff-ffff-4fff-8fff-ffffffffffff", {"name": "Elizabeth Wood", "fields": [{"kind": "phone", "value": NUMBER}]})
    keep = merge(conn, full, short, True)
    assert keep == short  # lexicographically smallest UUID, now named Elizabeth
    conn.execute("DELETE FROM aliases")  # simulate the old materializer
    assert not conn.execute("SELECT 1 FROM people WHERE name='Liz'").fetchone()
    assert identity.matches_known_name(conn, keep, "Liz")
    assert import_variant(conn, tmp_path, source, "Liz") == keep
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2


def test_known_names_follow_chained_merges_and_preserve_unicode(conn):
    a = create(conn, "Élisabeth Wood")
    b = create(conn, "Liz")
    c = create(conn, "Elizabeth Wren")
    identity.merge(conn, b, a)
    identity.merge(conn, c, b)
    identity.add_alias(conn, c, "Beth")
    for name in ("ÉLISABETH  WOOD", "Liz", "Beth", "Elizabeth Wren"):
        assert identity.matches_known_name(conn, c, name)
    assert not identity.matches_known_name(conn, c, "Elizabeth")
    assert not identity.matches_known_name(conn, c, "Elisabeth Wood")


@pytest.mark.parametrize("source", ["imessage", "whatsapp"])
@pytest.mark.parametrize("replicated", [False, True])
def test_message_imports_continue_to_resolve_merged_phones(conn, source, replicated):
    full = create(conn, "Elizabeth Wood")
    short = create(conn, "Liz")
    identity.add_identifier(conn, short, "phone", identity.normalize_phone(NUMBER), source)
    keep = merge(conn, full, short, replicated)
    count = conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
    assert resolve_counterpart(conn, NUMBER, "Liz", source, {identity.normalize_handle(NUMBER)}) == keep
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == count


def test_google_stable_id_survives_merge_and_name_change_even_with_shared_phone(conn):
    full = create(conn, "Elizabeth Wood")
    short = create(conn, "Liz")
    identity.add_identifier(conn, short, "google", "people/liz", "google")
    keep = merge(conn, full, short, False)
    # Another legitimate household contact makes phone-only matching ambiguous.
    create(conn, "Jamie Wood")
    raw = {"resourceName": "people/liz", "names": [{"displayName": "Beth"}],
           "phoneNumbers": [{"value": NUMBER, "canonicalForm": NUMBER}]}
    count = conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
    gcontacts.import_google_contacts(conn, [raw])
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == count
    assert identity.find_by_identifier(conn, "google", "people/liz") == keep
    assert conn.execute("SELECT name FROM people WHERE id=?", (keep,)).fetchone()[0] == "Elizabeth Wood"


@pytest.mark.parametrize("source", ["vcard", "telegram"])
def test_unconfirmed_shared_phone_does_not_merge_different_names(conn, tmp_path, source):
    original = create(conn, "Elizabeth Wood")
    other = import_variant(conn, tmp_path, source, "Jamie Wood")
    assert other != original
    assert identity.canonical(conn, original) == original


def test_known_alias_can_fill_phoneless_surviving_card_without_renaming(conn, tmp_path):
    pid = identity.create_person(conn, "Elizabeth Wood")
    identity.add_alias(conn, pid, "Liz")
    identity.add_identifier(conn, pid, "phone", identity.normalize_phone(NUMBER), "vcard")
    assert import_variant(conn, tmp_path, "vcard", "Liz") == pid
    assert conn.execute("SELECT name FROM people WHERE id=?", (pid,)).fetchone()[0] == "Elizabeth Wood"
