"""Phone identity metadata must not be mistaken for relationship settings."""

import uuid

import pytest

from mypeople import identity, ops, transfer


def person(conn, name="Sample"):
    pid = identity.create_person(conn, name)
    uid = conn.execute("SELECT contact_uid FROM people WHERE id=?", (pid,)).fetchone()[0]
    return pid, uid


def test_relationship_accepts_phone_contact_uid_and_stale_numeric_id(conn):
    pid, uid = person(conn)
    ops.apply(conn, "relationship", {"person_id": -42, "contact_uid": uid, "category": "friend", "closeness": 0.8, "cadence_days": 14, "muted": True})
    row = conn.execute("SELECT * FROM relationship_overrides WHERE person_id=?", (pid,)).fetchone()
    assert (row["category"], row["closeness"], row["cadence_days"], row["muted"]) == ("friend", 0.8, 14, 1)


def test_relationship_uid_follows_a_merged_person(conn):
    keep, _ = person(conn, "Keep")
    drop, uid = person(conn, "Drop")
    identity.merge(conn, keep, drop)
    ops.apply(conn, "relationship", {"contact_uid": uid, "category": "work"})
    assert conn.execute("SELECT category FROM relationship_overrides WHERE person_id=?", (keep,)).fetchone()[0] == "work"


def test_relationship_identity_alone_is_not_a_setting(conn):
    _, uid = person(conn)
    with pytest.raises(ops.OpError, match="Nothing to change"):
        ops.apply(conn, "relationship", {"contact_uid": uid})


def test_relationship_still_rejects_unknown_settings(conn):
    _, uid = person(conn)
    with pytest.raises(ops.OpError, match="Unknown relationship field 'unexpected'"):
        ops.apply(conn, "relationship", {"contact_uid": uid, "unexpected": True})


def test_bluetooth_relationship_edit_with_uid_applies_and_retries_safely(conn):
    pid, uid = person(conn)
    conn.commit()
    source, _ = transfer._prepare(conn)
    password = "test-relationship-passphrase"
    manifest = {"format": 1, "type": "edits", "source": source, "revision": 1,
                "ops": [{"client_id": str(uuid.uuid4()), "kind": "relationship", "payload": {"person_id": pid, "contact_uid": uid, "category": "family"}}]}
    data = transfer.encrypt(transfer.pack(manifest), password)
    first = transfer.apply_edits(conn, data, password, enrich=False)
    assert first["applied"] == 1 and first["failed"] == 0
    assert transfer.apply_edits(conn, data, password, enrich=False)["already_applied"] == 1
    assert conn.execute("SELECT category FROM relationship_overrides WHERE person_id=?", (pid,)).fetchone()[0] == "family"
