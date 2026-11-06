"""Synthetic batching, provenance, bounded graph size and incremental projection."""
import base64
import json
import sqlite3

import pytest

from mypeople import db, graph_interactions as batches, graph_runtime as runtime
from mypeople.graph import GraphError, Store, create_edge, create_object, transaction, uid


def legacy(tmp_path, counts=(513, 11)):
    path = tmp_path / "synthetic.db"
    c = sqlite3.connect(path)
    c.row_factory = sqlite3.Row
    c.executescript(db.SCHEMA)
    db._migrate(c)
    owners = []
    for n, count in enumerate(counts, 1):
        owner = uid()
        owners.append(owner)
        c.execute("INSERT INTO people(id,name,contact_uid) VALUES (?,?,?)", (n, f"Synthetic {n}", owner))
        c.executemany("""INSERT INTO interactions(person_id,at,channel,direction,text,thread,source_ref,extracted)
            VALUES (?,?,?,?,?,?,?,?)""", ((n, f"2026-01-{i % 28 + 1:02d}T12:00:00Z", "sms", "in" if i % 2 else "out",
                f"Raw unicode ✓ record {n}/{i}", "shared thread", f"source:{n}:{i}", i % 2) for i in range(count)))
    c.commit()
    c.close()
    return path, owners


def payloads(conn, graph):
    for obj, kind in graph.objects.items():
        if kind["type"] == "InteractionBatch":
            digest = graph.value(obj, "content")["blob_hash"]
            content = conn.execute("SELECT content FROM graph_blobs WHERE hash=?", (digest,)).fetchone()[0]
            yield obj, batches._read(conn, digest), digest


def test_migration_is_bounded_lossless_and_owner_grouped(tmp_path):
    path, owners = legacy(tmp_path)
    c = db.connect(path)
    graph = Store(c).load()
    chunks = list(payloads(c, graph))
    assert len(chunks) == 4  # ceil(513/256) + ceil(11/256)
    assert not any(p["type"] == "Interaction" for p in graph.objects.values())
    all_rows = [row for _, rows, _ in chunks for row in rows]
    assert len(all_rows) == 524
    assert len({row["source_ref"] for row in all_rows}) == 524
    for obj, rows, digest in chunks:
        assert 1 <= len(rows) <= 256
        assert graph.value(obj, "count") == len(rows)
        owner = graph.value(obj, "original_owner")
        assert owner in owners
        expected_prefix = f"source:{owners.index(owner) + 1}:"
        assert all(row["source_ref"].startswith(expected_prefix) for row in rows)
        assert all("id" not in row and "person_id" not in row for row in rows)
        assert all(set(row) == {"at", "channel", "direction", "text", "thread", "source_ref", "extracted"} for row in rows)
        assert graph.value(obj, "channel") == "sms"
        assert graph.value(obj, "thread") == "shared thread"
        assert graph.value(obj, "first_at") == min(row["at"] for row in rows)
        assert graph.value(obj, "last_at") == max(row["at"] for row in rows)
        assert "messages" in batches.batch_label({"count": len(rows), "channel": "sms"})
        assert all("Raw unicode ✓" in row["text"] for row in rows)
    # No per-message provenance objects: source evidence is the bounded blob.
    assert len(graph.objects) < 50
    assert len(json.dumps(runtime.bundle(c))) < 350_000
    c.close()


def test_clone_split_keeps_every_record_and_local_ids(tmp_path):
    path, owners = legacy(tmp_path)
    c = db.connect(path)
    clone = db.connect(":memory:")
    runtime.receive(clone, runtime.bundle(c))
    clone.commit()
    before = {r["source_ref"]: r["id"] for r in clone.execute("SELECT * FROM interactions")}
    assert len(before) == 524
    available = runtime.associations(clone, owners[0])["associations"]
    selected = next(r for r in available if r["kind"] == "message")
    obj = selected["object_id"]
    count = Store(clone).load().value(obj, "count")
    original_blob = Store(clone).load().value(obj, "content")
    result = runtime.split(clone, owners[0], "Explicit attribution", [selected["id"]])
    assert clone.execute("SELECT COUNT(*) FROM interactions WHERE person_id=?", (result["person_id"],)).fetchone()[0] == count
    after = {r["source_ref"]: r["id"] for r in clone.execute("SELECT * FROM interactions")}
    assert after == before
    assert Store(clone).load().value(obj, "content") == original_blob
    assert Store(clone).load().value(obj, "original_owner") == owners[0]
    assert clone.execute("SELECT COUNT(*) FROM interactions").fetchone()[0] == 524
    c.close()
    clone.close()


def test_flags_revise_only_one_batch_and_preserve_history(tmp_path):
    path, owners = legacy(tmp_path)
    c = db.connect(path)
    graph = Store(c).load()
    blobs_before = {obj: digest for obj, _, digest in payloads(c, graph)}
    ops_before = len(graph.operations)
    ids = dict(c.execute("SELECT source_ref,id FROM interactions"))
    c.execute("UPDATE interactions SET extracted=1,text='Edited raw text' WHERE source_ref='source:1:0'")
    c.commit()
    graph = Store(c).load()
    blobs_after = {obj: digest for obj, _, digest in payloads(c, graph)}
    changed = [obj for obj in blobs_before if blobs_before[obj] != blobs_after[obj]]
    assert len(changed) == 1
    assert len(graph.operations) - ops_before == 1  # one content register
    assert c.execute("SELECT 1 FROM graph_blobs WHERE hash=?", (blobs_before[changed[0]],)).fetchone()
    assert dict(c.execute("SELECT source_ref,id FROM interactions")) == ids
    clone = db.connect(":memory:")
    runtime.receive(clone, runtime.bundle(c))
    row = clone.execute("SELECT extracted,text FROM interactions WHERE source_ref='source:1:0'").fetchone()
    assert tuple(row) == (1, "Edited raw text")
    assert clone.execute("SELECT COUNT(*) FROM interactions").fetchone()[0] == 524
    clone.close()
    c.close()


def test_card_projection_does_not_write_or_decode_unchanged_messages(tmp_path, monkeypatch):
    path, _ = legacy(tmp_path)
    c = db.connect(path)
    sql = []
    c.set_trace_callback(sql.append)
    def forbidden(*args):
        raise AssertionError("unchanged batch must not be decoded")
    monkeypatch.setattr(batches, "_read", forbidden)
    c.execute("UPDATE people SET name='Card edit' WHERE id=1")
    c.commit()
    runtime.project(c)
    writes = [s for s in sql if s.lstrip().upper().startswith(("INSERT INTO INTERACTIONS", "UPDATE INTERACTIONS", "DELETE FROM INTERACTIONS"))]
    assert writes == []
    assert c.execute("SELECT COUNT(*) FROM interactions").fetchone()[0] == 524
    c.close()


def test_deletes_and_reused_ids_do_not_resurrect_old_records(tmp_path):
    path, _ = legacy(tmp_path, (3,))
    c = db.connect(path)
    rowid = c.execute("SELECT id FROM interactions WHERE source_ref='source:1:0'").fetchone()[0]
    c.execute("DELETE FROM interactions WHERE id=?", (rowid,))
    c.execute("""INSERT INTO interactions(id,person_id,at,channel,direction,text,thread,source_ref)
        VALUES (?,1,'2026-02-01','email','out','Replacement','other','replacement')""", (rowid,))
    c.commit()
    clone = db.connect(":memory:")
    runtime.receive(clone, runtime.bundle(c))
    assert {r[0] for r in clone.execute("SELECT source_ref FROM interactions")} == {"source:1:1", "source:1:2", "replacement"}
    clone.close()
    c.close()


def test_legacy_single_and_individual_override_are_compatible(tmp_path):
    path, owners = legacy(tmp_path, (3,))
    c = db.connect(path)
    store = Store(c)
    single = create_object("Interaction", {"source_ref": "source:1:0", "at": "2026-02-01", "channel": "sms", "direction": "in", "text": "Explicit override", "extracted": 1})
    edge = create_edge("participant", single["target"], owners[0])
    store.write([single, edge])
    runtime.project(c)
    assert c.execute("SELECT text FROM interactions WHERE source_ref='source:1:0'").fetchone()[0] == "Explicit override"
    assert c.execute("SELECT COUNT(*) FROM interactions").fetchone()[0] == 3
    local = c.execute("SELECT id FROM interactions WHERE source_ref='source:1:0'").fetchone()[0]
    c.execute("UPDATE interactions SET extracted=0 WHERE id=?", (local,))
    c.commit()
    assert Store(c).load().value(single["target"], "extracted") == 0
    graph = Store(c).load()
    store.write([graph.edit(edge["target"], "_lifecycle", "retracted")])
    runtime.project(c)
    assert c.execute("SELECT text FROM interactions WHERE source_ref='source:1:0'").fetchone()[0] == "Raw unicode ✓ record 1/0"
    c.close()


def test_invalid_batch_receive_rolls_back_graph_blobs_and_sql(tmp_path):
    path, owners = legacy(tmp_path, (3,))
    source = db.connect(path)
    data = runtime.bundle(source)
    # Blob bytes and commit agree on digest, but the record count lies.
    for commit in data["commits"]:
        for op in commit["operations"]:
            if op["kind"] == "create_object" and op["payload"]["type"] == "InteractionBatch":
                op["payload"]["properties"]["count"] = 255
    clone = db.connect(":memory:")
    clone.commit()
    with pytest.raises(GraphError, match="metadata"):
        runtime.receive(clone, data)
    assert clone.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 0
    assert clone.execute("SELECT COUNT(*) FROM graph_commits").fetchone()[0] == 0
    assert clone.execute("SELECT COUNT(*) FROM graph_blobs").fetchone()[0] == 0
    clone.close()
    source.close()


def test_capture_and_mapping_rollback_together(tmp_path):
    path, _ = legacy(tmp_path, (3,))
    c = db.connect(path)
    old = runtime.bundle(c)
    with pytest.raises(RuntimeError):
        with transaction(c):
            c.execute("UPDATE interactions SET text='Never committed' WHERE source_ref='source:1:0'")
            runtime.capture(c)
            raise RuntimeError("abort synthetic edit")
    assert runtime.bundle(c) == old
    assert c.execute("SELECT text FROM interactions WHERE source_ref='source:1:0'").fetchone()[0] == "Raw unicode ✓ record 1/0"
    c.close()
