import json
import uuid

import pytest

from mypeople import contacts, db, identity, ops, publish
from mypeople.importers import vcard


def card(name="Alex", number="+44 20 7946 0018"):
    return {"name": name, "fields": [{"kind": "phone", "value": number, "label": "Work", "preferred": True}], "notes": "User notes", "given": name}


def create(conn, data=None):
    uid = str(uuid.uuid4())
    ops.apply(conn, "contact_save", {"contact_uid": uid, "local_id": -1, "card": data or card()})
    return conn.execute("SELECT * FROM people WHERE contact_uid=?", (uid,)).fetchone()


def test_international_numbers_not_suffix_keys():
    assert contacts.phone("020 7946 0018 ext 42", "GB") == ("+442079460018", "42")
    assert identity.normalize_phone("+44 20 7946 0018") != identity.normalize_phone("+49 20 7946 0018")
    assert identity.normalize_phone("+1 415 555 0123") == "4155550123"
    assert contacts.phone("not a phone") == ("", "")


def test_offline_create_retry_edit_trash_restore(conn):
    p = create(conn)
    ops.apply(conn, "contact_save", {"contact_uid": p["contact_uid"], "local_id": -1, "card": card("Alex W")})
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 1
    assert identity.lookup(conn, "Alex W")["id"] == p["id"]
    records, _ = publish.records(conn)
    published = records[("person", str(p["id"]))]
    assert published["card"]["fields"][0]["value"] == "+44 20 7946 0018"
    assert published["contact_uid"] == p["contact_uid"]
    ops.apply(conn, "contact_trash", {"contact_uid": p["contact_uid"]})
    assert publish.records(conn)[0][("person", str(p["id"]))]["trashed"]
    ops.apply(conn, "contact_restore", {"contact_uid": p["contact_uid"]})
    assert not publish.records(conn)[0][("person", str(p["id"]))]["trashed"]


def test_shared_identifiers_do_not_merge(conn):
    a = create(conn, card("Alex"))
    b = create(conn, card("Jamie"))
    assert a["id"] != b["id"]
    assert identity.find_by_identifier(conn, "phone", "+442079460018") is None
    report = contacts.migration_report(conn)
    assert report["shared_identifiers"][0]["people"] == [a["id"], b["id"]]


def test_vcard_keeps_originals_full_address_labels_notes(conn, tmp_path):
    text = "BEGIN:VCARD\nVERSION:3.0\nFN:Alice Anders\nN:Anders;Alice;Marie;Dr.;Jr.\nitem1.TEL;TYPE=CELL,PREF:+49 30 123456 ext 5\nitem1.X-ABLabel:Personal\nADR;TYPE=HOME:;;12 Main St;Berlin;;10115;Germany\nNOTE:A note\\nSecond line\nURL:https://example.org\nX-CUSTOM:keep me\nEND:VCARD\n"
    path = tmp_path / "contacts.vcf"; path.write_text(text)
    vcard.import_vcards(conn, path)
    row = identity.lookup(conn, "Alice")
    data = json.loads(row["contact_data"])
    assert data["family"] == "Anders" and data["middle"] == "Marie"
    assert data["notes"] == "A note\nSecond line"
    assert data["fields"][0] == {"kind": "phone", "value": "+49 30 123456 ext 5", "label": "Personal", "preferred": True}
    assert "12 Main St" in data["fields"][1]["value"]
    assert "X-CUSTOM:keep me" in data["originals"][0]
    vcard.import_vcards(conn, path)
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 1


def test_reimport_shared_household_stays_separate(conn, tmp_path):
    path = tmp_path / "family.vcf"
    path.write_text("".join(f"BEGIN:VCARD\nFN:{name}\nTEL:+442079460018\nEND:VCARD\n" for name in ["Alex", "Jamie"]))
    vcard.import_vcards(conn, path)
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 2
    vcard.import_vcards(conn, path)
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 2


def test_manual_contact_data_not_changed_by_facts(conn):
    p = create(conn)
    before = conn.execute("SELECT contact_data FROM people").fetchone()[0]
    ops.apply(conn, "event_add", {"person_id": p["id"], "type": "move", "value": "Lives in Paris"})
    assert conn.execute("SELECT contact_data FROM people").fetchone()[0] == before


def test_merge_and_safe_undo(conn):
    a = create(conn, card("Alex", "+442079460018")); b = create(conn, card("Alex W", "+4930123456"))
    from mypeople import graph_runtime
    graph_runtime.project(conn, graph_runtime.capture(conn))
    before = contacts.capture(conn, [a["id"], b["id"]])
    ops.apply(conn, "merge", {"person_ids": [a["id"], b["id"]]})
    keep = identity.canonical(conn, b["id"])
    records, _ = publish.records(conn)
    assert records[("person", str(keep))]["can_undo_merge"]
    ops.apply(conn, "merge_undo", {"person_id": keep})
    assert contacts.capture(conn, [a["id"], b["id"]]) == before


def test_merge_undo_preserves_newer_edits(conn):
    a = create(conn); b = create(conn, card("Other", "+4930123456"))
    ops.apply(conn, "merge", {"person_ids": [a["id"], b["id"]]})
    keep = identity.canonical(conn, b["id"])
    ops.apply(conn, "rename", {"person_id": keep, "name": "Newer edit"})
    ops.apply(conn, "merge_undo", {"person_id": keep})
    assert identity.lookup(conn, "Newer edit")["id"] == keep
    assert conn.execute("SELECT count(*) FROM people WHERE merged_into IS NULL").fetchone()[0] == 2


def test_edit_old_merged_uid_keeps_canonical_uid(conn):
    a = create(conn); b = create(conn, card("Other", "+4930123456"))
    ops.apply(conn, "merge", {"person_ids": [a["id"], b["id"]]})
    keep = identity.canonical(conn, b["id"])
    uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (keep,)).fetchone()[0]
    ops.apply(conn, "contact_save", {"contact_uid": b["contact_uid"], "local_id": -1, "card": card("Updated")})
    assert conn.execute("SELECT contact_uid FROM people WHERE id=?", (keep,)).fetchone()[0] == uid


def test_migration_keeps_existing_database_and_reports_loss(tmp_path):
    path = tmp_path / "old.db"
    import sqlite3
    raw = sqlite3.connect(path)
    raw.execute("CREATE TABLE people(id INTEGER PRIMARY KEY,name TEXT NOT NULL,created_at TEXT,merged_into INTEGER)")
    raw.execute("INSERT INTO people VALUES(1,'Old friend','2020',NULL)"); raw.commit(); raw.close()
    conn = db.connect(path)
    uid = conn.execute("SELECT contact_uid FROM people").fetchone()[0]; uuid.UUID(uid)
    assert contacts.migration_report(conn)["legacy_without_originals"][0]["id"] == 1
    conn.close()
    conn = db.connect(path)
    assert conn.execute("SELECT contact_uid FROM people").fetchone()[0] == uid


@pytest.mark.parametrize("data", [{}, {"name": ""}, {"name": "Alex", "fields": "wrong"}, {"name": "Alex", "photo": "broken"}])
def test_reject_invalid_contacts(conn, data):
    with pytest.raises(ops.OpError):
        ops.apply(conn, "contact_save", {"contact_uid": str(uuid.uuid4()), "card": data})
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 0


def test_manual_edits_do_not_resurrect_removed_phone_on_reimport(conn, tmp_path):
    path = tmp_path / "original.vcf"
    path.write_text("BEGIN:VCARD\nFN:Alex\nTEL:+442079460018\nEND:VCARD\n")
    vcard.import_vcards(conn, path)
    row = identity.lookup(conn, "Alex")
    data = json.loads(row["contact_data"])
    data.update(fields=[], user_edited=True)
    ops.apply(conn, "contact_save", {"person_id": row["id"], "contact_uid": row["contact_uid"], "card": data})
    assert identity.find_by_identifier(conn, "phone", "+442079460018") is None
    vcard.import_vcards(conn, path)
    assert json.loads(identity.lookup(conn, "Alex")["contact_data"])["fields"] == []


def test_merge_keeps_original_country_for_local_numbers(conn):
    a = create(conn, card("Alex", "+14155550123"))
    data = card("Other", "030 123456"); data["region"] = "DE"
    b = create(conn, data)
    ops.apply(conn, "merge", {"person_ids": [a["id"], b["id"]]})
    keep = identity.canonical(conn, b["id"])
    merged = json.loads(conn.execute("SELECT contact_data FROM people WHERE id=?", (keep,)).fetchone()[0])
    field = next(f for f in merged["fields"] if f["value"] == "030 123456")
    assert field["region"] == "DE"
    assert identity.find_by_identifier(conn, "phone", "+4930123456") == keep


def test_google_import_retains_labels_addresses_and_source_record(conn):
    from mypeople.importers.gcontacts import import_google_contacts
    raw = {"resourceName": "people/a", "names": [{"displayName": "Alice", "givenName": "Alice", "familyName": "Anders"}],
           "phoneNumbers": [{"value": "+49 (30) 123456", "type": "work", "metadata": {"primary": True}}],
           "addresses": [{"streetAddress": "12 Main Street", "city": "Berlin", "country": "Germany", "type": "home"}],
           "biographies": [{"value": "First note"}, {"value": "Second note"}],
           "urls": [{"value": "https://example.org", "type": "home"}]}
    import_google_contacts(conn, [raw])
    data = json.loads(identity.lookup(conn, "Alice")["contact_data"])
    assert data["family"] == "Anders"
    assert data["notes"] == "First note\nSecond note"
    assert data["fields"][0] == {"kind": "phone", "value": "+49 (30) 123456", "label": "work", "preferred": True}
    assert "12 Main Street\nBerlin\nGermany" in data["fields"][2]["value"]
    assert json.loads(data["source_records"][0]) == raw



def test_distinct_resolves_phone_created_people_by_contact_uid(conn):
    a, b = create(conn, card("Ada")), create(conn, card("Ada", "+44 20 7946 0019"))
    # The phone only knows its own negative ids for contacts it created.
    ops.apply(conn, "distinct", {"person_ids": [-3, -4], "contact_uids": [a["contact_uid"], b["contact_uid"]]})
    assert [tuple(r) for r in conn.execute("SELECT a, b FROM distinct_people")] == [(min(a["id"], b["id"]), max(a["id"], b["id"]))]
