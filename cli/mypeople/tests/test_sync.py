"""The sync server and the Mac's sync client, end to end over real HTTP on localhost."""

import hashlib
import json
import threading
import urllib.error
import urllib.request

import pytest

from mypeople import identity, ops, photos, server, sync
from mypeople.events import add_event
from mypeople.importers.common import add_interaction

PNG = bytes.fromhex("89504e470d0a1a0a0000000d4948445200000040000000400806000000")  # a 64px-wide PNG header


@pytest.fixture
def running(tmp_path):
    store = server.Store(tmp_path / "server")
    httpd = server.make_server(store, port=0)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    url = f"http://127.0.0.1:{httpd.server_address[1]}"
    yield store, url
    httpd.shutdown()


def call(url, token, method, path, body=None):
    req = urllib.request.Request(url + path, method=method, data=json.dumps(body).encode() if body is not None else None)
    req.add_header("Authorization", f"Bearer {token}")
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())


def sample(conn, tmp_path):
    marcus = identity.resolve(conn, [("phone", "5551234567")], "Marcus Lee", "test")
    add_interaction(conn, marcus, "2026-10-20 12:00:00", "imessage", "in", "secret message text", None, "t:1")
    add_event(conn, marcus, "job", "Started at Figma", "2026-10", 0.9, "imessage", None, "I start at Figma Monday", "2026-10-20")
    me = identity.create_person(conn, "Johannes Naylor")
    identity.set_me(conn, [me])
    conn.commit()
    return marcus


def test_push_publishes_people_facts_and_photos_but_no_messages(conn, running, tmp_path):
    store, url = running
    marcus = sample(conn, tmp_path)
    photo = tmp_path / "marcus.png"
    photo.write_bytes(PNG)
    conn.execute("INSERT INTO photos (person_id, source, path, width) VALUES (?, 'contacts', ?, 64)", (marcus, str(photo)))
    mac, phone = store.add_device("mac", "mac"), store.add_device("pixel", "phone")

    stats = sync.push(conn, sync.Client(url, mac))
    assert stats["photos"] == 1 and stats["updated"] == stats["records"]

    changes = call(url, phone, "GET", "/v1/changes?since=0")
    people = {r["id"]: r["data"] for r in changes["records"] if r["kind"] == "person"}
    assert list(people) == [str(marcus)]  # you aren't in your own contacts
    assert people[str(marcus)]["identifiers"] == [{"kind": "phone", "value": "5551234567"}]
    assert people[str(marcus)]["photo"] == hashlib.sha256(PNG).hexdigest()
    events = [r["data"] for r in changes["records"] if r["kind"] == "event"]
    assert events[0]["value"] == "Started at Figma" and events[0]["evidence"] == "I start at Figma Monday"
    assert "secret message text" not in json.dumps(changes)

    req = urllib.request.Request(f"{url}/v1/photos/{people[str(marcus)]['photo']}")
    req.add_header("Authorization", f"Bearer {phone}")
    assert urllib.request.urlopen(req).read() == PNG

    # Nothing changed, nothing sent; a rename sends its projection and immutable causal patch.
    assert sync.push(conn, sync.Client(url, mac))["updated"] == 0
    conn.execute("UPDATE people SET name = 'Marcus J. Lee' WHERE id = ?", (marcus,))
    assert sync.push(conn, sync.Client(url, mac))["updated"] == 2
    later = call(url, phone, "GET", f"/v1/changes?since={changes['cursor']}")
    assert [(r["kind"], r["data"]["name"]) for r in later["records"] if r["kind"] == "person"] == [("person", "Marcus J. Lee")]
    patch = next(r["data"] for r in later["records"] if r["kind"] == "contact_change")
    assert patch["values"] == {"name": "Marcus J. Lee"}

    # A forgotten fact disappears from the phone.
    conn.execute("UPDATE events SET status = 'rejected'")
    assert sync.push(conn, sync.Client(url, mac))["deleted"] == 1
    gone = call(url, phone, "GET", f"/v1/changes?since={later['cursor']}")
    assert [(r["kind"], r["data"]) for r in gone["records"]] == [("event", None)]


def test_phone_edits_are_applied_on_the_mac_and_reported_back(conn, running, tmp_path):
    store, url = running
    marcus = sample(conn, tmp_path)
    other = identity.resolve(conn, [("email", "marcus@acme.com")], "Marcus", "test")
    mac, phone = store.add_device("mac", "mac"), store.add_device("pixel", "phone")
    queued = [
        {"client_id": "a1", "kind": "alias_add", "payload": {"person_id": marcus, "alias": "Marky"}},
        {"client_id": "a2", "kind": "relationship", "payload": {"person_id": marcus, "category": "friend", "muted": False}},
        {"client_id": "a3", "kind": "event_add", "payload": {"person_id": marcus, "type": "move", "value": "Moved to Denver", "date": "2026-09"}},
        {"client_id": "a4", "kind": "merge", "payload": {"person_ids": [marcus, other]}},
        {"client_id": "a5", "kind": "rename", "payload": {"person_id": other, "name": ""}},  # bad: no name
        {"client_id": "a6", "kind": "extract", "payload": {"person_id": marcus}},  # enrichment, left for later
    ]
    call(url, phone, "POST", "/v1/ops", {"ops": queued})
    call(url, phone, "POST", "/v1/ops", {"ops": queued[:1]})  # a resend is ignored
    assert len(store.pending()) == 6

    lines = []
    stats = sync.sync(conn, sync.Client(url, mac), enrich=False, report=lines.append)
    assert stats["applied"] == 5
    # Replicated identity roots are UUID-selected, not fixed SQLite row IDs.
    marcus = identity.canonical(conn, marcus)
    assert set(identity.aliases(conn, marcus)) == {"Marky", "Marcus"}  # merged display names survive re-imports
    assert conn.execute("SELECT category FROM relationship_overrides WHERE person_id = ?", (marcus,)).fetchone()[0] == "friend"
    assert identity.canonical(conn, other) == marcus
    assert [p["kind"] for p in store.pending()] == ["extract"]

    results = {o["client_id"]: o for o in call(url, phone, "GET", "/v1/changes?since=0")["ops"]}
    assert results["a1"]["status"] == "done"
    assert results["a5"] == {**results["a5"], "status": "failed", "message": "name is missing"}
    # The merged record is gone from the phone's view; the move shows up under Marcus.
    people = [r for r in call(url, phone, "GET", "/v1/changes?since=0")["records"] if r["kind"] == "person" and r["data"]]
    assert [p["id"] for p in people] == [str(marcus)]


def test_an_op_applied_before_a_lost_reply_isnt_applied_twice(conn, running, tmp_path):
    store, url = running
    marcus = sample(conn, tmp_path)
    mac, phone = store.add_device("mac", "mac"), store.add_device("pixel", "phone")
    call(url, phone, "POST", "/v1/ops", {"ops": [
        {"client_id": "x", "kind": "event_add", "payload": {"person_id": marcus, "type": "trip", "value": "Lisbon"}}]})
    conn.executescript(sync.SCHEMA)
    op_id = store.pending()[0]["id"]
    conn.execute("INSERT INTO sync_applied (op_id, ok, message) VALUES (?, 1, 'Added.')", (op_id,))
    sync.apply_ops(conn, sync.Client(url, mac), report=lambda _: None)
    assert conn.execute("SELECT COUNT(*) FROM events WHERE value = 'Lisbon'").fetchone()[0] == 0
    assert store.pending() == []


def test_devices_only_do_what_their_role_allows(running):
    store, url = running
    phone = store.add_device("pixel", "phone")
    with pytest.raises(urllib.error.HTTPError) as e:
        call(url, phone, "POST", "/v1/push", {"upserts": []})
    assert e.value.code == 403
    with pytest.raises(urllib.error.HTTPError) as e:
        call(url, "not-a-token", "GET", "/v1/changes?since=0")
    assert e.value.code == 401
    store.remove_device("pixel")
    with pytest.raises(urllib.error.HTTPError) as e:
        call(url, phone, "GET", "/v1/changes?since=0")
    assert e.value.code == 401
    assert store.conn.execute("SELECT token_hash FROM devices").fetchall() == []


def test_photos_must_match_their_hash(running):
    store, url = running
    with pytest.raises(ValueError):
        store.put_photo("0" * 64, PNG)
    assert store.photo("../server.db") is None


def test_changes_are_paged_without_gaps(tmp_path):
    store = server.Store(tmp_path)
    store.push([{"kind": "person", "id": str(i), "data": {"name": f"P{i}"}} for i in range(5)], [])
    store.add_ops("pixel", [{"client_id": "c", "kind": "rename", "payload": {}}])
    store.push([{"kind": "person", "id": "9", "data": {"name": "P9"}}], [])
    seen, since = [], 0
    while True:
        page = store.changes(since, limit=2)
        seen += [r["id"] for r in page["records"]] + [o["client_id"] for o in page["ops"]]
        since = page["cursor"]
        if not page["more"]:
            break
    assert sorted(seen) == ["0", "1", "2", "3", "4", "9", "c"]


def test_ops_validate_their_payloads(conn):
    pid = identity.create_person(conn, "Sam Rivera")
    with pytest.raises(ops.OpError, match="closeness"):
        ops.apply(conn, "relationship", {"person_id": pid, "closeness": 3})
    with pytest.raises(ops.OpError, match="No person"):
        ops.apply(conn, "rename", {"person_id": 999, "name": "X"})
    with pytest.raises(ops.OpError, match="Unknown operation"):
        ops.apply(conn, "drop_tables", {})
    assert ops.apply(conn, "relationship", {"person_id": pid, "closeness": 0.8, "muted": True}) == "Updated Sam Rivera."


def test_photo_collection_reports_one_line(conn, monkeypatch):
    monkeypatch.setattr(photos, "collect_contacts", lambda conn, root: {"photos": 3, "matched": 2, "saved": 1})
    assert photos.collect(conn, "contacts") == "contacts: 3 photos, 2 of people you know; 1 new or larger."
