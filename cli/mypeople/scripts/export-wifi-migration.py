#!/usr/bin/env python3
"""Read-only, complete graph export for a one-time Wi-Fi/USB file migration.
Never starts the engine, initializes/migrates a database, or imports anything.
The destination must be new and is authenticated/encrypted, owner-readable only.
"""
import argparse
import datetime
import json
from pathlib import Path
import sqlite3

from mypeople import relationships, stream_archive


def export(database, destination, password_file):
    database, destination = Path(database).resolve(), Path(destination).resolve()
    if destination.exists():
        raise ValueError("Choose a new encrypted destination; existing files are never overwritten")
    password = Path(password_file).read_text().strip()
    conn = sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("BEGIN")
        for table in ("graph_dirty", "graph_deleted"):
            if conn.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone():
                raise ValueError("The engine has unprojected changes. Finish the current sync and close the Mac app first")
        state = conn.execute("SELECT source,revision,publisher FROM transfer_state WHERE slot=1").fetchone()
        if state is None or state["revision"] <= 0:
            raise ValueError("Finish the existing QR upload before exporting the migration")
        commits = [json.loads(r[0]) for r in conn.execute("SELECT data FROM graph_commits ORDER BY rowid")]
        parents = {p for c in commits for p in c["parents"]}
        heads = sorted(c["id"] for c in commits if c["id"] not in parents)
        blobs = stream_archive.SqlBlobs(conn, conn.execute("SELECT hash,rowid,length(content) FROM graph_blobs"))
        results = []
        for row in conn.execute("SELECT client_id,kind,payload,status,message FROM transfer_applied WHERE status IN ('done','failed')"):
            result = dict(row); result["payload"] = json.loads(result["payload"]); result["id"] = 0
            results.append(result)
        # Only rebuildable relationship hints accompany the authority. Never
        # duplicate full cards/photos/originals in the native-screen projection.
        records = []
        today = datetime.date.today()
        for row in conn.execute("SELECT id,contact_uid FROM people WHERE merged_into IS NULL AND is_me=0"):
            hints = relationships.view_hints(relationships.infer(conn, row["id"], today))
            records.append({"kind": "person", "id": str(row["id"]), "data": {"name": "", "contact_uid": row["contact_uid"], **hints}})
        graph = {"collection": conn.execute("SELECT value FROM graph_meta WHERE key='collection'").fetchone()[0],
                 "heads": heads, "commits": commits, "blobs": blobs}
        manifest = {"format": 1, "type": "snapshot", "source": state["source"], "revision": state["revision"],
                    "publisher": state["publisher"], "created_at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                    "records": records, "results": results, "ops": [], "contact_version": 1, "contact_history": [], "contact_heads": [], "graph": graph}
        stream_archive.write_memory(manifest, destination, password)
        return {"commits": len(commits), "blobs": len(blobs), "raw_blob_bytes": blobs.raw_bytes,
                "encrypted_file_bytes": destination.stat().st_size}
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--password-file", type=Path, required=True)
    args = parser.parse_args()
    print(json.dumps(export(args.db, args.output, args.password_file), sort_keys=True))
