"""Synthetic coverage of streaming archives, bounded AEAD frames and file imports."""
import io
import json
import os
from pathlib import Path
import sqlite3
import struct

import pytest

from mypeople import contacts, db, graph_runtime, relationships, stream_archive, transfer
from mypeople.graph import Store, create_object

PASSWORD = "synthetic-stream-archive-cross-language"
UID = "60000000-0000-4000-8000-000000000001"
RESOURCES = Path(__file__).resolve().parents[3] / "android/mypeople/app/src/test/resources"


def test_chunked_authentication_requires_final_frame_and_rejects_damage():
    plain = bytes(range(256)) * 9000
    output = io.BytesIO()
    stream_archive.encrypt(io.BytesIO(plain), output, PASSWORD)
    encrypted = output.getvalue()
    recovered = io.BytesIO()
    stream_archive.decrypt(io.BytesIO(encrypted), recovered, PASSWORD)
    assert recovered.getvalue() == plain
    damaged = bytearray(encrypted); damaged[100] ^= 1
    for data, password in ((encrypted, "wrong-synthetic-passphrase"), (encrypted[:-20], PASSWORD), (bytes(damaged), PASSWORD), (encrypted + b"x", PASSWORD)):
        with pytest.raises(ValueError):
            stream_archive.decrypt(io.BytesIO(data), io.BytesIO(), password)
    oversized = encrypted[:28] + struct.pack(">I", stream_archive.FRAME + 1)
    with pytest.raises(ValueError):
        stream_archive.decrypt(io.BytesIO(oversized), io.BytesIO(), PASSWORD)


def test_shared_python_archive_is_a_complete_file_backed_graph():
    path = RESOURCES / "python-stream-archive-v2.sherloq"
    with stream_archive.read_memory(path, PASSWORD) as manifest:
        assert isinstance(manifest["graph"]["blobs"], stream_archive.FileBlobs)
        conn = db.connect(":memory:")
        try:
            graph_runtime.receive(conn, manifest["graph"])
            assert graph_runtime.cards(Store(conn).load(), conn)[UID]["card"]["notes"] == "Synthetic phone note 5"
            assert conn.execute("SELECT text FROM interactions WHERE source_ref='synthetic:handoff'").fetchone()[0] == "Synthetic retained message"
        finally:
            conn.close()


def test_streamed_snapshot_clone_and_edit_file_import(conn, tmp_path):
    contacts.save(conn, UID, {"name": "Synthetic streaming", "fields": []})
    conn.commit()
    source, revision = transfer._prepare(conn)
    graph = graph_runtime.bundle(conn)
    snapshot = {"format": 1, "type": "snapshot", "source": source, "revision": revision + 1, "records": [], "ops": [], "graph": graph}
    path = tmp_path / "snapshot.sherloq"
    stream_archive.write_memory(snapshot, path, PASSWORD)
    clone = db.connect(tmp_path / "clone.db")
    try:
        transfer.merge_snapshot(clone, path, PASSWORD)
        edits = snapshot | {"type": "edits", "graph": graph_runtime.bundle(clone)}
        stream_archive.write_memory(edits, path, PASSWORD)
        assert transfer.import_edits(conn, path, PASSWORD)["failed"] == 0
        assert transfer.apply_edits(conn, path.read_bytes(), PASSWORD)["failed"] == 0
    finally:
        clone.close()


def test_read_only_migration_export_refuses_dirty_or_existing_destinations(conn, tmp_path):
    import importlib.util
    script = Path(__file__).resolve().parents[1] / "scripts/export-wifi-migration.py"
    spec = importlib.util.spec_from_file_location("migration_export", script)
    module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
    contacts.save(conn, UID, {"name": "Synthetic readonly", "fields": []})
    pid = conn.execute("SELECT id FROM people WHERE contact_uid=?", (UID,)).fetchone()[0]
    import datetime as dt
    today = dt.date.today()
    for age in (1, 8, 15, 22):
        for direction in ("in", "out"):
            conn.execute("INSERT INTO interactions(person_id,at,channel,direction,text,source_ref) VALUES (?,?,?,?,?,?)",
                         (pid, (today - dt.timedelta(days=age)).isoformat(), "sms", direction, "Synthetic message", f"synthetic-hints:{age}:{direction}"))
    conn.execute("INSERT INTO relationship_overrides(person_id,category,muted) VALUES (?,?,?)", (pid, "friend", 1))
    conn.commit()
    expected = relationships.view_hints(relationships.infer(conn, pid, today))
    assert expected["closeness"] > 0 and expected["days_365"] == 4 and expected["cadence_days"] == 7
    transfer._prepare(conn)
    conn.execute("UPDATE transfer_state SET revision=1"); conn.commit()
    source = tmp_path / "source.db"
    with sqlite3.connect(source) as destination:
        conn.backup(destination)
    key = tmp_path / "synthetic-key"; key.write_text(PASSWORD)
    target = tmp_path / "migration.sherloq"
    before = source.read_bytes()
    assert module.export(source, target, key)["blobs"] >= 0
    assert source.read_bytes() == before
    with stream_archive.read_memory(target, PASSWORD) as manifest:
        person = next(r["data"] for r in manifest["records"] if r["data"]["contact_uid"] == UID)
        assert {key: person[key] for key in expected} == expected
        assert person["category"] == "friend" and person["muted"] is True
        assert "card" not in person and "photo" not in person
    with pytest.raises(ValueError):
        module.export(source, target, key)
    with sqlite3.connect(source) as dirty:
        dirty.execute("INSERT OR IGNORE INTO graph_dirty VALUES ('people', 1)")
    with pytest.raises(ValueError):
        module.export(source, tmp_path / "must-not-exist.sherloq", key)


@pytest.mark.skipif(os.environ.get("MYPEOPLE_STREAM_LOAD") != "1", reason="Explicit synthetic disk-load opt-in")
def test_full_export_exceeds_old_limit_without_base64_expansion(tmp_path):
    conn = db.connect(tmp_path / "synthetic-large-source.db")
    try:
        contacts.save(conn, UID, {"name": "Synthetic large streaming", "fields": []})
        graph = graph_runtime.capture(conn)
        operations = []
        expected = set()
        for n in range(8):
            content = bytes([n]) * (34 * 1024 * 1024)
            digest = Store(conn).put_blob(content)
            expected.add(digest)
            operations.append(create_object("SourceRecord", {"original": {"blob_hash": digest}}))
            conn.commit()
        del content
        Store(conn).receive([graph.commit(Store(conn).peer, operations)])
        conn.commit()
        path = tmp_path / "synthetic-large.sherloq"
        result = transfer.export_snapshot(conn, path, PASSWORD, include_photos=False)
        assert stream_archive.is_streaming(path)
        assert result["bytes"] < 4 * 1024 * 1024
        clone = db.connect(tmp_path / "synthetic-large-clone.db")
        try:
            transfer.merge_snapshot(clone, path, PASSWORD)
            assert {r[0] for r in clone.execute("SELECT hash FROM graph_blobs")} == expected
            assert clone.execute("SELECT sum(length(content)) FROM graph_blobs").fetchone()[0] == 272 * 1024 * 1024
        finally:
            clone.close()
    finally:
        conn.close()
