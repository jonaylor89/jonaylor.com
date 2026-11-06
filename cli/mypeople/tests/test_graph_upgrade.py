"""Automatic application cutover preserves and backs up existing local data."""
import json
import sqlite3
from pathlib import Path

import pytest

from mypeople import db, graph_runtime

UID = "60000000-0000-4000-8000-000000000001"


def legacy(path):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(db.SCHEMA)
    db._migrate(conn)
    conn.execute("INSERT INTO people(name,contact_uid,contact_data) VALUES ('Cameron', ?, ?)", (UID, json.dumps({"name": "Cameron", "fields": [{"kind": "phone", "value": "+12025550101"}, {"kind": "phone", "value": "+12025550102"}], "originals": ["BEGIN:VCARD\nFN:Cameron\nX-RETAIN:synthetic\nEND:VCARD"]})))
    conn.execute("INSERT INTO interactions(person_id,at,channel,direction,text,thread,source_ref) VALUES (1,'2026-01-01','sms','in','Synthetic original','phone-b','synthetic:upgrade')")
    conn.commit()
    return conn


def test_first_open_backs_up_before_cutover_and_later_opens_do_not_overwrite_it(tmp_path):
    path = tmp_path / "legacy.db"
    legacy(path).close()
    conn = db.connect(path)
    backup = Path(conn.execute("SELECT value FROM graph_meta WHERE key='pre_graph_backup'").fetchone()[0])
    assert backup.parent == tmp_path and backup.stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(backup) as original:
        assert not original.execute("SELECT 1 FROM sqlite_master WHERE name='graph_runtime'").fetchone()
        assert original.execute("SELECT text FROM interactions").fetchone()[0] == "Synthetic original"
        assert "X-RETAIN:synthetic" in original.execute("SELECT contact_data FROM people").fetchone()[0]
    assert graph_runtime.enabled(conn)
    assert conn.execute("SELECT text FROM interactions").fetchone()[0] == "Synthetic original"
    saved = backup.read_bytes()
    conn.close()
    db.connect(path).close()
    assert list(tmp_path.glob("*.pre-graph-*.sqlite3")) == [backup]
    assert backup.read_bytes() == saved


def test_engine_reports_failed_cutover_instead_of_hanging_or_repeating_backups(tmp_path):
    import time
    from mypeople.appserver import Engine
    path = tmp_path / "legacy.db"
    source = legacy(path)
    source.execute("INSERT INTO photos(person_id,source,path) VALUES (1,'synthetic',?)", (str(tmp_path / "missing.png"),))
    source.commit()
    source.close()
    replies = []
    engine = Engine(path, lambda raw: replies.append(json.loads(raw)))
    engine.start()
    try:
        engine.submit({"id": 1, "method": "system.status", "params": {}})
        engine.submit({"id": 2, "method": "view.snapshot", "params": {}})
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and len([r for r in replies if r.get("id") in (1, 2)]) < 2:
            time.sleep(.01)
        results = {r.get("id"): r for r in replies if r.get("id") in (1, 2)}
        assert set(results) == {1, 2}
        assert all(r["error"]["code"] == "database" for r in results.values())
        assert len(list(tmp_path.glob("*.pre-graph-*.sqlite3"))) == 1
    finally:
        engine.stop()


def test_missing_asset_refuses_cutover_without_deleting_legacy_rows(tmp_path):
    path = tmp_path / "legacy.db"
    conn = legacy(path)
    conn.execute("INSERT INTO photos(person_id,source,path) VALUES (1,'synthetic',?)", (str(tmp_path / "missing.png"),))
    conn.commit()
    conn.close()
    with pytest.raises((FileNotFoundError, ValueError)):
        db.connect(path)
    with sqlite3.connect(path) as source:
        assert not source.execute("SELECT 1 FROM sqlite_master WHERE name='graph_runtime'").fetchone()
        assert source.execute("SELECT count(*) FROM interactions").fetchone()[0] == 1
        assert source.execute("SELECT count(*) FROM photos").fetchone()[0] == 1
    assert len(list(tmp_path.glob("*.pre-graph-*.sqlite3"))) == 1
