"""End-to-end trusted-peer graph transfers through the ordinary app protocol.

All data, including messages and rejected assertions, must survive an install/clone.
These tests use in-memory and tmp_path databases only.
"""
from __future__ import annotations

import copy
import json
import uuid

import pytest

from mypeople import contacts, db, graph_runtime, identity, transfer
from mypeople.graph import Store

PASSWORD = "synthetic-graph-sync-passphrase"
CAMERON = "bb2a4139-9ab4-487b-9434-3a9120a3a288"


def populate(conn):
    contacts.save(conn, CAMERON, {"name": "Cameron", "fields": [
        {"kind": "phone", "value": "+12025550101", "label": "mobile"},
        {"kind": "phone", "value": "+12025550102", "label": "mobile"}], "notes": "Which Cameron? Review this note."})
    pid = conn.execute("SELECT id FROM people WHERE contact_uid=?", (CAMERON,)).fetchone()[0]
    conn.execute("INSERT INTO interactions(person_id,at,channel,direction,text,thread,source_ref) VALUES (?, '2026-01-01T12:00:00+00:00', 'sms', 'in', 'Synthetic message belonging to B', 'phone-b', 'synthetic:cameron-b:1')", (pid,))
    conn.execute("INSERT INTO events(person_id,type,value,confidence,source,status,generation) VALUES (?, 'job', 'Rejected synthetic claim', .5, 'synthetic', 'rejected', 2)", (pid,))
    conn.execute("INSERT INTO relationship_overrides(person_id,category,cadence_days,muted) VALUES (?, 'friend', 30, 1)", (pid,))
    conn.commit()
    return pid


def snapshot(conn, path, peer=None):
    transfer.export_snapshot(conn, path, PASSWORD, include_photos=False, peer=peer)
    return transfer.unpack(transfer.decrypt(path.read_bytes(), PASSWORD))


def test_ordinary_snapshot_clones_raw_messages_retractions_preferences_and_identity(conn, tmp_path):
    populate(conn)
    path = tmp_path / "complete.sherloq"
    manifest = snapshot(conn, path)
    assert manifest["graph"]["commits"]
    clone = db.connect(tmp_path / "clone.db")
    try:
        transfer.merge_snapshot(clone, path, PASSWORD)
        assert clone.execute("SELECT text FROM interactions WHERE source_ref='synthetic:cameron-b:1'").fetchone()[0] == "Synthetic message belonging to B"
        fact = clone.execute("SELECT status FROM events WHERE value='Rejected synthetic claim'").fetchone()
        assert fact and fact[0] == "rejected"
        assert clone.execute("SELECT category, muted FROM relationship_overrides").fetchone()[:] == ("friend", 1)
        assert Store(clone).peer != Store(conn).peer
        assert Store(clone).collection == Store(conn).collection
    finally:
        clone.close()


def test_contact_split_replicates_correct_phone_and_message_without_guessing_note(conn, tmp_path):
    populate(conn)
    graph = graph_runtime.capture(conn)
    phone_b = next(key for key, value in graph.objects.items() if value["type"] == "ContactPoint" and graph.value(key, "value") == "+12025550102")
    message = next(key for key, value in graph.objects.items() if value["type"] == "InteractionBatch" and graph.value(key, "thread") == "phone-b")
    selected = [key for key, edge in graph.edges.items() if graph.active(key) and ((edge["type"] == "has_contact_point" and edge["to"] == phone_b) or (edge["type"] == "participant" and edge["from"] == message and edge["to"] == CAMERON))]
    assert len(selected) == 2
    info = graph_runtime.associations(conn, CAMERON)
    assert set(selected).issubset({row["id"] for row in info["associations"]})
    result = graph_runtime.split(conn, CAMERON, "Cameron B", selected, heads=info["heads"])
    conn.commit()
    assert result["review"]
    assert result["contact_uid"] != CAMERON
    moved = conn.execute("SELECT person_id FROM interactions WHERE source_ref='synthetic:cameron-b:1'").fetchone()[0]
    assert moved == result["person_id"]
    rows = {row["contact_uid"]: json.loads(row["contact_data"]) for row in conn.execute("SELECT * FROM people WHERE merged_into IS NULL")}
    assert [f["value"] for f in rows[CAMERON]["fields"] if f["kind"] == "phone"] == ["+12025550101"]
    assert [f["value"] for f in rows[result["contact_uid"]]["fields"] if f["kind"] == "phone"] == ["+12025550102"]
    assert "Which Cameron?" in rows[CAMERON].get("notes", "")
    path = tmp_path / "split.sherloq"
    snapshot(conn, path)
    clone = db.connect(":memory:")
    try:
        transfer.merge_snapshot(clone, path, PASSWORD)
        owner = clone.execute("SELECT p.contact_uid FROM people p JOIN interactions i ON i.person_id=p.id WHERE i.source_ref='synthetic:cameron-b:1'").fetchone()[0]
        assert owner == result["contact_uid"]
        assert len(Store(clone).load().components()["groups"]) == 2
    finally:
        clone.close()


def test_graph_upload_roundtrip_and_frontier_acknowledgement(conn, tmp_path):
    populate(conn)
    path = tmp_path / "first.sherloq"
    original = snapshot(conn, path)
    clone = db.connect(":memory:")
    try:
        transfer.merge_snapshot(clone, path, PASSWORD)
        person = clone.execute("SELECT id FROM people WHERE contact_uid=?", (CAMERON,)).fetchone()[0]
        clone.execute("INSERT INTO events(person_id,type,value,confidence,source) VALUES (?, 'note', 'Written offline on peer', 1, 'manual')", (person,))
        clone.commit()
        upload = {"format": 1, "type": "edits", "source": original["source"], "revision": original["revision"],
                  "publisher": original["publisher"], "ops": [], "contact_version": 1,
                  "graph": graph_runtime.bundle(clone, original["graph"]["heads"])}
        encrypted = transfer.encrypt(transfer.pack(upload), PASSWORD)
        transfer.apply_edits(conn, encrypted, PASSWORD)
        assert conn.execute("SELECT value FROM events WHERE value='Written offline on peer'").fetchone()
        assert transfer.apply_edits(conn, encrypted, PASSWORD)["failed"] == 0
        reply = snapshot(conn, path, upload)
        # No already acknowledged graph operation should be resent to its own author.
        assert not reply["graph"]["commits"]
    finally:
        clone.close()


def test_malformed_graph_cannot_apply_valid_prefix_or_modify_sql(conn, tmp_path):
    populate(conn)
    graph = graph_runtime.bundle(conn)
    bad = copy.deepcopy(graph)
    bad["commits"][-1]["parents"] = [str(uuid.uuid4())]
    source, revision = transfer._prepare(conn)
    payload = {"format": 1, "type": "edits", "source": source, "revision": revision, "ops": [], "graph": bad}
    before = Store(conn).load().commits
    original_people = conn.execute("SELECT count(*) FROM people").fetchone()[0]
    with pytest.raises(transfer.TransferError):
        transfer.apply_edits(conn, transfer.encrypt(transfer.pack(payload), PASSWORD), PASSWORD)
    assert Store(conn).load().commits == before
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == original_people


def test_legacy_phone_safety_and_hidden_identifiers_survive_editor_and_split(conn):
    from mypeople import replica
    pid = identity.create_person(conn, "Legacy")
    identity.add_identifier(conn, pid, "phone", "2079460018", "synthetic")
    identity.add_identifier(conn, pid, "google", "people/synthetic", "synthetic")
    conn.commit()
    uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (pid,)).fetchone()[0]
    card = replica.load(conn).contact(uid).card
    assert card["legacy_unverified"]
    replica.change(conn, uid, card | {"favorite": True, "user_edited": True})
    conn.commit()
    assert conn.execute("SELECT value FROM identifiers WHERE kind='google'").fetchone()[0] == "people/synthetic"
    selection = graph_runtime.associations(conn, uid)
    edge = next(row["id"] for row in selection["associations"] if row["kind"] == "phone")
    split = graph_runtime.split(conn, uid, "Legacy split", [edge], heads=selection["heads"])
    conn.commit()
    moved = replica.load(conn).contact(split["contact_uid"]).card
    assert moved["legacy_unverified"]
    assert contacts.contact_phone(moved, moved["fields"][0]) == ("", "")
    replica.change(conn, split["contact_uid"], moved | {"legacy_unverified": False, "region": "GB", "user_edited": True})
    conn.commit()
    verified = replica.load(conn).contact(split["contact_uid"]).card
    assert not verified["legacy_unverified"]
    assert contacts.contact_phone(verified, verified["fields"][0])[0] == "+442079460018"
    assert conn.execute("SELECT value FROM identifiers WHERE kind='google'").fetchone()[0] == "people/synthetic"


def test_publishing_reuses_one_graph_projection_instead_of_replaying_per_person(conn, monkeypatch):
    from mypeople import publish
    for n in range(12):
        identity.create_person(conn, f"Synthetic published {n}")
    conn.commit()
    calls = 0
    original = Store.load
    def load(store):
        nonlocal calls
        calls += 1
        return original(store)
    monkeypatch.setattr(Store, "load", load)
    records, _ = publish.records(conn)
    assert len([key for key in records if key[0] == "person"]) == 12
    assert calls < 5  # previously a full immutable-history replay for EACH contact


def test_split_stale_heads_refuses_without_any_changes(conn):
    pid = populate(conn)
    info = graph_runtime.associations(conn, CAMERON)
    selected = [next(row["id"] for row in info["associations"] if row["kind"] == "phone")]
    conn.execute("UPDATE people SET name='Cameron changed' WHERE id=?", (pid,))
    conn.commit()
    before = Store(conn).load().commits
    with pytest.raises(ValueError, match="changed|stale|Reopen|reload"):
        graph_runtime.split(conn, CAMERON, "Other Cameron", selected, heads=info["heads"])
    assert Store(conn).load().commits == before
