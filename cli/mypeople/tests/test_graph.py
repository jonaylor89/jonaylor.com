"""Synthetic graph contract and two-Cameron regression; never reads personal storage."""
import copy
import hashlib
import itertools
import json
from pathlib import Path

import pytest

from mypeople import db
from mypeople.graph import Graph, GraphError, Store, create_edge, create_object, uid


def seed():
    person = create_object("Person")
    name = create_object("Name", {"display": "Cameron"})
    phone_a = create_object("ContactPoint", {"kind": "phone", "value": "+12025550101", "label": "mobile"})
    phone_b = create_object("ContactPoint", {"kind": "phone", "value": "+12025550102", "label": "mobile"})
    message = create_object("Interaction", {"body": "Synthetic hello", "source_ref": "test:phone-b:1"})
    note = create_object("Note", {"body": "Not sure which Cameron"})
    source = create_object("SourceRecord", {"system": "test", "original": "phone-b"})
    edges = [create_edge("has_name", person["target"], name["target"]),
             create_edge("has_contact_point", person["target"], phone_a["target"]),
             create_edge("has_contact_point", person["target"], phone_b["target"]),
             create_edge("participant", message["target"], person["target"], {"role": "sender"}),
             create_edge("has_note", person["target"], note["target"]),
             create_edge("originated_from", message["target"], source["target"])]
    commit = Graph().commit(uid(), [person, name, phone_a, phone_b, message, note, source, *edges])
    return Graph([commit]), person["target"], phone_a["target"], phone_b["target"], message["target"], edges


def test_shared_android_fixture():
    fixture = Path(__file__).resolve().parents[3] / "android/mypeople/app/src/test/resources/versioned-graph.json"
    data = json.loads(fixture.read_text())
    expected = data["expect"]
    for order in itertools.permutations(data["commits"]):
        graph = Graph(order)
        assert graph.conflicted(expected["phone"], "label")
        assert sorted(v["value"] for v in graph.alternatives(expected["phone"], "label")) == expected["label_values"]
        plan = graph.split(expected["person"], "Cameron B", expected["move"])
        assert plan["review"] == expected["review"]
        commit = graph.commit(uid(), plan["operations"])
        split = Graph([*order, commit])
        assert len(split.components()["groups"]) == 2
        assert not any(split.active(key) for key in expected["move"])


def test_split_two_camerons_preserves_source_and_requires_explicit_attribution():
    g, person, a, b, message, edges = seed()
    original = copy.deepcopy(g.commits)
    moved = [edges[2]["target"], edges[3]["target"]]
    plan = g.split(person, "Cameron B", moved)
    c = g.commit(uid(), plan["operations"])
    result = Graph([*g.commits.values(), c])
    assert result.commits | original == result.commits
    assert len(result.objects) == len(g.objects) + 2
    assert all(not result.active(key) for key in moved)
    assert any(e["from"] == plan["person"] and e["to"] == b and result.active(key) for key, e in result.edges.items())
    assert result.active(edges[1]["target"])  # phone A remains attached to A
    assert result.active(edges[5]["target"])  # original provenance is untouched
    assert edges[4]["target"] in plan["review"]  # ambiguous note not silently guessed
    assert result.value(message, "body") == "Synthetic hello"
    assert len(result.components()["groups"]) == 2
    for order in (list(result.commits.values()), list(reversed(list(result.commits.values())))):
        assert Graph(order).edges == result.edges


def test_concurrent_properties_and_explicit_resolution():
    g, _, phone, *_ = seed()
    a = g.commit(uid(), [g.edit(phone, "label", "home")])
    b = g.commit(uid(), [g.edit(phone, "label", "work"), g.edit(phone, "region", "US")])
    for order in itertools.permutations([*g.commits.values(), a, b]):
        joined = Graph(order)
        assert joined.conflicted(phone, "label")
        assert joined.value(phone, "region") == "US"
        resolution = joined.commit(uid(), [joined.edit(phone, "label", "mobile")])
        resolved = Graph([*order, resolution])
        assert not resolved.conflicted(phone, "label")
        assert resolved.value(phone, "label") == "mobile"


def test_unrelated_edit_does_not_resolve_conflict_and_stale_edit_only_replaces_seen_versions():
    g, _, phone, *_ = seed()
    a = g.commit(uid(), [g.edit(phone, "label", "home")])
    b = g.commit(uid(), [g.edit(phone, "label", "work")])
    branch = Graph([*g.commits.values(), a])
    later = branch.commit(uid(), [branch.edit(phone, "label", "personal")])
    joined = Graph([*g.commits.values(), b, later, a])
    c = joined.commit(uid(), [joined.edit(phone, "region", "GB")])
    assert Graph([*joined.commits.values(), c]).conflicted(phone, "label")
    assert {x["value"] for x in joined.alternatives(phone, "label")} == {"personal", "work"}


def test_lifecycle_conflicts_are_not_exportable():
    g, person, *_ = seed()
    trash = g.commit(uid(), [g.edit(person, "_lifecycle", "trashed")])
    keep = g.commit(uid(), [g.edit(person, "_lifecycle", "active")])
    joined = Graph([*g.commits.values(), trash, keep])
    assert joined.conflicted(person, "_lifecycle")
    assert not joined.active(person)


def test_concurrent_deletion_and_edit_is_explicit_and_keeps_both():
    g, person, *_ = seed()
    deletion = g.commit(uid(), [g.edit(person, "_lifecycle", "trashed")])
    edit = g.commit(uid(), [g.edit(person, "label", "Corrected Cameron")])
    joined = Graph([*g.commits.values(), deletion, edit])
    assert len(joined.entity(person)["conflicts"]["_deletion"]) == 2
    assert joined.value(person, "label") == "Corrected Cameron"
    assert not joined.active(person)
    restore = joined.commit(uid(), [joined.edit(person, "_lifecycle", "active")])
    assert not Graph([*joined.commits.values(), restore]).deletion_conflicts(person)


def test_adoption_is_rolled_back_with_outer_transaction(conn):
    store = Store(conn)
    original = store.collection
    conn.commit()
    conn.execute("BEGIN")
    g, *_ = seed()
    store.receive(list(g.commits.values()), adopt=True)
    conn.rollback()
    assert store.collection == original
    assert not store.load().commits


def test_retracting_identity_link_is_not_a_destructive_merge():
    a, b, c = [create_object("Person") for _ in range(3)]
    ab = create_edge("same_person", a["target"], b["target"])
    bc = create_edge("same_person", b["target"], c["target"])
    ac = create_edge("distinct_person", a["target"], c["target"])
    base = Graph().commit(uid(), [a, b, c, ab, bc, ac])
    g = Graph([base])
    assert len(g.components()["groups"]) == 1
    assert g.components()["contradictions"] == [ac["target"]]
    retract = g.commit(uid(), [g.edit(ab["target"], "_lifecycle", "retracted")])
    split = Graph([base, retract])
    assert len(split.components()["groups"]) == 2
    assert not split.components()["contradictions"]
    assert len(split.objects) == 3


def test_rejects_unobserved_creation_replacements_and_wrong_endpoint():
    g, person, phone, *_ = seed()
    branch = g.commit(uid(), [g.edit(phone, "label", "home")])
    forged = g.commit(uid(), [g.edit(phone, "label", "stolen", replaces=[branch["operations"][0]["id"]])])
    with pytest.raises(GraphError, match="unobserved"):
        Graph([*g.commits.values(), branch, forged])
    wrong = g.commit(uid(), [create_edge("same_person", person, phone)])
    with pytest.raises(GraphError, match="endpoint"):
        Graph([*g.commits.values(), wrong])
    replacement = g.commit(uid(), [g.edit(person, "name", "X", replaces=[next(iter(g.operations))])])
    with pytest.raises(GraphError, match="another property"):
        Graph([*g.commits.values(), replacement])
    unobserved = Graph().commit(uid(), [create_edge("has_contact_point", person, phone)], g.collection)
    with pytest.raises(GraphError, match="unobserved"):
        Graph([*g.commits.values(), unobserved])


def test_rejects_cycles_missing_parents_and_uuid_reuse():
    g, *_ = seed()
    c = next(iter(g.commits.values()))
    bad = copy.deepcopy(c)
    bad["parents"] = [bad["id"]]
    with pytest.raises(GraphError, match="Cyclic"):
        Graph([bad])
    bad["parents"] = [uid()]
    with pytest.raises(GraphError, match="Missing"):
        Graph([bad])
    bad = copy.deepcopy(c)
    bad["recorded_at"] = "2025-01-01T00:00:00+00:00"
    with pytest.raises(GraphError, match="reused"):
        Graph([c, bad])
    assert Graph([c, c]).commits == g.commits


def test_store_atomic_receive_retry_and_outer_rollback(conn):
    store = Store(conn)
    person = create_object("Person")
    commit = store.write([person])
    assert store.receive([commit]).objects == store.load().objects
    before = store.load().commits
    invalid = store.load().commit(store.peer, [create_edge("same_person", person["target"], uid())])
    with pytest.raises(GraphError):
        store.receive([invalid], {hashlib.sha256(b"new").hexdigest(): b"new"})
    assert store.load().commits == before
    assert conn.execute("SELECT count(*) FROM graph_blobs").fetchone()[0] == 0
    conn.commit()
    conn.execute("BEGIN")
    store.write([create_object("Note", {"body": "rollback"})])
    conn.rollback()
    assert store.load().commits == before


def test_blobs_verified_and_collection_adoption_atomic(conn):
    store = Store(conn)
    blob = b"synthetic source"
    digest = hashlib.sha256(blob).hexdigest()
    c = Graph().commit(uid(), [create_object("SourceRecord", {"original": {"blob_hash": digest}})])
    with pytest.raises(GraphError, match="different collections"):
        store.receive([c], {digest: blob})
    old_collection = store.collection
    with pytest.raises(GraphError, match="Missing referenced"):
        store.receive([c], adopt=True)
    assert store.collection == old_collection
    assert conn.execute("SELECT value FROM graph_meta WHERE key='collection'").fetchone()[0] == old_collection
    with pytest.raises(GraphError, match="hash"):
        store.receive([c], {digest: b"wrong"}, adopt=True)
    store.receive([c], {digest: blob}, adopt=True)
    assert store.collection == c["collection"]
    assert store.load().collection == c["collection"]


def test_persistence_reopen_and_split_atomic(tmp_path):
    path = tmp_path / "synthetic.db"
    conn = db.connect(path)
    store = Store(conn)
    g, person, _, _, _, edges = seed()
    store.receive(list(g.commits.values()), adopt=True)
    split = store.split(person, "Other Cameron", [edges[2]["target"]])
    conn.commit()
    conn.close()
    conn = db.connect(path)
    assert Store(conn).load().objects[split["person"]]["type"] == "Person"
    conn.close()


@pytest.mark.parametrize("mutate", [
    lambda c: c.update(version=True),
    lambda c: c.update(recorded_at="2025-01-01"),
    lambda c: c["operations"][0].update(replaces=["bad"]),
    lambda c: c["operations"][0]["payload"].update(properties={"_lifecycle": "active"}),
    lambda c: c["operations"][0]["payload"].update(properties={"confidence": float("nan")}),
    lambda c: c["operations"][0]["payload"].update(properties={"nested": {1: "not a JSON key"}}),
    lambda c: c["operations"][0]["payload"].update(properties={"nested": ("not", "JSON")}),
])
def test_malformed_commits_are_rejected(mutate):
    c = Graph().commit(uid(), [create_object("Person")])
    mutate(c)
    with pytest.raises(GraphError):
        Graph([c])
