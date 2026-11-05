"""Offline Bluetooth/USB file protocol; all fixtures are synthetic."""
import json
import uuid
from pathlib import Path

import pytest

from mypeople import identity, ops, transfer

PASSWORD = "synthetic-transfer-passphrase"


def edits(source, pending):
    return transfer.encrypt(transfer.pack({"format": 1, "type": "edits", "source": source, "ops": pending}), PASSWORD)


def operation(kind="rename", **payload):
    return {"client_id": str(uuid.uuid4()), "kind": kind, "payload": payload}


def test_snapshot_contains_only_published_view_and_is_authenticated(conn, tmp_path):
    person = identity.create_person(conn, "Sample Person")
    conn.commit()
    path = tmp_path / "memory.sherloq"
    stats = transfer.export_snapshot(conn, path, PASSWORD)
    assert stats["records"] >= 1
    raw = path.read_bytes()
    assert b"Sample Person" not in raw
    manifest = transfer.unpack(transfer.decrypt(raw, PASSWORD))
    assert manifest["type"] == "snapshot" and manifest["revision"] == 1
    assert any(r["kind"] == "person" and r["id"] == str(person) for r in manifest["records"])
    assert "interactions" not in manifest
    with pytest.raises(transfer.TransferError, match="passphrase or damaged"):
        transfer.decrypt(raw, "wrong-passphrase-long-enough")
    with pytest.raises(transfer.TransferError):
        transfer.decrypt(raw[:-1] + bytes([raw[-1] ^ 1]), PASSWORD)
    transfer.export_snapshot(conn, path, PASSWORD)
    assert transfer.unpack(transfer.decrypt(path.read_bytes(), PASSWORD))["revision"] == 2


def test_edits_retry_by_uuid_and_receipts_return_in_snapshot(conn, tmp_path):
    person = identity.create_person(conn, "Sample Person")
    source, _ = transfer._prepare(conn)
    op = operation("event_add", person_id=person, type="job", value="Synthetic fact", date="2026")
    path = tmp_path / "edits.sherloq"
    path.write_bytes(edits(source, [op]))
    assert transfer.import_edits(conn, path, PASSWORD)["applied"] == 1
    assert transfer.import_edits(conn, path, PASSWORD)["already_applied"] == 1
    assert conn.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
    memory = tmp_path / "memory.sherloq"
    transfer.export_snapshot(conn, memory, PASSWORD)
    result = transfer.unpack(transfer.decrypt(memory.read_bytes(), PASSWORD))["results"][0]
    assert result["client_id"] == op["client_id"] and result["status"] == "done"


def test_other_database_and_reused_uuid_cannot_apply(conn, tmp_path):
    person = identity.create_person(conn, "Original")
    source, _ = transfer._prepare(conn)
    op = operation(person_id=person, name="Renamed")
    path = tmp_path / "edits.sherloq"
    path.write_bytes(edits(str(uuid.uuid4()), [op]))
    with pytest.raises(transfer.TransferError, match="different Mac"):
        transfer.import_edits(conn, path, PASSWORD)
    assert conn.execute("SELECT name FROM people WHERE id = ?", (person,)).fetchone()[0] == "Original"
    path.write_bytes(edits(source, [op]))
    transfer.import_edits(conn, path, PASSWORD)
    op["payload"]["name"] = "Collision"
    path.write_bytes(edits(source, [operation(person_id=person, name="Must not apply"), op]))
    with pytest.raises(transfer.TransferError, match="reused"):
        transfer.import_edits(conn, path, PASSWORD)
    assert conn.execute("SELECT name FROM people WHERE id = ?", (person,)).fetchone()[0] == "Renamed"


def test_failed_operation_rolls_back_internal_commits(conn, tmp_path, monkeypatch):
    person = identity.create_person(conn, "Original")
    source, _ = transfer._prepare(conn)
    original = ops.apply
    def fail_after_edit(c, kind, payload):
        original(c, kind, payload)  # Its internal commit must not escape our transaction.
        raise ops.OpError("Synthetic validation failure")
    monkeypatch.setattr(ops, "apply", fail_after_edit)
    path = tmp_path / "edits.sherloq"
    path.write_bytes(edits(source, [operation(person_id=person, name="Not committed")]))
    assert transfer.import_edits(conn, path, PASSWORD)["failed"] == 1
    assert conn.execute("SELECT name FROM people WHERE id = ?", (person,)).fetchone()[0] == "Original"


def test_enrichment_can_be_deferred_and_later_retried(conn, tmp_path, monkeypatch):
    person = identity.create_person(conn, "Sample")
    source, _ = transfer._prepare(conn)
    path = tmp_path / "edits.sherloq"
    path.write_bytes(edits(source, [operation("note", person_id=person, text="Synthetic note")]))
    assert transfer.import_edits(conn, path, PASSWORD, enrich=False)["deferred"] == 1
    monkeypatch.setattr(ops, "apply", lambda *args: "Synthetic success")
    assert transfer.import_edits(conn, path, PASSWORD)["applied"] == 1


def test_private_key_file_and_output_permissions(tmp_path):
    key = tmp_path / "transfer.key"
    password = transfer.key_file(key, create=True)
    assert transfer.key_file(key) == password and len(password) >= 12
    assert key.stat().st_mode & 0o777 == 0o600
    destination = tmp_path / "transfer.sherloq"
    transfer.write_file(destination, b"ciphertext")
    assert destination.stat().st_mode & 0o777 == 0o600
    with pytest.raises(transfer.TransferError):
        transfer.encrypt(b"sample", "short")
