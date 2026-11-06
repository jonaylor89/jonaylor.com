"""A pre-cutover phone must upload its outbox before it can adopt the graph.
Only synthetic temporary databases; never opens a user's database or credentials.
"""
import json
import sqlite3
import uuid
from pathlib import Path

import pytest

from mypeople import db, graph_runtime, replica, transfer
from mypeople.graph import Store

A = "60000000-0000-4000-8000-000000000001"
B = "60000000-0000-4000-8000-000000000002"
PASSWORD = "synthetic-handoff-passphrase"


@pytest.fixture
def handoff(tmp_path):
    path = tmp_path / "synthetic-pre-graph.db"
    old = sqlite3.connect(path)
    old.row_factory = sqlite3.Row
    old.executescript(db.SCHEMA)
    db._migrate(old)
    for uid, name in ((A, "Synthetic A"), (B, "Synthetic B")):
        card = {"name": name, "legacy_unverified": uid == A, "fields": [{"kind": "phone", "value": "+12025550101" if uid == A else "+12025550102"}]}
        old.execute("INSERT INTO people(name,contact_uid,contact_data) VALUES (?,?,?)", (name, uid, json.dumps(card)))
    old.execute("INSERT INTO identifiers(person_id,kind,value,source) VALUES (1,'google','people/synthetic','synthetic')")
    old.execute("INSERT INTO interactions(person_id,at,channel,direction,text,source_ref) VALUES (1,'2020-01-01','sms','in','Synthetic retained message','synthetic:handoff')")
    phone = replica._legacy_capture(old)
    source, _ = transfer._prepare(old)
    old.commit()
    old.close()
    conn = db.connect(path)
    assert graph_runtime.enabled(conn)
    assert set(phone.heads).isdisjoint(Store(conn).load().heads)
    try:
        yield conn, phone, source
    finally:
        conn.close()


def upload(phone, changes, source, **overrides):
    manifest = {"format": 1, "type": "edits", "source": source, "revision": 0,
                "contact_version": 1, "contact_heads": phone.heads, "contact_history": changes,
                "ops": [{"client_id": c["id"], "kind": "contact_change", "payload": c} for c in changes]}
    manifest.update(overrides)
    return manifest, transfer.encrypt(transfer.pack(manifest), PASSWORD)


def test_shared_android_handoff_fixture_contains_receipts_and_complete_graph():
    fixture = Path(__file__).resolve().parents[3] / "android/mypeople/app/src/test/resources/python-legacy-graph-handoff.json"
    data = json.loads(fixture.read_text())
    legacy, reply = data["legacy"], data["reply"]
    assert len(legacy["pending"]) == 6 and "graph" not in legacy
    assert {r["client_id"] for r in reply["results"] if r["status"] == "done"} == {op["client_id"] for op in legacy["pending"]}
    clone = db.connect(":memory:")
    try:
        graph_runtime.receive(clone, reply["graph"])
        card = graph_runtime.cards(Store(clone).load(), clone)[A]["card"]
        assert card["notes"] == "Synthetic phone note 5" and card["favorite"]
        assert clone.execute("SELECT text FROM interactions WHERE source_ref='synthetic:handoff'").fetchone()[0] == "Synthetic retained message"
    finally:
        clone.close()


def test_legacy_frontier_uploads_six_pending_edits_then_receives_full_graph(handoff, tmp_path):
    conn, phone, source = handoff
    changes = []
    for i in range(6):
        c = phone.edit(A, phone.contact(A).card | {"notes": f"Synthetic phone note {i}", "favorite": True})
        changes.append(c)
        phone = replica.History([*phone.changes, c])
    manifest, encrypted = upload(phone, changes, source)
    result = transfer.apply_edits(conn, encrypted, PASSWORD, enrich=False)
    assert result["applied"] == 6 and result["failed"] == 0
    card = graph_runtime.cards(Store(conn).load(), conn)[A]["card"]
    assert card["notes"] == "Synthetic phone note 5" and card["favorite"]
    assert card["legacy_unverified"]
    graph = Store(conn).load()
    assert any(graph.value(obj, "kind") == "google" for obj in graph.objects)
    heads = Store(conn).load().heads
    assert transfer.apply_edits(conn, encrypted, PASSWORD, enrich=False)["already_applied"] == 6
    assert Store(conn).load().heads == heads
    output = tmp_path / "synthetic-cutover.sherloq"
    transfer.export_snapshot(conn, output, PASSWORD, include_photos=False, peer=manifest)
    reply = transfer.unpack(transfer.decrypt(output.read_bytes(), PASSWORD))
    assert reply["graph"]["commits"] and not reply["contact_history"]
    assert {r["client_id"] for r in reply["results"] if r["status"] == "done"} == {c["id"] for c in changes}
    assert conn.execute("SELECT text FROM interactions WHERE source_ref='synthetic:handoff'").fetchone()[0] == "Synthetic retained message"


def test_unknown_legacy_frontier_rejects_atomically_without_native_graph_changes(handoff):
    conn, phone, source = handoff
    change = phone.edit(A, values={"notes": "Must not partially apply"})
    phone = replica.History([*phone.changes, change])
    _, encrypted = upload(phone, [change], source, contact_heads=[str(uuid.uuid4())])
    before = Store(conn).load().commits
    with pytest.raises(transfer.TransferError, match="Unknown contact history head"):
        transfer.apply_edits(conn, encrypted, PASSWORD)
    assert Store(conn).load().commits == before
    assert not conn.execute("SELECT 1 FROM contact_changes WHERE id=?", (change["id"],)).fetchone()
    assert not conn.execute("SELECT 1 FROM transfer_applied WHERE client_id=?", (change["id"],)).fetchone()


def test_legacy_duplicate_add_and_partial_tag_remove_keep_the_native_point(handoff):
    conn, phone, source = handoff
    graph = Store(conn).load()
    point = graph_runtime.cards(graph, conn)[A]["card"]["fields"][0]["object_id"]
    root_tag = next(iter(phone.contact(A).tags["fields"]))
    addition = phone.edit(A, values={"notes": "Synthetic duplicate addition"})
    addition["adds"] = {"fields": [phone.contact(A).card["fields"][0]]}
    phone = replica.History([*phone.changes, addition])
    removal = phone.edit(A, values={"notes": "Synthetic partial tag removal"})
    removal["removes"] = {"fields": [root_tag]}
    phone = replica.History([*phone.changes, removal])
    _, encrypted = upload(phone, [addition, removal], source)
    transfer.apply_edits(conn, encrypted, PASSWORD)
    fields = graph_runtime.cards(Store(conn).load(), conn)[A]["card"]["fields"]
    assert len(fields) == 1 and fields[0]["object_id"] == point
    final = phone.edit(A, phone.contact(A).card | {"fields": []})
    phone = replica.History([*phone.changes, final])
    _, encrypted = upload(phone, [final], source)
    transfer.apply_edits(conn, encrypted, PASSWORD)
    assert not graph_runtime.cards(Store(conn).load(), conn)[A]["card"]["fields"]


def test_unrelated_legacy_edit_does_not_resolve_native_name_conflicts(handoff):
    conn, phone, source = handoff
    graph = Store(conn).load()
    name = next(e["to"] for e in graph.edges.values() if e["type"] == "has_name" and e["from"] == A)
    left = graph.commit(str(uuid.uuid4()), [graph.edit(name, "display", "Synthetic left")])
    right = graph.commit(str(uuid.uuid4()), [graph.edit(name, "display", "Synthetic right")])
    graph_runtime.project(conn, Store(conn).receive([left, right]))
    conn.commit()
    before = Store(conn).load().alternatives(name, "display")
    change = phone.edit(A, values={"favorite": True})
    phone = replica.History([*phone.changes, change])
    _, encrypted = upload(phone, [change], source)
    transfer.apply_edits(conn, encrypted, PASSWORD)
    assert Store(conn).load().alternatives(name, "display") == before


def test_legacy_merge_and_snapshot_import_keep_history_namespaces_separate(handoff, tmp_path):
    conn, phone, source = handoff
    change = phone.edit(A, links=[B], values={"notes": "Synthetic merged note"})
    phone = replica.History([*phone.changes, change])
    manifest, _ = upload(phone, [change], source)
    manifest["type"] = "snapshot"
    path = tmp_path / "synthetic-legacy-snapshot.sherloq"
    path.write_bytes(transfer.encrypt(transfer.pack(manifest), PASSWORD))
    transfer.merge_snapshot(conn, path, PASSWORD)
    assert len(Store(conn).load().components()["groups"]) == 1
    assert graph_runtime.cards(Store(conn).load(), conn)[A]["card"]["notes"] == "Synthetic merged note"


def test_native_graph_unknown_frontier_is_still_rejected(handoff):
    conn, _, source = handoff
    graph = graph_runtime.bundle(conn)
    graph["heads"] = [str(uuid.uuid4())]
    manifest = {"format": 1, "type": "edits", "source": source, "ops": [], "graph": graph}
    before = Store(conn).load().commits
    with pytest.raises(transfer.TransferError, match="Unknown graph frontier"):
        transfer.apply_edits(conn, transfer.encrypt(transfer.pack(manifest), PASSWORD), PASSWORD)
    assert Store(conn).load().commits == before


def test_legacy_field_removal_and_addition_preserve_native_point_identity(handoff):
    conn, phone, source = handoff
    graph = Store(conn).load()
    point = next(e["to"] for e in graph.edges.values() if e["type"] == "has_contact_point" and e["from"] == B)
    keep = phone.contact(B).card
    change = phone.edit(A, phone.contact(A).card | {"fields": [{"kind": "email", "value": "synthetic@example.test"}]})
    phone = replica.History([*phone.changes, change])
    _, encrypted = upload(phone, [change], source)
    transfer.apply_edits(conn, encrypted, PASSWORD)
    cards = graph_runtime.cards(Store(conn).load(), conn)
    assert [(f["kind"], f["value"]) for f in cards[A]["card"]["fields"]] == [("email", "synthetic@example.test")]
    assert cards[B]["card"]["fields"][0]["object_id"] == point
    assert cards[B]["card"]["fields"][0]["value"] == keep["fields"][0]["value"]
