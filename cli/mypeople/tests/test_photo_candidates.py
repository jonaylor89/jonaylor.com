"""Synthetic-only avatar provenance, preference, replication and compatibility tests."""
import base64
import hashlib
import json
from pathlib import Path
import uuid

import pytest

from mypeople import db, graph_runtime, identity, photo_candidates as pc, photos, replica, transfer
from mypeople.graph import Graph, Store, GraphError


def image(width=128, height=None, tag=b""):
    return b"\x89PNG\r\n\x1a\n" + b"\0" * 8 + width.to_bytes(4, "big") + (height or width).to_bytes(4, "big") + tag


def person(conn, name="Synthetic Person"):
    pid = identity.create_person(conn, name)
    conn.commit()
    uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (pid,)).fetchone()[0]
    return pid, uid


def test_same_source_retains_smaller_images_and_identical_bytes_share_blob(conn):
    pid, uid = person(conn)
    large, small = image(512), image(128)
    assert photos.save(conn, pid, "groupme", large, source_identity="123")
    assert photos.save(conn, pid, "groupme", small, source_identity="123")
    assert photos.save(conn, pid, "whatsapp", small, source_identity="456")
    conn.commit()
    result = pc.list_for(conn, uid)
    assert len(result["candidates"]) == 3
    assert len({c["path"] for c in result["candidates"]}) == 2
    assert conn.execute("SELECT COUNT(*) FROM graph_blobs").fetchone()[0] == 2
    count = conn.execute("SELECT COUNT(*) FROM graph_commits").fetchone()[0]
    assert not photos.save(conn, pid, "groupme", small, source_identity="123")
    conn.commit()
    assert conn.execute("SELECT COUNT(*) FROM graph_commits").fetchone()[0] == count
    assert {c["source_identity"] for c in result["candidates"]} == {"123", "456"}


def test_pin_survives_import_card_edit_and_reopen_and_automatic_uses_source_date(tmp_path):
    path = tmp_path / "synthetic.db"
    conn = db.connect(path)
    pid, uid = person(conn)
    photos.save(conn, pid, "groupme", image(512), source_updated_at="2025-01-01T00:00:00Z")
    photos.save(conn, pid, "groupme", image(128), source_updated_at="2026-01-01T00:00:00Z")
    candidates = pc.list_for(conn, uid)["candidates"]
    small = next(c for c in candidates if c["width"] == 128)
    large = next(c for c in candidates if c["width"] == 512)
    assert pc.list_for(conn, uid)["selected"] == small["id"]
    pc.choose(conn, uid, large["id"])
    photos.save(conn, pid, "google", image(720), source_updated_at="2027-01-01T00:00:00Z")
    replica.change(conn, uid, values={"name": "Renamed, not re-photographed"})
    conn.commit()
    assert pc.list_for(conn, uid)["selected"] == large["id"]
    conn.close()
    conn = db.connect(path)
    assert pc.list_for(conn, uid)["preferred"] == large["id"]
    assert len(pc.list_for(conn, uid)["candidates"]) == 3
    pc.choose(conn, uid, "")
    assert photos.best(conn, pid)["width"] == 720
    conn.close()


def test_manual_editor_uploads_preserved_and_automatic_does_not_delete_them(conn):
    pid, uid = person(conn)
    manual = image(128, tag=b"manual")
    replica.change(conn, uid, values={"photo": base64.b64encode(manual).decode()})
    photos.save(conn, pid, "groupme", image(512))
    conn.commit()
    result = pc.list_for(conn, uid)
    assert result["preferred"] == result["selected"]
    assert photos.best(conn, pid)["hash"] == hashlib.sha256(manual).hexdigest()
    pc.choose(conn, uid, "")
    assert photos.best(conn, pid)["width"] == 512
    assert len(pc.list_for(conn, uid)["candidates"]) == 2
    replica.change(conn, uid, values={"organization": "Synthetic workplace"})
    conn.commit()
    assert len(pc.list_for(conn, uid)["candidates"]) == 2


def test_merge_undo_and_split_keep_every_candidate_and_original_ownership(conn):
    a, auid = person(conn, "A")
    b, buid = person(conn, "B")
    photos.save(conn, a, "groupme", image(128))
    photos.save(conn, b, "groupme", image(256))
    bphoto = pc.list_for(conn, buid)["selected"]
    pc.choose(conn, buid, bphoto)
    conn.commit()
    keep = identity.canonical(conn, graph_runtime.merge(conn, [a, b], preferred=a))
    uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (keep,)).fetchone()[0]
    assert len(pc.list_for(conn, uid)["candidates"]) == 2
    assert pc.list_for(conn, uid)["preferred"] == bphoto
    graph_runtime.unmerge(conn, keep)
    assert len(pc.list_for(conn, auid)["candidates"]) == 1
    assert pc.list_for(conn, buid)["preferred"] == bphoto
    selection = graph_runtime.associations(conn, buid)
    edge = next(row["id"] for row in selection["associations"] if row["kind"] == "asset")
    moved = graph_runtime.split(conn, buid, "B separate", [edge], heads=selection["heads"])
    assert pc.list_for(conn, buid)["unavailable_preference"]
    assert pc.list_for(conn, moved["contact_uid"])["candidates"][0]["id"] == bphoto


def test_concurrent_pins_are_explicit_and_resolution_converges(conn):
    pid, uid = person(conn)
    photos.save(conn, pid, "groupme", image(128))
    photos.save(conn, pid, "google", image(256))
    conn.commit()
    graph = Store(conn).replay()
    a, b = [c["id"] for c in pc.view(graph, uid)["candidates"]]
    left = graph.commit(str(uuid.uuid4()), [graph.edit(uid, "photo_choice", a)])
    right = graph.commit(str(uuid.uuid4()), [graph.edit(uid, "photo_choice", b)])
    joined = Graph([*graph.commits.values(), left, right])
    assert pc.view(joined, uid)["conflict"]
    resolved = joined.commit(str(uuid.uuid4()), [joined.edit(uid, "photo_choice", "")])
    result = pc.view(Graph([*joined.commits.values(), resolved]), uid)
    assert result["automatic"] and not result["conflict"]
    with pytest.raises(GraphError, match="no longer available"):
        pc.choose(conn, uid, str(uuid.uuid4()))


def test_transfer_clones_all_candidates_preference_and_bytes(conn, tmp_path):
    pid, uid = person(conn)
    photos.save(conn, pid, "groupme", image(128))
    photos.save(conn, pid, "groupme", image(256))
    selected = pc.list_for(conn, uid)["candidates"][0]["id"]
    pc.choose(conn, uid, selected)
    conn.commit()
    path = tmp_path / "synthetic.sherloq"
    transfer.export_snapshot(conn, path, "synthetic-test-password", include_photos=False)
    clone = db.connect(tmp_path / "clone.db")
    transfer.merge_snapshot(clone, path, "synthetic-test-password")
    result = pc.list_for(clone, uid)
    assert len(result["candidates"]) == 2 and result["preferred"] == selected
    assert all(hashlib.sha256(Path(c["path"]).read_bytes()).hexdigest() == c["hash"] for c in result["candidates"])
    clone.close()


def test_python_and_android_use_shared_photo_policy_fixture():
    path = Path(__file__).parents[3] / "android/mypeople/app/src/test/resources/photo-candidates.json"
    fixture = json.loads(path.read_text())
    graph = Graph(fixture["bundle"]["commits"])
    result = pc.view(graph, fixture["uid"])
    for key, value in fixture["expected"].items():
        assert result[key] == value


def test_later_source_evidence_updates_candidate_without_changing_identity(conn):
    pid, uid = person(conn)
    photos.save(conn, pid, "groupme", image(128), source_updated_at="2026-01-01T03:00:00+03:00")
    before = pc.list_for(conn, uid)["candidates"][0]
    assert before["source_updated_at"] == "2026-01-01T00:00:00Z"
    assert not photos.save(conn, pid, "groupme", image(128), source_updated_at="2026-02-01T00:00:00Z")
    after = pc.list_for(conn, uid)["candidates"][0]
    assert after["id"] == before["id"] and after["first_observed"] == before["first_observed"]
    assert after["source_updated_at"] == "2026-02-01T00:00:00Z"
    with pytest.raises(ValueError, match="timezone"):
        photos.save(conn, pid, "groupme", image(128), source_updated_at="2026-03-01")


def test_stale_preference_requires_reload_but_new_candidates_do_not(conn):
    pid, uid = person(conn)
    photos.save(conn, pid, "groupme", image(128))
    before = pc.list_for(conn, uid)
    photos.save(conn, pid, "google", image(256))
    choice = before["candidates"][0]["id"]
    pc.choose(conn, uid, choice, observed=before["observed"])
    with pytest.raises(GraphError, match="Reload photos"):
        pc.choose(conn, uid, "", observed=before["observed"])
    assert pc.list_for(conn, uid)["preferred"] == choice


def test_legacy_photo_rows_and_manual_card_photos_remain_candidates(conn, tmp_path):
    pid, uid = person(conn)
    path = tmp_path / "legacy.png"
    path.write_bytes(image(128))
    conn.execute("INSERT INTO photos(person_id,source,path,width) VALUES (?,?,?,?)", (pid, "contacts", str(path), 128))
    conn.commit()
    legacy = pc.list_for(conn, uid)["candidates"][0]
    assert legacy["source"] == "contacts" and legacy["first_observed"] == ""
    replica.change(conn, uid, values={"photo": base64.b64encode(image(256)).decode()})
    conn.commit()
    manual = pc.list_for(conn, uid)
    assert len(manual["candidates"]) == 2 and not manual["automatic"]
    assert photos.best(conn, pid)["width"] == 256


def test_large_original_photo_does_not_make_unrelated_card_edits_invalid(conn):
    pid, uid = person(conn)
    content = image(128, tag=b"x" * (3 * 1024 * 1024))
    photos.save(conn, pid, "groupme", content)
    replica.change(conn, uid, values={"name": "Still editable"})
    conn.commit()
    assert photos.best(conn, pid)["hash"] == hashlib.sha256(content).hexdigest()
    assert len(pc.list_for(conn, uid)["candidates"]) == 1


def test_vcard_import_adds_candidate_without_overriding_a_pin(conn):
    from mypeople.importers.vcard import Card, import_card
    pid, uid = person(conn)
    photos.save(conn, pid, "groupme", image(128))
    preferred = pc.list_for(conn, uid)["selected"]
    pc.choose(conn, uid, preferred)
    import_card(conn, Card(name="Synthetic Person", contact={"name": "Synthetic Person", "photo": base64.b64encode(image(512)).decode()}), "vcard", "synthetic.vcf")
    conn.commit()
    choices = pc.list_for(conn, uid)
    assert choices["preferred"] == preferred
    assert len(choices["candidates"]) == 2
