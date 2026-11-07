"""Wholly synthetic production-shaped graph: 152,547 ops, ~50 MB metadata,
37,461 raw blobs and 329,000 messages. NEVER reads a personal DB/key/import.
Existing output directories are refused. For disposable emulators only.
"""
import argparse
import base64
import hashlib
import io
import json
from pathlib import Path
import uuid

from PIL import Image
from mypeople import db, stream_archive
from mypeople.graph import Store, create_object, create_edge

PASSWORD = "synthetic-indexed-startup-passphrase"


def uid(label):
    return str(uuid.uuid5(uuid.NAMESPACE_URL, "synthetic-indexed-startup:" + label))


def make(root):
    root.mkdir(parents=True, mode=0o700)
    conn = db.connect(root / "synthetic-source.db")
    store = Store(conn)
    try:
        hashes = []
        for n in range(37461):
            if n >= 35203:
                out = io.BytesIO()
                Image.new("RGB", (64, 64), (n % 256, (n * 13) % 256, (n * 29) % 256)).save(out, format="PNG")
                content = out.getvalue() + hashlib.shake_256(str(n).encode()).digest(12000)
            elif n >= 29658:
                count = 58 + int(n - 29658 < 546)
                content = json.dumps([{"id": n * 100 + i, "at": "2026-10-15 12:00:00", "direction": "in" if i % 2 else "out", "channel": "sms", "text": f"Wholly synthetic message {n}:{i}", "source_ref": f"synthetic:{n}:{i}"} for i in range(count)]).encode()
            else:
                content = json.dumps({"synthetic": n, "original": base64.b64encode(hashlib.shake_256(str(n).encode()).digest(10500)).decode()}).encode()
            hashes.append(store.put_blob(content))
            if n % 256 == 0: conn.commit()
        conn.commit()
        operations = []
        def obj(kind, n, properties):
            operation = create_object(kind, properties, id=uid(f"{kind}:{n}"))
            operations.append(operation)
            return operation["target"]
        def edge(kind, a, b, properties=None):
            operations.append(create_edge(kind, a, b, properties or {}))
        people = [obj("Person", n, {"legacy_id": n + 1, "legacy_contact_uid": uid(f"Person:{n}"), "is_me": n == 0}) for n in range(3290)]
        names = [obj("Name", n, {"display": f"Synthetic indexed person {n}", "given": "Synthetic", "family": f"Person {n}"}) for n in range(3584)]
        for n, name in enumerate(names): edge("has_name", people[n % len(people)], name)
        for n in range(3302):
            preference = obj("RelationshipPreferences", n, {"origin": "contact_card", "favorite": False, "region": "US"})
            edge("has_preferences", people[n % len(people)], preference)
        for n in range(3290):
            note = obj("Note", n, {"body": f"Wholly synthetic note {n}: " + "test evidence only. " * 10, "origin": "contact_card_notes"})
            edge("has_note", people[n % len(people)], note)
        points = []
        for n in range(10379):
            point = obj("ContactPoint", n, {"kind": "email", "value": f"indexed-{n}@example.test", "label": "Synthetic", "region": "US", "user_added": False})
            points.append(point); edge("has_contact_point", people[n % len(people)], point)
        claims = []
        for n in range(19372):
            claim = obj("Claim", n, {"predicate": "synthetic_fact", "value": f"Wholly synthetic fact {n}. " + "No personal information. " * 18, "confidence": .8, "source": "synthetic", "date": "2026-10-15", "status": "active"})
            claims.append(claim); edge("subject_of", people[n % len(people)], claim)
        sources = [obj("SourceRecord", n, {"system": "synthetic_indexed_qa", "table": "synthetic", "original": {"blob_hash": hashes[n]}}) for n in range(29658)]
        for n in range(22771): edge("originated_from", claims[n] if n < len(claims) else points[(n-len(claims)) % len(points)], sources[n])
        for n in range(5663):
            batch = obj("InteractionBatch", n, {"count": 58 + int(n < 546), "channel": "sms", "first_at": "2026-10-15 12:00:00", "last_at": "2026-10-15 12:00:00", "records": {"blob_hash": hashes[29658+n]}, "thread": f"synthetic-thread:{n}"})
            edge("participant", batch, people[n % len(people)])
        for n in range(2258):
            asset = obj("Asset", n, {"role": "contact_photo", "content": {"blob_hash": hashes[35203+n]}})
            edge("has_asset", people[n % len(people)], asset)
        for n in range(54):
            moment = obj("Moment", n, {"kind": "synthetic", "reason": "Wholly synthetic reminder", "surfaced_on": "2026-11-06", "status": "new"})
            edge("about", moment, people[n])
        for n in range(713): edge("same_person", people[n], people[2577+n], {"origin": "explicit_merge", "preferred_person": people[n]})
        for n in range(311): edge("distinct_person", people[n], people[(n+1) % 2577])
        graph = store.load()
        commit = graph.commit(store.peer, operations, collection=store.collection)
        store.receive([commit]); conn.commit()
        blobs = stream_archive.SqlBlobs(conn, conn.execute("SELECT hash,rowid,length(content) FROM graph_blobs"))
        memory = {"format": 1, "type": "snapshot", "source": uid("source"), "publisher": uid("publisher"), "revision": 1, "created_at": "2026-11-06T00:00:00Z", "records": [], "results": [], "ops": [],
                  "graph": {"collection": commit["collection"], "heads": [commit["id"]], "commits": [commit], "blobs": blobs}}
        archive = root / "mypeople-synthetic-indexed.sherloq"
        stream_archive.write_memory(memory, archive, PASSWORD)
        print(json.dumps({"archive": str(archive), "operations": len(operations), "metadata_bytes": len(json.dumps(commit).encode()), "blobs": len(blobs), "raw_blob_bytes": blobs.raw_bytes, "messages": 329000}))
    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-directory", required=True, type=Path)
    make(parser.parse_args().output_directory)
