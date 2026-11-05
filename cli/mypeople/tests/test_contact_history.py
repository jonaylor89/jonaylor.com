"""Causal contact replication. No personal databases, Bluetooth or network required."""
import copy
import json
import random
import uuid
from pathlib import Path

import pytest

from mypeople import contacts, db, identity, replica, transfer

PASSWORD = "synthetic-contact-history-passphrase"
A = "11111111-1111-4111-8111-111111111111"
B = "22222222-2222-4222-8222-222222222222"
C = "33333333-3333-4333-8333-333333333333"


def history():
    h = replica.History()
    create = h.edit(A, {"name": "Ada", "fields": [{"kind": "email", "value": "old@example.test"}]}, trashed=False)
    return replica.History([create])


def test_independent_fields_and_observed_remove_converge():
    base = history()
    card = base.contact(A).card
    mac = base.edit(A, card | {"notes": "Mac note", "fields": []})
    phone = base.edit(A, card | {"organization": "Phone employer", "fields": card["fields"] + [{"kind": "phone", "value": "+4930123456"}]})
    for changes in ([*base.changes, mac, phone], [phone, mac, *base.changes, phone]):
        h = replica.History(changes)
        c = h.contact(A)
        assert c.card["notes"] == "Mac note"
        assert c.card["organization"] == "Phone employer"
        assert [f["value"] for f in c.card["fields"]] == ["+4930123456"]
        assert not c.conflicts


def test_same_field_conflicts_are_retained_until_causal_resolution():
    base = history()
    left = base.edit(A, values={"name": "Ada Left"})
    right = base.edit(A, values={"name": "Ada Right"})
    merged = replica.History([right, *base.changes, left])
    assert {v["value"] for v in merged.contact(A).conflicts["name"]} == {"Ada Left", "Ada Right"}
    resolved = merged.edit(A, values={"name": "Ada Left"})
    final = replica.History([*merged.changes, resolved])
    assert final.contact(A).card["name"] == "Ada Left"
    assert not final.contact(A).conflicts
    # A genuinely new offline edit remains a conflict, even after an earlier resolution.
    late = base.edit(A, values={"name": "Late"})
    assert "name" in replica.History([*final.changes, late]).contact(A).conflicts


def test_concurrent_overlapping_merges_and_edit_of_dropped_identity():
    h = history()
    for uid, name in ((B, "B"), (C, "C")):
        h = replica.History([*h.changes, h.edit(uid, {"name": name}, trashed=False)])
    left = h.edit(A, links=[B], values={"name": "Ada"})
    right = h.edit(B, links=[C], values={"name": "B"})
    edit = h.edit(C, values={"notes": "Edited while offline"})
    expected = None
    for seed in range(10):
        changes = [*h.changes, left, right, edit]
        random.Random(seed).shuffle(changes)
        result = replica.History(changes)
        assert len(result.contacts) == 1
        c = result.contact(A)
        assert c.members == [A, B, C]
        assert c.card["notes"] == "Edited while offline"
        projection = replica.encoded(c.card) + replica.encoded(c.conflicts)
        assert expected in (None, projection)
        expected = projection


def test_trash_vs_edit_preserves_information_and_restore():
    base = history()
    trash = base.edit(A, trashed=True)
    edit = base.edit(A, values={"notes": "Retain me"})
    h = replica.History([*base.changes, trash, edit])
    assert h.contact(A).trashed and h.contact(A).card["notes"] == "Retain me"
    restored = replica.History([*h.changes, h.edit(A, trashed=False)])
    assert not restored.contact(A).trashed
    assert restored.contact(A).card["notes"] == "Retain me"


def test_invalid_histories_and_uuid_reuse_are_rejected():
    base = history()
    c = base.edit(A, values={"notes": "New"})
    collision = copy.deepcopy(c); collision["values"]["notes"] = "Different"
    for changes in ([c], [*base.changes, c, collision], [c | {"parents": [c["id"]]}],
                    [*base.changes, c | {"removes": {"fields": [str(uuid.uuid4()) + ":fields:0"]}}]):
        with pytest.raises(ValueError):
            replica.History(changes)


def test_sql_capture_preserves_local_branch_before_remote_receive(conn):
    contacts.save(conn, A, {"name": "Ada", "notes": "Original"})
    base = replica.capture(conn)
    remote = base.edit(A, values={"notes": "Phone"})
    contacts.save(conn, A, base.contact(A).card | {"notes": "Mac"})
    replica.capture(conn)
    h = replica.receive(conn, [remote])
    assert {v["value"] for v in h.contact(A).conflicts["notes"]} == {"Phone", "Mac"}
    again = replica.capture(conn)
    assert again.changes == h.changes  # materialization must not invent another user edit


def test_sql_merge_is_uuid_based_and_importable_on_another_cli(conn):
    h = history()
    h = replica.History([*h.changes, h.edit(B, {"name": "Ada Duplicate", "fields": [{"kind": "phone", "value": "+4930123456"}]})])
    h = replica.History([*h.changes, h.edit(B, links=[A], values={"name": "Ada"})])
    replica.receive(conn, h.changes)
    row = conn.execute("SELECT * FROM people WHERE merged_into IS NULL").fetchone()
    assert row["contact_uid"] == A
    assert len(json.loads(row["contact_data"])["fields"]) == 2
    other = db.connect(":memory:")
    try:
        identity.create_person(other, "Unrelated")
        replica.receive(other, h.changes)
        assert replica.load(other).contact(A).card == replica.load(conn).contact(A).card
        assert other.execute("SELECT id FROM people WHERE contact_uid=?", (A,)).fetchone()[0] != row["id"]
    finally:
        other.close()


def test_bluetooth_delta_exchanges_only_missing_changes_records_and_photos(conn, tmp_path):
    contacts.save(conn, A, {"name": "Ada"})
    destination = tmp_path / "memory.sherloq"
    transfer.export_snapshot(conn, destination, PASSWORD, include_photos=False)
    first = transfer.unpack(transfer.decrypt(destination.read_bytes(), PASSWORD))
    h = replica.History(first["contact_history"])
    change = h.edit(A, values={"notes": "Phone note"})
    peer = {"format": 1, "type": "edits", "source": first["source"], "revision": first["revision"],
            "publisher": first["publisher"], "contact_version": 1, "contact_history": [change], "contact_heads": [change["id"]],
            "record_hashes": first["record_hashes"], "ops": [{"client_id": change["id"], "kind": "contact_change", "payload": change}]}
    encrypted = transfer.encrypt(transfer.pack(peer), PASSWORD)
    assert transfer.apply_edits(conn, encrypted, PASSWORD)["applied"] == 1
    assert transfer.apply_edits(conn, encrypted, PASSWORD)["already_applied"] == 1
    transfer.export_snapshot(conn, destination, PASSWORD, include_photos=False, peer=peer)
    second = transfer.unpack(transfer.decrypt(destination.read_bytes(), PASSWORD))
    assert second["base_revision"] == first["revision"]
    assert second["contact_history"] == []  # phone already knows its own change
    assert len(second["records"]) == 1
    assert second["records"][0]["data"]["card"]["notes"] == "Phone note"
    assert second["results"][0]["client_id"] == change["id"]
    peer.update(revision=second["revision"], record_hashes=second["record_hashes"])
    transfer.export_snapshot(conn, destination, PASSWORD, include_photos=False, peer=peer)
    third = transfer.unpack(transfer.decrypt(destination.read_bytes(), PASSWORD))
    assert not third["records"] and not third["contact_history"]


def test_invalid_history_bundle_cannot_partially_apply(conn):
    contacts.save(conn, A, {"name": "Ada"}); conn.commit()
    source, _ = transfer._prepare(conn)
    valid = history().changes[0]
    bad = valid | {"id": str(uuid.uuid4()), "parents": [str(uuid.uuid4())]}
    manifest = {"format": 1, "type": "edits", "source": source, "contact_version": 1, "contact_history": [valid, bad], "ops": []}
    with pytest.raises(transfer.TransferError):
        transfer.apply_edits(conn, transfer.encrypt(transfer.pack(manifest), PASSWORD), PASSWORD)
    assert not replica.load(conn).changes
    assert contacts.card_for(conn.execute("SELECT * FROM people").fetchone()) == {"name": "Ada"}


def test_scalar_information_survives_later_identity_creation_and_merge():
    from mypeople.contact_cli import merge
    conn = db.connect(":memory:")
    try:
        replica.change(conn, A, {"name": "Ada", "notes": "Retain this note"})
        replica.change(conn, B, {"name": "Duplicate"})
        result = merge(conn, [A, B], preferred=A)
        assert result.card["notes"] == "Retain this note"
        assert not result.conflicts
        with pytest.raises(ValueError, match="Splitting replicated"):
            contacts.undo_merge(conn, conn.execute("SELECT id FROM people WHERE contact_uid=?", (A,)).fetchone()[0])
    finally:
        conn.close()


def test_cli_clone_diverge_reconcile_and_resolve(tmp_path):
    from mypeople.cli import main
    first, second = tmp_path / "first.db", tmp_path / "second.db"
    key = tmp_path / "key"; key.write_text(PASSWORD)
    memory = tmp_path / "memory.sherloq"
    def cli(database, *args): main(["--db", str(database), *args])
    cli(first, "contact", "create", "Ada", "--add", "email=ada@example.test", "--set", "notes=Original")
    cli(first, "transfer", "export", str(memory), "--password-file", str(key), "--no-photos")
    cli(second, "transfer", "merge", str(memory), "--password-file", str(key))
    cli(first, "contact", "edit", "Ada", "--set", "notes=First CLI")
    cli(second, "contact", "edit", "Ada", "--set", "notes=Second CLI", "--add", "phone=+4930123456")
    cli(second, "transfer", "export", str(memory), "--password-file", str(key), "--no-photos")
    cli(first, "transfer", "merge", str(memory), "--password-file", str(key))
    c = db.connect(first)
    try:
        h = replica.load(c); person = next(iter(h.contacts.values()))
        assert {v["value"] for v in person.conflicts["notes"]} == {"First CLI", "Second CLI"}
        assert len(person.card["fields"]) == 2
        choice = next(v["change"] for v in person.conflicts["notes"] if v["value"] == "First CLI")
    finally: c.close()
    cli(first, "contact", "resolve", "Ada", "notes", choice)
    cli(first, "transfer", "export", str(memory), "--password-file", str(key), "--no-photos")
    cli(second, "transfer", "merge", str(memory), "--password-file", str(key))
    c = db.connect(second)
    try:
        person = next(iter(replica.load(c).contacts.values()))
        assert not person.conflicts and person.card["notes"] == "First CLI"
    finally: c.close()


def test_clone_has_an_independent_publisher_and_cannot_hijack_an_existing_collection(conn, tmp_path):
    contacts.save(conn, A, {"name": "Ada"})
    memory = tmp_path / "memory.sherloq"
    transfer.export_snapshot(conn, memory, PASSWORD, include_photos=False)
    original = transfer.unpack(transfer.decrypt(memory.read_bytes(), PASSWORD))
    clone = db.connect(":memory:")
    try:
        assert transfer.merge_snapshot(clone, memory, PASSWORD) == 1
        transfer.export_snapshot(clone, memory, PASSWORD, include_photos=False)
        copied = transfer.unpack(transfer.decrypt(memory.read_bytes(), PASSWORD))
        assert original["source"] == copied["source"]
        assert original["publisher"] != copied["publisher"]
        assert copied["revision"] == original["revision"]  # valid independent counters
        foreign = db.connect(":memory:")
        try:
            identity.create_person(foreign, "Unrelated"); foreign.commit()
            with pytest.raises(transfer.TransferError, match="different address book"):
                transfer.merge_snapshot(foreign, memory, PASSWORD)
            assert foreign.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 1
        finally: foreign.close()
    finally: clone.close()


def test_legacy_redirects_join_history_and_keep_original_uuid_addresses(conn):
    contacts.save(conn, A, {"name": "Ada", "notes": "Original"})
    contacts.save(conn, B, {"name": "Duplicate", "fields": [{"kind": "email", "value": "ada@example.test"}]})
    rows = {r["contact_uid"]: r["id"] for r in conn.execute("SELECT * FROM people")}
    identity.merge(conn, rows[B], rows[A]); conn.commit()
    h = replica.capture(conn)
    assert h.contact(A).uid == h.contact(B).uid
    assert h.contact(A).members == [A, B]
    assert h.contact(A).card["notes"] == "Original"
    assert h.contact(A).card["fields"][0]["value"] == "ada@example.test"
    assert replica.capture(conn).changes == h.changes


def test_marking_a_shared_contact_as_self_hides_it_without_journaling_future_private_edits(conn, tmp_path):
    from mypeople import publish
    contacts.save(conn, A, {"name": "Public past", "notes": "Previously shared"})
    before = replica.capture(conn)
    conn.execute("UPDATE people SET is_me=1, name='Private self name', contact_data=?", (json.dumps({"name": "Private self name", "notes": "Never shared"}),))
    h = replica.capture(conn)
    assert h.contact(A).is_me
    assert "Never shared" not in replica.encoded(h.changes)
    assert "Private self name" not in replica.encoded(h.changes)
    assert conn.execute("SELECT name FROM people WHERE contact_uid=?", (A,)).fetchone()[0] == "Private self name"
    records, _ = publish.records(conn)
    assert not [r for r in records if r[0] == "person"]
    assert len(h.changes) == len(before.changes) + 1


def test_merge_does_not_turn_absent_fields_into_conflicting_writes(conn):
    from mypeople import contact_cli
    replica.change(conn, A, {"name": "Ada"})
    replica.change(conn, B, {"name": "Duplicate"})
    base = replica.load(conn)
    remote = base.edit(B, values={"organization": "New employer"})
    contact_cli.merge(conn, [A, B], preferred=A)
    h = replica.receive(conn, [remote])
    assert h.contact(A).card["organization"] == "New employer"
    assert not h.contact(A).conflicts


def test_concurrent_cli_writers_serialize_history_and_sql_projection(tmp_path):
    from concurrent.futures import ThreadPoolExecutor
    path = tmp_path / "concurrent.db"
    first = db.connect(path)
    replica.change(first, A, {"name": "Ada"}); first.commit(); first.close()
    def writer(key, value):
        c = db.connect(path)
        try:
            replica.change(c, A, values={key: value}); c.commit()
        finally: c.close()
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(writer, "notes", "Writer one"), pool.submit(writer, "organization", "Writer two")]
        for future in futures: future.result(timeout=10)
    c = db.connect(path)
    try:
        person = replica.load(c).contact(A)
        assert person.card["notes"] == "Writer one" and person.card["organization"] == "Writer two"
        sql = contacts.card_for(c.execute("SELECT * FROM people WHERE contact_uid=?", (A,)).fetchone())
        assert sql == person.card
        assert not person.conflicts
    finally: c.close()


def test_foreign_publisher_cannot_apply_integer_addressed_memory_requests(conn):
    person = identity.create_person(conn, "Ada"); conn.commit()
    source, _ = transfer._prepare(conn)
    manifest = {"format": 1, "type": "edits", "source": source, "publisher": B,
                "ops": [{"client_id": str(uuid.uuid4()), "kind": "event_add", "payload": {"person_id": person, "value": "Wrong database"}}]}
    with pytest.raises(transfer.TransferError, match="original peer"):
        transfer.apply_edits(conn, transfer.encrypt(transfer.pack(manifest), PASSWORD), PASSWORD)
    assert not conn.execute("SELECT 1 FROM events").fetchone()


def test_cached_avatars_and_photo_inventory_avoid_reprocessing_and_resending(tmp_path, monkeypatch):
    import hashlib
    import io
    import zipfile
    image = pytest.importorskip("PIL.Image")
    original = tmp_path / "original.png"
    image.new("RGB", (800, 800), (40, 100, 70)).save(original)
    before = original.read_bytes()
    c = db.connect(tmp_path / "photos.db")
    try:
        pid = contacts.save(c, A, {"name": "Ada"})
        c.execute("INSERT INTO photos(person_id, source, path, width) VALUES (?, 'test', ?, 800)", (pid, str(original))); c.commit()
        memory = tmp_path / "memory.sherloq"
        transfer.export_snapshot(c, memory, PASSWORD, compact_photos=True)
        first = transfer.unpack(transfer.decrypt(memory.read_bytes(), PASSWORD))
        photo = next(r["data"]["photo"] for r in first["records"] if r["kind"] == "person")
        assert (tmp_path / "transfer-avatars" / hashlib.sha256(before).hexdigest()).is_file()
        def no_reprocessing(*args, **kwargs): raise AssertionError("Cached avatars must not be resized again")
        monkeypatch.setattr(image, "open", no_reprocessing)
        peer = {"type": "edits", "source": first["source"], "publisher": first["publisher"], "revision": first["revision"],
                "contact_version": 1, "contact_heads": first["contact_heads"], "record_hashes": first["record_hashes"], "photo_hashes": [photo]}
        result = transfer.export_snapshot(c, memory, PASSWORD, compact_photos=True, peer=peer)
        assert result["photos"] == 0 and result["updated"] == 0 and result["changes"] == 0
        with zipfile.ZipFile(io.BytesIO(transfer.decrypt(memory.read_bytes(), PASSWORD))) as archive:
            assert archive.namelist() == ["manifest.json"]
        assert original.read_bytes() == before
    finally: c.close()


def test_python_jvm_fixture():
    fixture = json.loads((Path(__file__).parents[3] / "android/mypeople/app/src/test/resources/contact-history.json").read_text())
    h = replica.History(fixture["changes"])
    c = h.contact(fixture["uid"])
    assert c.card == fixture["card"]
    assert c.conflicts == fixture["conflicts"]
