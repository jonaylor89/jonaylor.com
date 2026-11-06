#!/usr/bin/env python3
"""Wholly synthetic >256 MiB graph-file fixture. Never opens a personal DB/key."""
import argparse
from pathlib import Path
import tempfile

from mypeople import contacts, db, graph_runtime, transfer
from mypeople.graph import Store, create_object

PASSWORD = "synthetic-streaming-load-passphrase"
UID = "60000000-0000-4000-8000-000000000001"


def make(directory):
    directory = Path(directory)
    directory.mkdir(mode=0o700)
    conn = db.connect(directory / "synthetic-source.db")
    try:
        contacts.save(conn, UID, {"name": "Synthetic streaming load", "fields": []})
        graph = graph_runtime.capture(conn)
        operations = []
        for n in range(8):
            content = bytes([n]) * (34 * 1024 * 1024)
            digest = Store(conn).put_blob(content)
            operations.append(create_object("SourceRecord", {"original": {"blob_hash": digest}}))
            conn.commit()
        del content
        Store(conn).receive([graph.commit(Store(conn).peer, operations)])
        conn.commit()
        archive = directory / "mypeople-synthetic-stream.sherloq"
        stats = transfer.export_snapshot(conn, archive, PASSWORD, include_photos=False)
        print(f"Synthetic raw blobs: {272 * 1024 * 1024} bytes; archive: {archive}; encrypted: {stats['bytes']} bytes")
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", required=True, type=Path)
    make(parser.parse_args().output_directory)
