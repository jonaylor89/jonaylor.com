"""Regression for dense bootstrap parent frontiers: no data truncation or raised size caps."""
import copy
import json
import random

import pytest

from mypeople import contact_wire, replica, transfer

SOURCE = "11111111-1111-4111-8111-111111111111"


def uid(n):
    return f"00000000-0000-4000-8000-{n:012d}"


def dense_history(size=500, updates=500):
    roots = [uid(i + 1) for i in range(size)]
    changes = [{"id": root, "contact_uid": root, "parents": [], "values": {"name": f"Person {i}"}} for i, root in enumerate(roots)]
    changes += [{"id": uid(size + i + 1), "contact_uid": roots[i % size], "parents": roots,
                 "values": {"notes": f"Update {i}"}} for i in range(updates)]
    return changes


def test_frontiers_roundtrip_exact_changes_and_retry_payloads_without_mutation():
    changes = dense_history(12, 12)
    payload = {"id": uid(50), "contact_uid": uid(1), "parents": changes[-1]["parents"], "values": {"notes": "Unicode 🌱"}}
    omitted = {"id": uid(51), "contact_uid": uid(1), "values": {"favorite": True}}
    manifest = {"format": 1, "type": "edits", "source": SOURCE, "contact_history": changes,
                "ops": [{"kind": "contact_change", "payload": payload}, {"kind": "contact_change", "payload": omitted}],
                "results": [{"kind": "contact_change", "payload": payload}], "contact_wire": 1}
    before = copy.deepcopy(manifest)
    compressed = contact_wire.compact(manifest)
    assert compressed["format"] == 2 and len(compressed["contact_frontiers"]) == 1
    expanded = contact_wire.expand(compressed)
    assert expanded == before == manifest
    assert "parents" not in expanded["ops"][1]["payload"]  # UUID retry fingerprints must remain identical
    assert expanded["contact_history"][-1]["parents"] is expanded["contact_history"][-2]["parents"]


def test_logical_history_exceeding_old_manifest_cap_fits_without_losing_edges():
    changes = dense_history(1024, 900)
    assert 1024 * 900 * 39 > 32 * 1024 * 1024
    manifest = {"format": 1, "type": "snapshot", "source": SOURCE, "contact_history": changes}
    packed = transfer.pack(manifest)
    assert len(packed) < 1024 * 1024
    expanded = transfer.unpack(packed)
    assert expanded["contact_history"] == changes
    assert replica.History(expanded["contact_history"]).contact(uid(1)).card["notes"] == "Update 0"


def test_causal_validation_does_not_expand_full_pasts_for_every_field(monkeypatch):
    def forbidden(*args):
        raise AssertionError("Reducer must use targeted reachability, not full ancestor closures")
    changes = dense_history()
    # Exercise causal value replacement and merge validation, not just append-only registers.
    for c in changes[500:]:
        c["values"]["name"] = "Renamed"
        c["replaces"] = {"name": [c["contact_uid"]]}
    changes[-1]["links"] = [uid(1)]
    monkeypatch.setattr(replica.History, "past", forbidden)
    h = replica.History(changes)
    assert h.contact(uid(1)).uid == uid(1)
    assert h.contact(uid(2)).card["name"] == "Renamed"


def test_targeted_reachability_matches_exhaustive_dfs_on_random_dags():
    rng = random.Random(42)
    changes = [{"id": uid(1), "contact_uid": uid(1), "parents": [], "values": {"name": "Person"}}]
    for i in range(2, 120):
        parents = rng.sample([c["id"] for c in changes], min(len(changes), rng.randrange(1, 5)))
        changes.append({"id": uid(i), "contact_uid": uid(1), "parents": parents, "values": {"notes": str(i)}})
    rng.shuffle(changes)
    h = replica.History(changes)
    for c in h.changes:
        past = h.past(c["parents"])
        for origin in h.by_id:
            assert h.observed(origin, c["parents"]) == (origin in past)


@pytest.mark.parametrize("fault", ["digest", "missing", "both", "null", "duplicate", "old-format"])
def test_invalid_frontier_references_are_rejected(fault):
    compressed = contact_wire.compact({"format": 1, "source": SOURCE, "contact_history": dense_history(3, 3)})
    ref = next(iter(compressed["contact_frontiers"]))
    row = compressed["contact_history"][-1]
    if fault == "digest": compressed["contact_frontiers"][ref] = [uid(80)]
    if fault == "missing": row["parent_frontier"] = "a" * 64
    if fault == "both": row["parents"] = []
    if fault == "null": row["parent_frontier"] = None
    if fault == "duplicate": compressed["contact_frontiers"][ref] += [uid(1)]
    if fault == "old-format": compressed["format"] = 1
    with pytest.raises(ValueError): contact_wire.expand(compressed)


def test_peer_reply_only_contains_its_requested_receipts(tmp_path):
    from mypeople import db, identity
    conn = db.connect(":memory:")
    try:
        person = identity.create_person(conn, "Synthetic Person")
        source, _ = transfer._prepare(conn)
        password = "synthetic-transfer-passphrase"
        ops = [{"client_id": uid(800 + i), "kind": "event_add", "payload": {"person_id": person, "type": "job", "value": f"Example {i}", "date": "2026"}} for i in range(2)]
        peer = {"format": 1, "type": "edits", "source": source, "ops": ops}
        assert transfer.apply_edits(conn, transfer.encrypt(transfer.pack(peer), password), password, enrich=False)["applied"] == 2
        path = tmp_path / "reply.sherloq"
        transfer.export_snapshot(conn, path, password, include_photos=False, peer=peer | {"ops": ops[:1]})
        reply = transfer.unpack(transfer.decrypt(path.read_bytes(), password))
        assert [r["client_id"] for r in reply["results"]] == [ops[0]["client_id"]]
        transfer.export_snapshot(conn, path, password, include_photos=False)
        assert len(transfer.unpack(transfer.decrypt(path.read_bytes(), password))["results"]) == 2
    finally:
        conn.close()


def test_python_jvm_frontier_fixture():
    from pathlib import Path
    fixture = json.loads((Path(__file__).parents[3] / "android/mypeople/app/src/test/resources/contact-frontiers.json").read_text())
    assert contact_wire.expand(fixture["wire"]) == fixture["expanded"]
    assert contact_wire.compact(fixture["expanded"]) == fixture["wire"]


def test_legacy_format_remains_readable_and_compaction_can_be_disabled():
    manifest = {"format": 1, "source": SOURCE, "contact_history": dense_history(3, 3)}
    raw = transfer.pack(manifest, compact_history=False)
    assert transfer.unpack(raw) == manifest
