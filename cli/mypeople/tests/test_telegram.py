import datetime as dt
import json

import pytest

from mypeople import cli, contacts, identity
from mypeople.importers.telegram import TelegramError, _contact_key, _phone, import_telegram
from mypeople.importers.vcard import Card, import_card


def message(mid, sender="user1", text="Hello", **extra):
    return {"id": mid, "type": "message", "from_id": sender, "text": text,
            "date": "2026-10-01T12:00:00", "date_unixtime": "1790856000", **extra}


def chat(uid, name, messages, kind="personal_chat"):
    return {"id": uid, "type": kind, "name": name, "messages": messages}


def export(tmp_path, chats=(), people=(), **extra):
    data = {"personal_information": {"user_id": 1, "phone_number": "15551234567"},
            "contacts": {"list": list(people)}, "chats": {"list": list(chats)}, **extra}
    path = tmp_path / "result.json"
    path.write_text(json.dumps(data), encoding="utf-8")
    return path


def contact(first="Ada", last="Lovelace", phone="447700900123"):
    return {"first_name": first, "last_name": last, "phone_number": phone,
            "date": "2025-01-01T12:00:00", "date_unixtime": "1735732800"}


def test_contacts_messages_calls_and_reimport(conn, tmp_path):
    ada, _ = import_card(conn, Card(name="Ada Lovelace", phones=["+447700900123"]), "vcard", "test")
    me = identity.create_person(conn, "Me")
    conn.execute("UPDATE people SET is_me=1 WHERE id=?", (me,))
    path = export(tmp_path, [chat(2, "Ada Lovelace", [
        message(1),
        message(2, "user2", ["Hello ", {"type": "bold", "text": "world"}, "! 🎉"]),
        message(3, "user2", "", photo="(File not included)"),
        {"id": 4, "type": "service", "action": "phone_call", "actor_id": "user2", "date_unixtime": "1790856000"},
        {"id": 5, "type": "service", "action": "joined_telegram"},
    ])], [contact(), contact("Me", "", "15551234567")])
    stats = import_telegram(conn, tmp_path)
    assert stats["contacts"] == 1
    assert stats["messages"] == 3
    assert stats["calls"] == 1
    assert stats["interactions"] == 4
    assert identity.find_by_identifier(conn, "telegram", "2") == ada
    assert identity.find_by_identifier(conn, "telegram", "1") == me
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2
    rows = conn.execute("SELECT * FROM interactions ORDER BY id").fetchall()
    assert [r["direction"] for r in rows] == ["out", "in", "in", "in"]
    assert [r["text"] for r in rows] == ["Hello", "Hello world! 🎉", None, None]
    assert rows[-1]["channel"] == "telegram-call"
    assert rows[0]["at"] == dt.datetime.fromtimestamp(1790856000).isoformat(sep=" ")
    card = contacts.card_for(conn.execute("SELECT * FROM people WHERE id=?", (ada,)).fetchone())
    assert any(f["value"] == "+447700900123" for f in card["fields"])
    assert card["source_records"]
    assert import_telegram(conn, path)["interactions"] == 0
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2


def test_groups_only_known_people_and_no_channels_bots_or_self(conn, tmp_path):
    path = export(tmp_path, [
        chat(20, "Friends", [message(1, "user2"), message(2), message(3, "user3"), message(4, "channel2")], "private_supergroup"),
        chat(2, "Ada Lovelace", [message(1), message(2, "user2")]),
        chat(1, "Saved Messages", [message(1)]),
        chat(777000, "Telegram", [message(1)]),
        chat(3, "Unknown Member", [message(1, "user3")]),
        chat(4, "Bot", [message(1)], "bot_chat"),
        chat(5, "Channel", [message(1)], "public_channel"),
    ], left_chats={"list": [chat(21, "Old Group", [message(1, "user2")], "private_group")]})
    stats = import_telegram(conn, path)
    assert stats["interactions"] == 4
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM interactions WHERE thread='group chat'").fetchone()[0] == 2
    assert identity.find_by_identifier(conn, "telegram", "3") is None


def test_incoming_only_matches_existing_full_name_not_first_name(conn, tmp_path):
    ada = identity.create_person(conn, "Ada Lovelace")
    identity.create_person(conn, "Grace")
    path = export(tmp_path, [chat(2, "Ada Lovelace", [message(1, "user2")]),
                             chat(3, "Grace", [message(1, "user3")]),
                             chat(4, "Stranger", [message(1, "user4")])])
    stats = import_telegram(conn, path)
    assert stats["interactions"] == 1
    assert identity.find_by_identifier(conn, "telegram", "2") == ada
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2


def test_ambiguous_existing_names_do_not_merge(conn, tmp_path):
    identity.create_person(conn, "Alex Smith")
    identity.create_person(conn, "Alex Smith")
    path = export(tmp_path, [chat(2, "Alex Smith", [message(1)])])
    import_telegram(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 3
    assert import_telegram(conn, path)["interactions"] == 0
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 3


def test_exported_name_collision_does_not_attach_accounts_to_one_person(conn, tmp_path):
    original = identity.create_person(conn, "Alex Smith")
    path = export(tmp_path, [chat(2, "Alex Smith", [message(1)]), chat(3, "Alex Smith", [message(1)])])
    import_telegram(conn, path)
    a = identity.find_by_identifier(conn, "telegram", "2")
    b = identity.find_by_identifier(conn, "telegram", "3")
    assert a != b and original not in (a, b)


def test_cutoff_keeps_relationship_from_older_outgoing_message(conn, tmp_path):
    path = export(tmp_path, [chat(2, "Ada", [
        message(1, date_unixtime="1577880000"),  # 2020: still establishes a relationship
        message(2, "user2"),
        message(3, "user2", date_unixtime="bad"),
    ])])
    assert import_telegram(conn, path, dt.date(2026, 1, 1))["interactions"] == 1
    assert conn.execute("SELECT direction FROM interactions").fetchone()[0] == "in"
    assert import_telegram(conn, path)["interactions"] == 1


def test_keys_distinguish_chats_and_exporting_accounts(conn, tmp_path):
    path = export(tmp_path, [chat(2, "Ada", [message(1)]), chat(3, "Grace", [message(1)])])
    assert import_telegram(conn, path)["interactions"] == 2
    path = export(tmp_path, [chat(2, "Ada", [message(1, "user10")])], personal_information={"user_id": 10})
    assert import_telegram(conn, path)["interactions"] == 1
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2


def test_trashed_and_self_identifiers_are_not_imported(conn, tmp_path):
    me = identity.create_person(conn, "My Name")
    trashed = identity.create_person(conn, "Ada Lovelace")
    conn.execute("UPDATE people SET is_me=1 WHERE id=?", (me,))
    conn.execute("UPDATE people SET trashed=1 WHERE id=?", (trashed,))
    identity.add_identifier(conn, me, "telegram", "2", "manual")
    identity.add_identifier(conn, trashed, "telegram", "3", "manual")
    path = export(tmp_path, [chat(2, "My Name", [message(1)]), chat(3, "Ada Lovelace", [message(1)])])
    assert import_telegram(conn, path)["interactions"] == 0


def test_contact_reimport_preserves_manual_edits(conn, tmp_path):
    path = export(tmp_path, people=[contact()])
    import_telegram(conn, path)
    person = conn.execute("SELECT * FROM people").fetchone()
    card = contacts.card_for(person)
    card.update(user_edited=True, notes="My private note")
    card["fields"] = []
    contacts.save(conn, person["contact_uid"], card, person["id"])
    import_telegram(conn, path)
    updated = contacts.card_for(conn.execute("SELECT * FROM people WHERE id=?", (person["id"],)).fetchone())
    assert updated["fields"] == []
    assert updated["notes"] == "My private note"


@pytest.mark.parametrize("raw,expected", [
    ("0012025550123", "+12025550123"),
    ("00 44 20 7946 0018", "+442079460018"),
    ("+44 (20) 7946 0018", "+442079460018"),
    ("442079460018", "+442079460018"),
    ("2025550123", ""),  # not +20 (Egypt) or a guessed +1 (US)
    ("02079460018", ""),
    ("+0012025550123", ""),
    ("", ""),
])
def test_phone_source_syntax(raw, expected):
    assert _phone(raw) == expected


@pytest.mark.parametrize("legacy", [False, True])
def test_existing_phone_fields_and_verification_survive_name_match(conn, tmp_path, legacy):
    person = identity.create_person(conn, "Ada Lovelace")
    row = conn.execute("SELECT * FROM people WHERE id=?", (person,)).fetchone()
    original = {"name": "Ada Lovelace", "region": "GB", "legacy_unverified": legacy,
                "fields": [{"kind": "phone", "value": "020 7946 0018", "label": "work", "region": "GB"}]}
    contacts.save(conn, row["contact_uid"], original, person)
    # Telegram's conflicting country code must not be appended to a known card,
    # including cards whose original national number remains unverified.
    path = export(tmp_path, people=[contact(phone="+1 202-555-0123")])
    import_telegram(conn, path)
    current = contacts.card_for(conn.execute("SELECT * FROM people WHERE id=?", (person,)).fetchone())
    assert current["fields"] == original["fields"]
    assert current["region"] == "GB"
    assert current["legacy_unverified"] == legacy
    assert identity.find_by_identifier(conn, "phone", "2025550123") is None


def test_international_prefix_does_not_add_duplicate_phone_fields(conn, tmp_path):
    person, _ = import_card(conn, Card(name="Ada Lovelace", phones=["+1 202-555-0123"]), "vcard", "test")
    original = contacts.card_for(conn.execute("SELECT * FROM people WHERE id=?", (person,)).fetchone())
    path = export(tmp_path, people=[contact(phone="0012025550123")])
    import_telegram(conn, path)
    current = contacts.card_for(conn.execute("SELECT * FROM people WHERE id=?", (person,)).fetchone())
    assert current["fields"] == original["fields"]


def test_old_source_keys_survive_parser_correction(conn, tmp_path):
    import hashlib
    raw = contact(phone="0012025550123")
    original_key = "1:" + hashlib.sha256(json.dumps(["ada lovelace", "+0012025550123"]).encode()).hexdigest()
    assert _contact_key("1", raw) == original_key
    person = identity.create_person(conn, "Ada Lovelace")
    identity.add_identifier(conn, person, "telegram-contact", original_key, "telegram")
    path = export(tmp_path, people=[raw])
    import_telegram(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 1
    current = contacts.card_for(conn.execute("SELECT * FROM people WHERE id=?", (person,)).fetchone())
    assert current["fields"][0]["value"] == "+12025550123"
    assert import_telegram(conn, path)["contacts"] == 1
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 1


def test_new_cards_normalize_idd_and_keep_ambiguous_raw_numbers_only_as_provenance(conn, tmp_path):
    path = export(tmp_path, people=[contact(phone="0012025550123"), contact("Grace", "Hopper", "2025550123")])
    import_telegram(conn, path)
    ada = identity.lookup(conn, "Ada Lovelace")
    grace = identity.lookup(conn, "Grace Hopper")
    assert contacts.card_for(ada)["fields"] == [{"kind": "phone", "value": "+12025550123", "label": ""}]
    assert contacts.card_for(grace)["fields"] == []
    assert "2025550123" in contacts.card_for(grace)["source_records"][0]


@pytest.mark.parametrize("raw", ["00442079460018", "+1 202-555-0123", "2025550123"])
def test_import_does_not_propose_google_phone_changes_for_existing_cards(conn, tmp_path, raw):
    from mypeople import google
    person = identity.create_person(conn, "Ada Lovelace")
    row = conn.execute("SELECT * FROM people WHERE id=?", (person,)).fetchone()
    contacts.save(conn, row["contact_uid"], {"name": "Ada Lovelace", "region": "GB", "fields": [
        {"kind": "phone", "value": "020 7946 0018", "label": "work"},
    ]}, person)
    identity.add_identifier(conn, person, "google", "people/ada", "google")
    remote = [{"resourceName": "people/ada", "names": [{"givenName": "Ada", "familyName": "Lovelace"}],
               "phoneNumbers": [{"value": "020 7946 0018", "canonicalForm": "+442079460018", "type": "work"}]}]
    assert google.plan(conn, remote, with_notes=False) == []
    path = export(tmp_path, people=[contact(phone=raw)])
    import_telegram(conn, path)
    assert google.plan(conn, remote, with_notes=False) == []


def test_shared_phone_and_ambiguous_names_are_idempotent(conn, tmp_path):
    # Shared household numbers are not unique identities, even with the same name.
    for _ in range(2):
        import_card(conn, Card(name="Alex Smith", phones=["+447700900123"]), "vcard", "test")
    # Force two distinct pre-existing owners of the same number.
    other = identity.create_person(conn, "Alex Smith")
    row = conn.execute("SELECT contact_uid FROM people WHERE id=?", (other,)).fetchone()
    contacts.save(conn, row[0], {"name": "Alex Smith", "fields": [{"kind": "phone", "value": "+447700900123"}]}, other)
    path = export(tmp_path, people=[contact("Alex", "Smith")])
    import_telegram(conn, path)
    count = conn.execute("SELECT COUNT(*) FROM people").fetchone()[0]
    import_telegram(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == count


def test_same_named_contacts_with_distinct_numbers_stay_separate(conn, tmp_path):
    path = export(tmp_path, people=[contact("Alex", "Smith"), contact("Alex", "Smith", "447700900456")])
    import_telegram(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2
    import_telegram(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2
    assert conn.execute("SELECT COUNT(*) FROM identifiers WHERE kind='telegram-contact'").fetchone()[0] == 2


def test_curated_contact_names_can_match_single_word_names(conn, tmp_path):
    original = identity.create_person(conn, "Mom")
    path = export(tmp_path, people=[contact("Mom", "")])
    import_telegram(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 1
    assert conn.execute("SELECT 1 FROM identifiers WHERE kind='telegram-contact' AND person_id=?", (original,)).fetchone()


def test_date_fallback_and_outgoing_call_establish_relationship(conn, tmp_path):
    path = export(tmp_path, [chat(2, "Ada", [
        {"id": 1, "type": "service", "action": "phone_call", "actor_id": "user1", "date": "2026-10-01T12:00:00"},
    ])])
    stats = import_telegram(conn, path)
    assert stats["calls"] == stats["interactions"] == 1
    assert conn.execute("SELECT direction FROM interactions").fetchone()[0] == "out"


@pytest.mark.parametrize("data", [{}, [], {"id": 2, "messages": []},
    {"personal_information": {}}, {"personal_information": {"user_id": 1}, "chats": []}])
def test_invalid_export_does_not_write(conn, tmp_path, data):
    path = tmp_path / "result.json"
    path.write_text(json.dumps(data))
    with pytest.raises(TelegramError):
        import_telegram(conn, path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 0


def test_cli_errors_and_dispatch(tmp_path, capsys):
    with pytest.raises(SystemExit, match="Pass the Telegram"):
        cli.main(["--db", ":memory:", "import", "telegram"])
    path = export(tmp_path, [chat(2, "Ada", [message(1)])])
    cli.main(["--db", ":memory:", "import", "telegram", str(path)])
    assert "1 interactions" in capsys.readouterr().out
    with pytest.raises(SystemExit, match="Couldn't read Telegram JSON"):
        cli.main(["--db", ":memory:", "import", "telegram", str(tmp_path / "missing.json")])
