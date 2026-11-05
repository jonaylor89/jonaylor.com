import json
import uuid

import pytest

from mypeople import contacts, identity, ops
from mypeople.importers import gcontacts, vcard


@pytest.mark.parametrize("region,raw,expected", [
    ("GB", "020 7946 0018", "+442079460018"),
    ("DE", "030 123456", "+4930123456"),
    ("FR", "01 42 68 53 00", "+33142685300"),
    ("JP", "03-1234-5678", "+81312345678"),
    ("IT", "06 6982", "+39066982"),
    ("AU", "02 9374 4000", "+61293744000"),
    ("IN", "080 2345 6789", "+918023456789"),
    ("BR", "011 2345-6789", "+551123456789"),
    ("US", "(415) 555-0123", "+14155550123"),
    ("CA", "416 555 0123", "+14165550123"),
    ("US", "011 44 20 7946 0018", "+442079460018"),
    ("DE", "00 44 20 7946 0018", "+442079460018"),
])
def test_country_aware_normalization(region, raw, expected):
    assert contacts.phone(raw, region) == (expected, "")
    if not expected.startswith("+1"):
        assert identity.normalize_phone(raw, region) == expected


def test_extension_zeroes_italian_zero_and_explicit_country_are_preserved():
    assert contacts.phone("tel:+442079460018;ext=0042", "US") == ("+442079460018", "0042")
    assert contacts.phone("+442079460018;0042", "GB") == ("+442079460018", "0042")
    for region in ("US", "DE", "JP", "GB"):
        assert contacts.phone("+39 06 6982", region) == ("+39066982", "")
    assert contacts.phone("+441234567890123456789", "GB") == ("", "")


def test_vcard_keeps_country_overrides_and_original_phone_metadata(conn):
    text = "BEGIN:VCARD\nFN:International\nX-SHERLOQ-REGION:GB\nitem0.TEL:+442079460018\\;ext=42\nitem0.X-SHERLOQ-ORIGINAL-PHONE:020 7946 0018 ext 42\nitem1.TEL;X-SHERLOQ-REGION=JP:+81312345678\nitem1.X-SHERLOQ-ORIGINAL-PHONE:03-1234-5678\nEND:VCARD\n"
    card = vcard.parse(text)[0]
    assert card.phones == ["020 7946 0018 ext 42", "03-1234-5678"]
    assert card.contact["region"] == "GB"
    assert card.contact["fields"][1]["region"] == "JP"
    pid, _ = vcard.import_card(conn, card, "vcard", "test")
    assert identity.find_by_identifier(conn, "phone", "+442079460018") == pid
    assert identity.find_by_identifier(conn, "phone", "+81312345678") == pid
    assert contacts.card_for(conn.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone())["fields"][0]["value"] == "020 7946 0018 ext 42"


def test_phone_metadata_cannot_replace_a_different_number():
    card = vcard.parse("BEGIN:VCARD\nFN:Example\nitem1.TEL:+442079460018\nitem1.X-SHERLOQ-ORIGINAL-PHONE:+4930123456\nEND:VCARD\n")[0]
    assert card.phones == ["+442079460018"]


def test_google_national_number_uses_canonical_country_not_us_default(conn):
    raw = {"resourceName": "people/uk", "names": [{"displayName": "UK Contact"}],
           "phoneNumbers": [{"value": "020 7946 0018", "canonicalForm": "+442079460018", "type": "work"}]}
    card = gcontacts.to_card(raw)
    assert card.contact["fields"][0]["value"] == "020 7946 0018"
    assert card.contact["fields"][0]["region"] == "GB"
    gcontacts.import_google_contacts(conn, [raw])
    assert identity.find_by_identifier(conn, "phone", "+442079460018") == identity.lookup(conn, "UK Contact")["id"]


def test_old_suffix_identifier_cannot_cross_match_a_different_country(conn):
    british = identity.create_person(conn, "British")
    identity.add_identifier(conn, british, "phone", "2079460018", "legacy")
    contacts.save(conn, conn.execute("SELECT contact_uid FROM people WHERE id=?", (british,)).fetchone()[0],
                  {"name": "British", "fields": [{"kind": "phone", "value": "+442079460018"}]}, british)
    assert identity.find_by_identifier(conn, "phone", "+442079460018") == british
    assert identity.find_by_identifier(conn, "phone", "2079460018") is None
    assert identity.normalize_phone("+442079460018") != identity.normalize_phone("+492079460018")


def test_merge_preserves_three_country_contexts_and_original_numbers(conn):
    a = contacts.save(conn, str(uuid.uuid4()), {"name": "First", "region": "GB", "fields": [{"kind": "phone", "value": "020 7946 0018"}]})
    b = contacts.save(conn, str(uuid.uuid4()), {"name": "Second", "region": "JP", "fields": [{"kind": "phone", "value": "03-1234-5678"}, {"kind": "phone", "value": "030 123456", "region": "DE"}]})
    ops.apply(conn, "merge", {"person_ids": [a, b]})
    pid = identity.canonical(conn, b)
    merged = json.loads(conn.execute("SELECT contact_data FROM people WHERE id=?", (pid,)).fetchone()[0])
    assert [f["value"] for f in merged["fields"]] == ["020 7946 0018", "03-1234-5678", "030 123456"]
    assert [contacts.phone(f["value"], f.get("region") or merged["region"])[0] for f in merged["fields"]] == ["+442079460018", "+81312345678", "+4930123456"]


def test_legacy_keys_do_not_get_an_invented_us_country_even_with_an_old_index(conn):
    uid = str(uuid.uuid4())
    pid = contacts.save(conn, uid, {"name": "Legacy", "legacy_unverified": True, "fields": [{"kind": "phone", "value": "2079460018"}]})
    assert conn.execute("SELECT count(*) FROM contact_keys WHERE person_id=?", (pid,)).fetchone()[0] == 0
    identity.add_identifier(conn, pid, "phone", "2079460018", "legacy")
    conn.execute("INSERT INTO contact_keys VALUES(?, 'phone', '+12079460018')", (pid,))
    assert identity.find_by_identifier(conn, "phone", "2079460018") is None


def test_reimport_originals_replaces_unverified_matching_key_without_guessing_country(conn):
    pid = contacts.save(conn, str(uuid.uuid4()), {"name": "Legacy", "legacy_unverified": True, "user_edited": True, "notes": "Keep notes", "fields": [{"kind": "phone", "value": "2079460018"}]})
    original = vcard.parse("BEGIN:VCARD\nFN:Legacy\nTEL:+442079460018\nEND:VCARD\n")[0]
    recovered, _ = vcard.import_card(conn, original, "vcard", "original")
    assert recovered == pid
    data = json.loads(conn.execute("SELECT contact_data FROM people WHERE id=?", (pid,)).fetchone()[0])
    assert not data["legacy_unverified"]
    assert [f["value"] for f in data["fields"]] == ["+442079460018"]
    assert data["notes"] == "Keep notes"

