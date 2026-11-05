import datetime as dt
import hashlib
import json
import subprocess

import pytest

from mypeople import cli, contacts, identity
from mypeople.importers.signal import SignalError, import_signal
from mypeople.importers import signal_export
from mypeople.importers.vcard import Card, import_card

ME = "11111111-1111-4111-8111-111111111111"
ADA = "22222222-2222-4222-8222-222222222222"
GRACE = "33333333-3333-4333-8333-333333333333"
WHEN = 1790856000000


def conversation(cid="ada", service=ADA, **extra):
    return {"id": cid, "type": "private", "serviceId": service, "e164": "+447700900123", "profileName": "Ada", "profileFamilyName": "Lovelace", **extra}


def message(mid="m1", cid="ada", **extra):
    return {"id": mid, "conversationId": cid, "type": "outgoing", "sent_at": WHEN, "body": "Hello! 🎉", **extra}


def snapshot(tmp_path, conversations=None, messages=None, **header):
    conversations = [conversation()] if conversations is None else conversations
    messages = [message()] if messages is None else messages
    records = [{"kind": "header", "format": signal_export.FORMAT, "version": 1, "aci": ME + ".2", "number": "+12025550123.2", **header}]
    records += [{"kind": "conversation", "data": c} for c in conversations]
    records += [{"kind": "message", "data": m} for m in messages]
    records += [{"kind": "end", "conversations": len(conversations), "messages": len(messages)}]
    path = tmp_path / "signal.jsonl"
    path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")
    return path


def test_direct_messages_existing_contact_and_idempotence(conn, tmp_path):
    ada, _ = import_card(conn, Card(name="Ada Lovelace", phones=["+447700900123"]), "vcard", "test")
    before = conn.execute("SELECT contact_data FROM people WHERE id=?", (ada,)).fetchone()[0]
    path = snapshot(tmp_path, messages=[message(), message("m2", type="incoming", sourceServiceId=ADA.upper(), body=" Hi "), message("m3", body="", hasAttachments=True)])
    assert import_signal(conn, path)["interactions"] == 3
    rows = conn.execute("SELECT * FROM interactions ORDER BY id").fetchall()
    assert {r["person_id"] for r in rows} == {ada}
    assert [r["direction"] for r in rows] == ["out", "in", "out"]
    assert [r["text"] for r in rows] == ["Hello! 🎉", "Hi", None]
    assert rows[0]["at"] == dt.datetime.fromtimestamp(WHEN / 1000).isoformat(sep=" ")
    assert rows[0]["channel"] == "signal"
    assert identity.find_by_identifier(conn, "signal", ADA) == ada
    assert conn.execute("SELECT contact_data FROM people WHERE id=?", (ada,)).fetchone()[0] == before
    assert import_signal(conn, path)["interactions"] == 0


def test_no_name_matching_or_incoming_only_people(conn, tmp_path):
    old = identity.create_person(conn, "Ada Lovelace")
    path = snapshot(tmp_path, conversations=[conversation(), conversation("grace", GRACE, e164=None, name="Grace Hopper")], messages=[message(), message("m2", "grace", type="incoming")])
    assert import_signal(conn, path)["interactions"] == 1
    assert identity.find_by_identifier(conn, "signal", ADA) != old
    assert identity.find_by_identifier(conn, "signal", GRACE) is None
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 2


def test_groups_known_senders_only_and_no_outgoing_fanout(conn, tmp_path):
    path = snapshot(tmp_path, conversations=[conversation(), conversation("grace", GRACE, e164=None), {"id": "group", "type": "group", "groupId": "some-group"}], messages=[
        message("g1", "group", type="incoming", sourceServiceId=ADA),
        message("g2", "group", type="incoming", sourceServiceId=GRACE),
        message("g3", "group"),
        message("g4", "group", type="incoming", sourceServiceId=ME),
        message(),
    ])
    assert import_signal(conn, path)["interactions"] == 2
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM interactions WHERE thread='group chat'").fetchone()[0] == 1


def test_old_outgoing_establishes_relationship_before_cutoff(conn, tmp_path):
    path = snapshot(tmp_path, messages=[message(sent_at=1577880000000), message("m2", type="incoming")])
    assert import_signal(conn, path, dt.date(2026, 1, 1))["interactions"] == 1
    assert import_signal(conn, path)["interactions"] == 1


@pytest.mark.parametrize("extra", [{"isErased": True}, {"deletedForEveryone": True}, {"isViewOnce": True}, {"expireTimer": 60}, {"type": "keychange"}, {"type": "call-history"}, {"type": "message-request-response-event"}, {"body": ""}])
def test_not_conversation_and_ephemeral_messages_never_create_people(conn, tmp_path, extra):
    path = snapshot(tmp_path, messages=[message(**extra)])
    assert import_signal(conn, path)["interactions"] == 0
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 0


@pytest.mark.parametrize("timestamp", [None, "bad", True, -1, 1e100])
def test_bad_dates_skipped(conn, tmp_path, timestamp):
    path = snapshot(tmp_path, messages=[message(sent_at=timestamp)])
    assert import_signal(conn, path)["interactions"] == 0
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 0


def test_note_to_self_unknown_threads_and_wrong_sender(conn, tmp_path):
    path = snapshot(tmp_path, conversations=[conversation(), conversation("self", ME, e164="+12025550123")], messages=[message(), message("self", "self"), message("bad", "missing"), message("wrong", type="incoming", sourceServiceId=GRACE)])
    assert import_signal(conn, path)["interactions"] == 1
    assert identity.find_by_identifier(conn, "signal", ME) is None


def test_legacy_uuid_phone_sender_and_local_conversation_identity(conn, tmp_path):
    path = snapshot(tmp_path, conversations=[conversation(service=None, uuid=ADA), conversation("no-id", None, e164=None, name="Someone")], messages=[message(), message("m2", "no-id"), message("m3", type="incoming", sourceUuid=ADA)])
    assert import_signal(conn, path)["interactions"] == 3
    assert import_signal(conn, path)["interactions"] == 0
    assert identity.find_by_identifier(conn, "signal", ADA)
    assert identity.find_by_identifier(conn, "signal-conversation", ME + ":no-id")


def test_merge_survives_reimport_and_phone_change(conn, tmp_path):
    path = snapshot(tmp_path)
    import_signal(conn, path)
    original = identity.find_by_identifier(conn, "signal", ADA)
    survivor = identity.create_person(conn, "My preferred name")
    identity.merge(conn, survivor, original)
    path = snapshot(tmp_path, conversations=[conversation(e164="+12025550199")], messages=[message(), message("m2")])
    assert import_signal(conn, path)["interactions"] == 1
    assert identity.find_by_identifier(conn, "signal", ADA) == survivor
    assert conn.execute("SELECT name FROM people WHERE id=?", (survivor,)).fetchone()[0] == "My preferred name"
    assert not conn.execute("SELECT 1 FROM identifiers WHERE kind='phone' AND source='signal'").fetchone()


@pytest.mark.parametrize("flag", ["is_me", "trashed"])
def test_existing_me_and_trashed_are_not_recreated(conn, tmp_path, flag):
    pid = identity.create_person(conn, "Ada")
    conn.execute(f"UPDATE people SET {flag}=1 WHERE id=?", (pid,))
    identity.add_identifier(conn, pid, "signal", ADA, "manual")
    assert import_signal(conn, snapshot(tmp_path))["interactions"] == 0
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 1


def test_identical_ids_in_different_accounts_do_not_collide(conn, tmp_path):
    path = snapshot(tmp_path)
    assert import_signal(conn, path)["interactions"] == 1
    path = snapshot(tmp_path, aci=GRACE + ".3")
    assert import_signal(conn, path)["interactions"] == 1


@pytest.mark.parametrize("damage", ["truncated", "wrong-count", "bad-json", "extra", "duplicate", "wrong-account", "wrong-version"])
def test_invalid_snapshots_fail_before_writes(conn, tmp_path, damage):
    path = snapshot(tmp_path)
    lines = path.read_text().splitlines()
    if damage == "truncated":
        lines.pop()
    elif damage == "wrong-count":
        lines[-1] = json.dumps({"kind": "end", "conversations": 1, "messages": 100})
    elif damage == "bad-json":
        lines[-1] = '{"private_message_content":'
    elif damage == "extra":
        lines += [lines[1]]
    elif damage == "duplicate":
        lines.insert(-1, lines[-2])
    elif damage == "wrong-account":
        lines[0] = json.dumps(json.loads(lines[0]) | {"aci": "not-a-uuid"})
    else:
        lines[0] = json.dumps(json.loads(lines[0]) | {"version": 100})
    path.write_text("\n".join(lines))
    with pytest.raises(SignalError) as exc:
        import_signal(conn, path)
    assert "private_message_content" not in str(exc.value)
    assert conn.execute("SELECT count(*) FROM people").fetchone()[0] == 0
    assert conn.execute("SELECT count(*) FROM interactions").fetchone()[0] == 0


def test_cli(conn, tmp_path, capsys):
    with pytest.raises(SystemExit, match="Pass a Signal JSONL"):
        cli.main(["--db", ":memory:", "import", "signal"])
    cli.main(["--db", ":memory:", "import", "signal", str(snapshot(tmp_path))])
    assert "1 interactions" in capsys.readouterr().out
    with pytest.raises(SystemExit, match="Couldn't read Signal snapshot"):
        cli.main(["--db", ":memory:", "import", "signal", str(tmp_path / "missing.jsonl")])


def test_safe_storage_unwrap_uses_literal_password_and_validates_padding():
    from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
    from cryptography.hazmat.primitives.padding import PKCS7
    password = b"YmFzZTY0LXRleHQ="
    key = "ab" * 32
    kek = hashlib.pbkdf2_hmac("sha1", password, b"saltysalt", 1003, 16)
    padder = PKCS7(128).padder()
    padded = padder.update(key.encode()) + padder.finalize()
    encryptor = Cipher(algorithms.AES(kek), modes.CBC(b" " * 16)).encryptor()
    blob = b"v10" + encryptor.update(padded) + encryptor.finalize()
    assert signal_export.unwrap_key({"encryptedKey": blob.hex()}, password) == key
    assert signal_export.unwrap_key({"key": key}, b"") == key
    for config in [{"encryptedKey": (b"v11" + blob[3:]).hex()}, {"encryptedKey": blob.hex()}, {"key": "not-a-key"}]:
        with pytest.raises(signal_export.SignalExportError):
            signal_export.unwrap_key(config, b"wrong")


def test_snapshot_export_read_only_atomic_private_and_no_keys_in_argv(tmp_path, monkeypatch):
    root = tmp_path / "Signal"
    (root / "sql").mkdir(parents=True)
    key = "ab" * 32
    (root / "config.json").write_text(json.dumps({"key": key}))
    (root / "sql/db.sqlite").touch()
    output = tmp_path / "export.jsonl"
    monkeypatch.setattr(signal_export.sys, "platform", "darwin")
    def run(args, **kwargs):
        assert "-readonly" in args
        assert key not in " ".join(args)
        assert key in kwargs["input"].decode()
        if "pragma_table_info" in kwargs["input"].decode():
            return subprocess.CompletedProcess(args, 0, stdout=json.dumps({"messages": ["id", "json"], "conversations": ["id", "json"]}).encode())
        kwargs["stdout"].write((json.dumps({"kind": "header", "format": signal_export.FORMAT, "aci": ME}) + '\n' + json.dumps({"kind": "end", "conversations": 0, "messages": 0}) + '\n').encode())
        return subprocess.CompletedProcess(args, 0)
    monkeypatch.setattr(signal_export.subprocess, "run", run)
    signal_export.export_snapshot(root, output, "/fake/sqlcipher")
    assert output.stat().st_mode & 0o777 == 0o600
    assert key not in output.read_text()
    assert not list(tmp_path.glob(".signal-*"))
    with pytest.raises(signal_export.SignalExportError, match="already exists"):
        signal_export.export_snapshot(root, output, "/fake/sqlcipher")


def test_snapshot_export_failure_does_not_publish_or_leak(tmp_path, monkeypatch):
    root = tmp_path / "Signal"
    (root / "sql").mkdir(parents=True)
    key = "ab" * 32
    (root / "config.json").write_text(json.dumps({"key": key}))
    (root / "sql/db.sqlite").touch()
    output = tmp_path / "export.jsonl"
    monkeypatch.setattr(signal_export.sys, "platform", "darwin")
    monkeypatch.setattr(signal_export.subprocess, "run", lambda *a, **kw: subprocess.CompletedProcess(a, 1, stderr=key.encode()))
    with pytest.raises(signal_export.SignalExportError) as exc:
        signal_export.export_snapshot(root, output, "/fake/sqlcipher")
    assert key not in str(exc.value)
    assert not output.exists()
    assert not list(tmp_path.glob(".signal-*"))
    with pytest.raises(signal_export.SignalExportError, match="outside Signal"):
        signal_export.export_snapshot(root, root / "unsafe.jsonl", "/fake/sqlcipher")
