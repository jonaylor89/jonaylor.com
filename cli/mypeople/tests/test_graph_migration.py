import hashlib
import json
import sqlite3

import pytest

from mypeople import db
from mypeople.graph import GraphError, Store, create_edge, create_object
from mypeople.graph_migration import migrate
from mypeople.graph_transfer import export_graph, import_graph
from mypeople.transfer import TransferError, decrypt, encrypt

PASSWORD = "synthetic-test-passphrase"


def legacy(tmp_path):
    path = tmp_path / "legacy.db"
    c = db.connect(path)
    card = {"name": "Cameron", "fields": [{"kind": "phone", "value": "+12025550101"}, {"kind": "phone", "value": "+12025550102"}], "notes": "Ambiguous original note", "favorite": True}
    p = c.execute("INSERT INTO people(name,contact_uid,contact_data) VALUES ('Cameron', ?, ?)", ("d8c91f62-758b-4cdf-9d6a-2def8a24b745", json.dumps(card))).lastrowid
    c.execute("INSERT INTO interactions(person_id,at,channel,direction,text,thread,source_ref) VALUES (?, '2025-01-01', 'sms', 'in', 'Synthetic message B', 'phone-b', 'test:1')", (p,))
    c.execute("INSERT INTO events(person_id,type,value,confidence,source,evidence) VALUES (?, 'job', 'Engineer', .9, 'test', 'Synthetic message B')", (p,))
    c.commit()
    c.close()
    return path


def test_readonly_migration_preserves_all_data_and_supports_split(tmp_path):
    path = legacy(tmp_path)
    before = hashlib.sha256(path.read_bytes()).hexdigest()
    dest = sqlite3.connect(tmp_path / "graph.db")
    store = Store(dest)
    source = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    report = migrate(source, store)
    assert report["people"] == 1
    assert "lost" in report["warning"]
    assert hashlib.sha256(path.read_bytes()).hexdigest() == before
    graph = store.load()
    person = next(key for key, value in graph.objects.items() if value["type"] == "Person")
    phone = next(key for key, value in graph.objects.items() if value["type"] == "ContactPoint" and graph.value(key, "value").endswith("102"))
    message = next(key for key, value in graph.objects.items() if value["type"] == "Interaction")
    selected = [key for key, edge in graph.edges.items() if (edge["type"] == "has_contact_point" and edge["to"] == phone) or (edge["type"] == "participant" and edge["from"] == message)]
    split = store.split(person, "Cameron B", selected)
    assert split["review"]  # name, note, claim, and phone A still need human review
    assert store.load().value(message, "text") == "Synthetic message B"
    originals = [json.loads(row[0]) for row in dest.execute("SELECT content FROM graph_blobs")]
    assert any(value.get("source_ref") == "test:1" for value in originals)
    with pytest.raises(GraphError, match="empty"):
        migrate(source, store)
    source.close()
    dest.close()


def test_missing_photo_rolls_back_entire_migration(tmp_path):
    path = legacy(tmp_path)
    c = db.connect(path)
    c.execute("INSERT INTO photos(person_id,source,path) SELECT id,'test',? FROM people", (str(tmp_path / "missing.png"),))
    c.commit()
    c.close()
    source = sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)
    dest = sqlite3.connect(":memory:")
    store = Store(dest)
    with pytest.raises(GraphError, match="missing"):
        migrate(source, store)
    assert not store.load().commits
    assert dest.execute("SELECT count(*) FROM graph_blobs").fetchone()[0] == 0
    source.close()
    dest.close()


def test_full_archive_clone_diverge_reconcile_retry_and_authentication(tmp_path):
    a, b = sqlite3.connect(":memory:"), sqlite3.connect(":memory:")
    first, second = Store(a), Store(b)
    content = b"complete raw message payload, not a thumbnail or phone-safe view"
    digest = first.put_blob(content)
    person = create_object("Person")
    message = create_object("Interaction", {"body": {"blob_hash": digest}})
    first.write([person, message, create_edge("participant", message["target"], person["target"])])
    archive = tmp_path / "memory.graph"
    export_graph(first, archive, PASSWORD)
    with pytest.raises(TransferError, match="passphrase"):
        import_graph(second, archive, "incorrect-passphrase", adopt=True)
    assert not second.load().commits
    import_graph(second, archive, PASSWORD, adopt=True)
    assert first.peer != second.peer
    assert second.collection == first.collection
    assert second.conn.execute("SELECT content FROM graph_blobs WHERE hash=?", (digest,)).fetchone()[0] == content
    first.write([first.load().edit(person["target"], "label", "First")])
    second.write([second.load().edit(person["target"], "label", "Second")])
    export_graph(first, archive, PASSWORD)
    import_graph(second, archive, PASSWORD)
    assert second.load().conflicted(person["target"], "label")
    export_graph(second, archive, PASSWORD)
    import_graph(first, archive, PASSWORD)
    assert first.load().commits == second.load().commits
    assert import_graph(first, archive, PASSWORD)["added"] == 0
    a.close()
    b.close()


def test_export_refuses_overwriting_database_or_omitting_missing_blob(tmp_path):
    path = tmp_path / "graph.db"
    conn = sqlite3.connect(path)
    store = Store(conn)
    digest = store.put_blob(b"original")
    store.write([create_object("Asset", {"content": {"blob_hash": digest}})])
    with pytest.raises(GraphError, match="overwrite"):
        export_graph(store, path, PASSWORD)
    assert store.load().commits
    conn.execute("DELETE FROM graph_blobs")
    archive = tmp_path / "incomplete.graph"
    with pytest.raises(GraphError, match="Missing referenced"):
        export_graph(store, archive, PASSWORD)
    assert not archive.exists()
    conn.close()


def test_damaged_blob_rejected_before_any_state_is_changed(tmp_path):
    import io
    import zipfile
    a, b = sqlite3.connect(":memory:"), sqlite3.connect(":memory:")
    first, second = Store(a), Store(b)
    digest = first.put_blob(b"original")
    first.write([create_object("Asset", {"content": {"blob_hash": digest}})])
    archive = tmp_path / "memory.graph"
    export_graph(first, archive, PASSWORD)
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(decrypt(archive.read_bytes(), PASSWORD))) as old, zipfile.ZipFile(output, "w") as new:
        for name in old.namelist():
            new.writestr(name, b"changed" if name.startswith("blobs/") else old.read(name))
    archive.write_bytes(encrypt(output.getvalue(), PASSWORD))
    with pytest.raises(GraphError, match="hash"):
        import_graph(second, archive, PASSWORD, adopt=True)
    assert not second.load().commits
    assert b.execute("SELECT count(*) FROM graph_blobs").fetchone()[0] == 0
    a.close()
    b.close()


@pytest.mark.parametrize("problem", ["path", "missing_blob", "frontier", "duplicate"])
def test_invalid_archive_is_atomic(tmp_path, problem):
    import io
    import zipfile
    a, b = sqlite3.connect(":memory:"), sqlite3.connect(":memory:")
    first, second = Store(a), Store(b)
    digest = first.put_blob(b"original")
    first.write([create_object("Asset", {"content": {"blob_hash": digest}})])
    archive = tmp_path / "memory.graph"
    export_graph(first, archive, PASSWORD)
    output = io.BytesIO()
    with zipfile.ZipFile(io.BytesIO(decrypt(archive.read_bytes(), PASSWORD))) as old, zipfile.ZipFile(output, "w") as new:
        for name in old.namelist():
            content = old.read(name)
            if problem == "missing_blob" and name.startswith("blobs/"):
                continue
            if problem == "frontier" and name == "graph.json":
                manifest = json.loads(content)
                manifest["heads"] = []
                content = json.dumps(manifest).encode()
            new.writestr(name, content)
        if problem == "path":
            new.writestr("../outside", b"unsafe")
        if problem == "duplicate":
            with pytest.warns(UserWarning):
                new.writestr("graph.json", old.read("graph.json"))
    archive.write_bytes(encrypt(output.getvalue(), PASSWORD))
    collection = second.collection
    with pytest.raises(GraphError):
        import_graph(second, archive, PASSWORD, adopt=True)
    assert second.collection == collection
    assert not second.load().commits
    assert b.execute("SELECT count(*) FROM graph_blobs").fetchone()[0] == 0
    a.close()
    b.close()


def test_graph_cli_does_not_open_default_db(tmp_path, monkeypatch, capsys):
    from mypeople.cli import main
    monkeypatch.setenv("MYPEOPLE_DB", str(tmp_path / "must-not-exist.db"))
    path = tmp_path / "graph.db"
    main(["graph", "--store", str(path), "init"])
    assert json.loads(capsys.readouterr().out)["collection"]
    main(["graph", "--store", str(path), "create", "Person"])
    assert json.loads(capsys.readouterr().out)["object"]
    assert not (tmp_path / "must-not-exist.db").exists()


def test_graph_cli_refuses_live_legacy_path(tmp_path):
    from mypeople.cli import main
    path = legacy(tmp_path)
    before = path.read_bytes()
    with pytest.raises(SystemExit, match="legacy app database"):
        main(["graph", "--store", str(path), "init"])
    assert path.read_bytes() == before
