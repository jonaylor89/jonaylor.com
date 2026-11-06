"""Create a wholly synthetic pre-upgrade DB and complete encrypted load fixture.

Run from the repo root:
  uv run --project cli/mypeople python cli/mypeople/scripts/make-graph-load-fixture.py
Never opens the default database, credentials, phone or any real import source.
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import tempfile
import time
import uuid
from pathlib import Path

from mypeople import db, transfer


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", type=Path, help="new directory; existing paths are refused")
    args = parser.parse_args()
    if args.output_directory:
        root = args.output_directory.resolve()
        root.mkdir(parents=True, exist_ok=False)
    else:
        root = Path(tempfile.mkdtemp(prefix="mypeople-synthetic-graph-"))
    path = root / "source.db"
    legacy = sqlite3.connect(path)
    legacy.row_factory = sqlite3.Row
    legacy.executescript(db.SCHEMA)
    db._migrate(legacy)
    legacy.executemany("INSERT INTO people(id,name,contact_uid,contact_data) VALUES (?,?,?,?)", (
        (n + 1, f"Synthetic Person {n}", str(uuid.uuid5(uuid.NAMESPACE_URL, f"synthetic:{n}")),
         json.dumps({"name": f"Synthetic Person {n}", "fields": [{"kind": "email", "value": f"person-{n}@example.test"}]}))
        for n in range(2600)))
    legacy.executemany("INSERT INTO interactions(person_id,at,channel,direction,text,thread,source_ref) VALUES (?,?,?,?,?,?,?)", (
        (n % 2600 + 1, "2026-01-01T12:00:00+00:00", "sms", "in", f"Synthetic message {n}: test data only.",
         f"thread:{n % 2600}", f"synthetic:{n}") for n in range(329000)))
    legacy.commit()
    legacy.close()
    started = time.perf_counter()
    conn = db.connect(path)
    archive = root / "mypeople-synthetic-large.sherloq"
    try:
        result = transfer.export_snapshot(conn, archive, "synthetic-load-passphrase", include_photos=False)
    finally:
        conn.close()
    print(json.dumps({"archive": str(archive), "people": 2600, "messages": 329000,
                      "seconds": round(time.perf_counter() - started, 3), "result": result}, indent=2))


if __name__ == "__main__":
    main()
