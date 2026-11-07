"""The persistent graph index stays equal to a full replay, and partial projections to full ones.

conftest turns on MYPEOPLE_GRAPH_VERIFY, so every index write and partial projection in these
tests is also checked against the reference implementation. Synthetic data only."""
import json
import sqlite3

import pytest

from mypeople import db, graph, graph_index, graph_runtime, ops

UIDS = [f"70000000-0000-4000-8000-{n:012d}" for n in range(1, 5)]


def database(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(db.SCHEMA)
    db._migrate(conn)
    for n, uid in enumerate(UIDS, 1):
        card = {"name": f"Person {n}", "fields": [{"kind": "phone", "value": f"+1202555010{n}"}]}
        conn.execute("INSERT INTO people(name,contact_uid,contact_data) VALUES (?,?,?)", (card["name"], uid, json.dumps(card)))
    conn.commit()
    conn.close()
    conn = db.connect(path)
    graph_runtime.warm(conn)
    return conn


def meta(conn):
    return dict(conn.execute("SELECT key, value FROM graph_index_meta").fetchall())


def test_store_loads_the_index_and_keeps_it_in_step_with_edits(tmp_path):
    conn = database(tmp_path / "people.db")
    assert isinstance(graph.Store(conn).load(), graph_index.IndexedGraph)
    ops.apply(conn, "alias_add", {"person_id": 1, "alias": "Pat"})
    ops.apply(conn, "note", {"person_id": 2, "text": "Synthetic note"})
    assert int(meta(conn)["commits"]) == conn.execute("SELECT COUNT(*) FROM graph_commits").fetchone()[0]
    graph_index.verify(conn)


def test_commits_written_without_the_index_are_caught_up(tmp_path):
    path = tmp_path / "people.db"
    conn = database(path)
    before = meta(conn)
    # An older CLI appends commits and never touches the index tables.
    store = graph.Store(conn)
    older = store.replay()
    names = [e["to"] for e in older.edges.values() if e["type"] == "has_name" and e["from"] == UIDS[0]]
    commit = older.commit(store.peer, [older.edit(names[0], "display", "Renamed elsewhere")], store.collection)
    conn.execute("INSERT INTO graph_commits(id,data) VALUES (?,?)", (commit["id"], json.dumps(commit)))
    conn.commit()
    loaded = graph.Store(conn).load()
    assert isinstance(loaded, graph_index.IndexedGraph)
    assert meta(conn)["epoch"] == before["epoch"]  # applied incrementally, not rebuilt
    assert commit["id"] in loaded.heads and loaded.value(names[0], "display") == "Renamed elsewhere"
    graph_index.verify(conn)


def test_an_index_in_another_format_is_rebuilt(tmp_path):
    conn = database(tmp_path / "people.db")
    epoch = meta(conn)["epoch"]
    conn.execute("UPDATE graph_index_meta SET value='0' WHERE key='format'")
    conn.commit()
    assert isinstance(graph.Store(conn).load(), graph_index.IndexedGraph)
    assert meta(conn)["format"] == str(graph_index.FORMAT) and meta(conn)["epoch"] != epoch
    assert graph_index.projected(conn) is None  # SQL rows get one full projection again
    graph_index.verify(conn)


def test_a_graph_read_before_another_write_keeps_its_own_view(tmp_path):
    conn = database(tmp_path / "people.db")
    earlier = graph.Store(conn).load()
    heads = list(earlier.heads)
    ops.apply(conn, "alias_add", {"person_id": 1, "alias": "Later alias"})
    assert earlier.heads == heads
    assert graph.Store(conn).load().heads != heads


def test_partial_projection_matches_a_full_one_across_merges_and_shared_identifiers(tmp_path, monkeypatch):
    conn = database(tmp_path / "people.db")
    scoped = []
    partial = graph_runtime._project_scope
    monkeypatch.setattr(graph_runtime, "_project_scope", lambda *a: (scoped.append(1), partial(*a))[1])
    # Merge and distinct project; plain SQL edits are captured and projected by the next one.
    ops.apply(conn, "merge", {"person_ids": [1, 2]})
    ops.apply(conn, "alias_add", {"person_id": 3, "alias": "Shared"})
    ops.apply(conn, "merge", {"person_ids": [3, 4]})
    # Each partial projection was compared with a full one (rolled back).
    assert len(scoped) >= 2 and graph_index.projected(conn) == graph_index.IndexedGraph(conn).seq
    state = graph_runtime._projection_state(conn)
    graph_runtime._project_all(conn, graph.Store(conn).load())
    assert graph_runtime._projection_state(conn) == state


def test_an_unwritable_index_falls_back_to_a_replay(tmp_path):
    path = tmp_path / "people.db"
    database(path).close()
    with sqlite3.connect(path) as conn:
        conn.execute("DELETE FROM graph_index_meta")
    reader = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    reader.row_factory = sqlite3.Row
    loaded = graph.Store(reader).load()
    assert type(loaded) is graph.Graph and loaded.heads
