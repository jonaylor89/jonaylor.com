import datetime as dt
import hashlib
import json
import sqlite3

import pytest

from mypeople import contacts, identity, phone_recovery as recovery
from .conftest import make_chat_db


def person(conn, key="2079460018", google="people/one", name="Original Person", card=None):
    pid = identity.create_person(conn, name)
    identity.add_identifier(conn, pid, "phone", key, "legacy")
    if google:
        identity.add_identifier(conn, pid, "google", google, "google")
    if card is not None:
        uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (pid,)).fetchone()[0]
        contacts.save(conn, uid, {"name": name} | card, pid)
    conn.commit()
    return pid


def google(number="+442079460018", resource="people/one", raw=None, emails=()):
    return {"resourceName": resource, "phoneNumbers": [{"value": raw or number, "canonicalForm": number, "type": "work"}],
            "emailAddresses": [{"value": email} for email in emails]}


def anchored(conn, pid, ref, channel="imessage"):
    conn.execute("INSERT INTO interactions(person_id,at,channel,direction,source_ref) VALUES(?,'2025-01-01',?,'in',?)", (pid, channel, ref))
    conn.commit()


def test_google_resource_id_recovers_country_and_keeps_historical_identifiers(conn, tmp_path):
    pid = person(conn)
    original = [tuple(r) for r in conn.execute("SELECT * FROM identifiers")]
    src = recovery.Sources(conn)
    src.google([google()])
    plan = src.plan()
    assert len(plan["changes"]) == 1
    assert plan["changes"][0]["after"]["fields"][0]["value"] == "+442079460018"
    result = recovery.apply(conn, plan, tmp_path)
    assert result["applied"] == 1
    assert [tuple(r) for r in conn.execute("SELECT * FROM identifiers")] == original
    assert conn.execute("SELECT value FROM contact_keys WHERE person_id=?", (pid,)).fetchone()[0] == "+442079460018"
    assert (tmp_path / result["backup"]).stat().st_mode & 0o777 == 0o600
    assert (tmp_path / result["report"]).stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(result["backup"]) as before:
        assert before.execute("SELECT contact_data FROM people WHERE id=?", (pid,)).fetchone()[0] == ""
    assert recovery.Sources(conn).plan()["changes"] == []


def test_name_or_suffix_alone_never_assigns_a_source(conn):
    person(conn, google=None)
    src = recovery.Sources(conn)
    record = google(resource="people/unlinked") | {"names": [{"displayName": "Original Person"}]}
    src.google([record])
    assert not src.plan()["changes"]
    assert len(src.plan()["unresolved"]) == 1


def test_unique_email_is_an_anchor_but_shared_source_email_is_not(conn):
    pid = person(conn, google=None)
    identity.add_identifier(conn, pid, "email", "owner@example.test", "vcard")
    conn.commit()
    src = recovery.Sources(conn)
    src.google([google(emails=["OWNER@example.test"])])
    assert len(src.plan()["changes"]) == 1
    src = recovery.Sources(conn)
    src.google([google(emails=["owner@example.test"]), google(resource="people/two", emails=["owner@example.test"])])
    assert not src.plan()["changes"]


def test_disagreeing_identity_anchors_are_not_merged(conn):
    first = person(conn)
    second = person(conn, "5551234567", "people/two", "Other Person")
    identity.add_identifier(conn, second, "email", "other@example.test", "vcard")
    conn.commit()
    src = recovery.Sources(conn)
    src.google([google(emails=["other@example.test"])])
    assert not src.plan()["changes"]
    assert first != second


def test_original_national_without_country_metadata_is_not_guessed(conn):
    person(conn)
    src = recovery.Sources(conn)
    src.google([google(number="", raw="2079460018")])
    assert not src.plan()["changes"]


def test_imessage_uses_exact_guid_and_excludes_own_group_messages(conn, tmp_path):
    pid = person(conn, google=None)
    anchored(conn, pid, "imessage:exact")
    anchored(conn, pid, "imessage:own-group")
    path = tmp_path / "messages#private.db"
    make_chat_db(path, [
        ("exact", "+442079460018", "+442079460018", 45, False, dt.datetime(2025, 1, 1), "Not read", False),
        ("unimported", "+492079460018", "+492079460018", 45, False, dt.datetime(2025, 1, 1), "Not read", False),
        ("own-group", "+492079460018", "group-id", 43, True, dt.datetime(2025, 1, 1), "Not read", False),
    ])
    before = hashlib.sha256(path.read_bytes()).digest()
    src = recovery.Sources(conn)
    src.imessage(path)
    change = src.plan()["changes"][0]
    assert change["after"]["fields"][0]["value"] == "+442079460018"
    assert hashlib.sha256(path.read_bytes()).digest() == before
    assert "Not read" not in json.dumps(src.plan())
    with recovery.readonly(path) as readonly:
        with pytest.raises(sqlite3.OperationalError):
            readonly.execute("DELETE FROM message")


def test_country_collisions_stay_unresolved_even_with_exact_source_links(conn, tmp_path):
    pid = person(conn)
    anchored(conn, pid, "imessage:collision")
    path = tmp_path / "chat.db"
    make_chat_db(path, [("collision", "+492079460018", "+492079460018", 45, False, dt.datetime(2025, 1, 1), "", False)])
    src = recovery.Sources(conn)
    src.google([google()])
    src.imessage(path)
    plan = src.plan()
    assert not plan["changes"]
    assert len(plan["ambiguous"]) == 1
    assert set(plan["ambiguous"][0]["choices"]) == {"+442079460018", "+492079460018"}


def test_canonical_metadata_preserves_original_extension_and_italian_zero(conn):
    person(conn, key=recovery.legacy_key("020 7946 0018 ext 0042"))
    src = recovery.Sources(conn)
    src.google([google(raw="020 7946 0018 ext 0042")])
    assert src.plan()["changes"][0]["after"]["fields"][0]["value"] == "+442079460018;ext=0042"
    person(conn, key="39066982", google="people/italy", name="Italian")
    src = recovery.Sources(conn)
    src.google([google("+39066982", "people/italy", "06 6982")])
    assert src.plan()["changes"][0]["after"]["fields"][0]["value"] == "+39066982"


def test_contradictory_canonical_metadata_blocks_person_instead_of_choosing(conn):
    pid = person(conn)
    src = recovery.Sources(conn)
    src.google([google(raw="+492079460018"), google()])
    plan = src.plan()
    assert not plan["changes"]
    assert pid in src.blocked
    assert plan["warnings"]


def test_bare_message_address_corroborates_extension_not_a_country_conflict(conn):
    pid = person(conn)
    src = recovery.Sources(conn)
    src.google([google(raw="020 7946 0018 ext 0042")])
    src.add(pid, "+442079460018", "imessage", "imessage:one")
    plan = src.plan()
    assert not plan["ambiguous"]
    assert [f["value"] for f in plan["changes"][0]["after"]["fields"]] == ["+442079460018;ext=0042"]


def test_partial_recovery_preserves_notes_labels_unknown_values_and_is_idempotent(conn, tmp_path):
    pid = person(conn, card={"legacy_unverified": True, "notes": "Keep these", "favorite": True, "fields": [
        {"kind": "phone", "value": "2079460018", "label": "Custom label", "preferred": True},
        {"kind": "phone", "value": "5551234567", "label": "Unknown"},
        {"kind": "website", "value": "https://example.test"}]})
    identity.add_identifier(conn, pid, "phone", "5551234567", "legacy")
    conn.commit()
    src = recovery.Sources(conn)
    src.google([google()])
    plan = src.plan()
    card = plan["changes"][0]["after"]
    assert card["notes"] == "Keep these" and card["favorite"] and card["legacy_unverified"]
    assert {f["value"] for f in card["fields"]} == {"5551234567", "+442079460018", "https://example.test"}
    assert next(f for f in card["fields"] if f["value"] == "+442079460018")["label"] == "Custom label"
    recovery.apply(conn, plan, tmp_path)
    again = recovery.Sources(conn)
    again.google([google()])
    assert not again.plan()["changes"]


@pytest.mark.parametrize("field,changed", [("name", "New name"), ("contact_data", '{"name":"Changed","fields":[]}'), ("trashed", 1), ("is_me", 1)])
def test_concurrent_edits_or_lifecycle_changes_are_not_overwritten(conn, tmp_path, field, changed):
    pid = person(conn)
    src = recovery.Sources(conn)
    src.google([google()])
    plan = src.plan()
    conn.execute(f"UPDATE people SET {field}=? WHERE id=?", (changed, pid))
    conn.commit()
    result = recovery.apply(conn, plan, tmp_path)
    assert result["applied"] == 0 and result["skipped_changed"] == 1
    assert conn.execute(f"SELECT {field} FROM people WHERE id=?", (pid,)).fetchone()[0] == changed


def test_new_email_or_index_change_after_preview_also_prevents_overwrite(conn, tmp_path):
    pid = person(conn)
    src = recovery.Sources(conn)
    src.google([google()])
    plan = src.plan()
    identity.add_identifier(conn, pid, "email", "new@example.test", "manual")
    conn.commit()
    assert recovery.apply(conn, plan, tmp_path)["skipped_changed"] == 1


def test_fresh_partial_card_keeps_its_field_order_on_rerun(conn, tmp_path):
    pid = person(conn)
    identity.add_identifier(conn, pid, "phone", "5551234567", "legacy")
    conn.commit()
    src = recovery.Sources(conn)
    src.google([google()])
    recovery.apply(conn, src.plan(), tmp_path)
    again = recovery.Sources(conn)
    again.google([google()])
    assert not again.plan()["changes"]


def test_verified_manual_cards_never_resurrect_removed_phones(conn):
    person(conn, card={"fields": [], "user_edited": True})
    src = recovery.Sources(conn)
    src.google([google()])
    assert not src.plan()["changes"]


def test_failed_batch_rolls_back_all_repairs_with_backup_retained(conn, tmp_path):
    first = person(conn)
    second = person(conn, key=recovery.legacy_key("+4930123456"), google="people/two", name="Second")
    src = recovery.Sources(conn)
    src.google([google(), google("+4930123456", "people/two")])
    plan = src.plan()
    assert len(plan["changes"]) == 2
    conn.executescript(f"CREATE TRIGGER reject_repair BEFORE UPDATE OF contact_data ON people WHEN NEW.id={second} BEGIN SELECT RAISE(ABORT,'test failure'); END;")
    with pytest.raises(sqlite3.IntegrityError, match="test failure"):
        recovery.apply(conn, plan, tmp_path)
    assert all(r[0] == "" for r in conn.execute("SELECT contact_data FROM people WHERE id IN (?,?)", (first, second)))
    assert list(tmp_path.glob("before-phone-recovery*.db"))


def test_whatsapp_lid_and_device_jid_are_recovered_but_outgoing_group_is_not(conn, tmp_path):
    pid = person(conn, google=None)
    anchored(conn, pid, "whatsapp:privacy@lid:stanza", "whatsapp")
    anchored(conn, pid, "whatsapp:group@g.us:own", "whatsapp")
    with sqlite3.connect(tmp_path / "ContactsV2.sqlite") as c:
        c.executescript("CREATE TABLE ZWAADDRESSBOOKCONTACT(ZLID TEXT,ZWHATSAPPID TEXT); INSERT INTO ZWAADDRESSBOOKCONTACT VALUES('privacy@lid','442079460018:3@s.whatsapp.net');")
    with sqlite3.connect(tmp_path / "ChatStorage.sqlite") as c:
        c.executescript("""CREATE TABLE ZWACHATSESSION(Z_PK INTEGER,ZSESSIONTYPE INTEGER,ZCONTACTJID TEXT,ZCONTACTIDENTIFIER TEXT);
          CREATE TABLE ZWAGROUPMEMBER(Z_PK INTEGER,ZMEMBERJID TEXT);
          CREATE TABLE ZWAMESSAGE(Z_PK INTEGER,ZSTANZAID TEXT,ZISFROMME INTEGER,ZCHATSESSION INTEGER,ZGROUPMEMBER INTEGER);
          INSERT INTO ZWACHATSESSION VALUES(1,0,'privacy@lid','privacy@lid'),(2,1,'group@g.us',NULL);
          INSERT INTO ZWAGROUPMEMBER VALUES(1,'492079460018@s.whatsapp.net');
          INSERT INTO ZWAMESSAGE VALUES(1,'stanza',0,1,NULL),(2,'own',1,2,1);""")
    src = recovery.Sources(conn)
    src.whatsapp(tmp_path)
    plan = src.plan()
    assert not plan["ambiguous"]
    assert plan["changes"][0]["after"]["fields"][0]["value"] == "+442079460018"


def test_source_for_merged_id_is_associated_with_surviving_person(conn):
    keep = person(conn)
    drop = identity.create_person(conn, "Merged")
    conn.execute("UPDATE people SET merged_into=? WHERE id=?", (keep, drop))
    anchored(conn, drop, "imessage:old")
    src = recovery.Sources(conn)
    src.add(src.refs["imessage:old"], "+442079460018", "imessage", "imessage:old")
    assert src.plan()["changes"][0]["id"] == keep


def test_mac_contacts_email_anchor_reads_original_not_normalized_suffix(conn, tmp_path):
    pid = person(conn, google=None)
    identity.add_identifier(conn, pid, "email", "owner@example.test", "vcard")
    conn.commit()
    path = tmp_path / "AddressBook.abcddb"
    with sqlite3.connect(path) as c:
        c.executescript("""CREATE TABLE ZABCDEMAILADDRESS(ZOWNER INTEGER,ZADDRESS TEXT);
          CREATE TABLE ZABCDPHONENUMBER(Z_PK INTEGER,ZOWNER INTEGER,ZFULLNUMBER TEXT,ZLABEL TEXT);
          INSERT INTO ZABCDEMAILADDRESS VALUES(1,'owner@example.test');
          INSERT INTO ZABCDPHONENUMBER VALUES(1,1,'+44 20 7946 0018','Home');""")
    src = recovery.Sources(conn)
    src.addressbook(path)
    assert src.plan()["changes"][0]["after"]["fields"][-1]["value"] == "+442079460018"
    with sqlite3.connect(path) as c:
        c.execute("INSERT INTO ZABCDEMAILADDRESS VALUES(2,'OWNER@example.test')")
    src = recovery.Sources(conn)
    src.addressbook(path)
    assert not src.plan()["changes"]


def test_lossless_identifier_is_not_reassigned_using_another_countrys_suffix(conn):
    person(conn, key="+442079460018")
    src = recovery.Sources(conn)
    src.google([google("+492079460018")])
    assert src.plan()["changes"][0]["after"]["fields"][0]["value"] == "+442079460018"


def test_changed_index_and_excluded_phone_uids_are_preserved(conn, tmp_path):
    pid = person(conn)
    src = recovery.Sources(conn)
    src.google([google()])
    uid = src.people[pid]["contact_uid"]
    assert not src.plan(excluded_uids={uid})["changes"]
    plan = src.plan()
    conn.execute("INSERT INTO contact_keys VALUES(?,'email','new@example.test')", (pid,))
    conn.commit()
    assert recovery.apply(conn, plan, tmp_path)["skipped_changed"] == 1
