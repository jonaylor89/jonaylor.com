"""Run the exact QR exchange callback on a worker with a synthetic Mac database."""
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace
import json

from mypeople import bluetooth, cli, db, identity, transfer

PASSWORD = "synthetic-transfer-passphrase"


def test_qr_applies_upload_before_fresh_snapshot_and_retries_once(tmp_path, monkeypatch):
    database = tmp_path / "mac.db"
    parent = db.connect(database)
    person = identity.create_person(parent, "Synthetic Person")
    parent.commit()
    key = tmp_path / "transfer.key"
    key.write_text(PASSWORD)
    reply = tmp_path / "reply.sherloq"
    args = SimpleNamespace(action="qr", path=reply, db=database, password_file=key,
                           no_photos=True, no_enrich=True, minutes=1, no_open=True, send=False)
    def serve(path, password, source, **options):
        assert not path.exists()  # Do not serve a stale snapshot generated before edits.
        op = {"client_id": "22222222-2222-4222-8222-222222222222", "kind": "event_add",
              "payload": {"person_id": person, "type": "job", "value": "Synthetic phone edit", "date": "2026"}}
        deferred = {"client_id": "33333333-3333-4333-8333-333333333333", "kind": "extract",
                    "payload": {"person_id": person}}
        encrypted = transfer.encrypt(transfer.pack({"format": 1, "type": "edits", "source": source, "ops": [op, deferred]}), password)
        protocol = bluetooth.SessionProtocol("synthetic-token", 9999999999, version=2)
        assert protocol.feed(b"SHERLOQ2 synthetic-token\n" + bluetooth.frame_header(encrypted, upload=True) + encrypted) == "uploaded"
        with ThreadPoolExecutor(max_workers=1) as pool:
            for _ in range(2):  # Simulate a lost download followed by reconnect/retry.
                response = pool.submit(options["exchange"], protocol.upload).result()
                manifest = transfer.unpack(transfer.decrypt(response, password))
                assert any(r["kind"] == "event" and r["data"]["value"] == "Synthetic phone edit" for r in manifest["records"])
                assert {r["client_id"] for r in manifest["results"]} == {op["client_id"]}
                assert manifest["results"][0]["status"] == "done"
        assert parent.execute("SELECT COUNT(*) FROM events").fetchone()[0] == 1
        assert parent.execute("SELECT COUNT(*) FROM transfer_applied").fetchone()[0] == 1
    monkeypatch.setattr(bluetooth, "serve", serve)
    try:
        cli.cmd_transfer(parent, args)
    finally:
        parent.close()


def test_android_fixture_upload_to_mac_and_receipt(tmp_path):
    encrypted = (Path(__file__).parent / "fixtures" / "android-edits.sherloq").read_bytes()
    conn = db.connect(":memory:")
    identity.create_person(conn, "Sample Person")
    source, _ = transfer._prepare(conn)
    conn.execute("UPDATE transfer_state SET source = ?", ("11111111-1111-4111-8111-111111111111",))
    conn.commit()
    try:
        assert transfer.apply_edits(conn, encrypted, PASSWORD)["applied"] == 1
        assert transfer.apply_edits(conn, encrypted, PASSWORD)["already_applied"] == 1
        assert conn.execute("SELECT name FROM people WHERE id=1").fetchone()[0] == "From Android"
        destination = tmp_path / "return.sherloq"
        transfer.export_snapshot(conn, destination, PASSWORD, include_photos=False)
        manifest = transfer.unpack(transfer.decrypt(destination.read_bytes(), PASSWORD))
        assert manifest["results"][0]["client_id"] == "22222222-2222-4222-8222-222222222222"
    finally:
        conn.close()
