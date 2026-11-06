"""Complete encrypted graph archives. Every peer gets all history and all blobs.

Separate format from legacy phone-safe snapshots; never silently drops messages,
full-size photos, unresolved alternatives, or retracted history to fit a transfer.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import zipfile
from pathlib import Path

from .graph import Graph, GraphError, Store, VERSION, encoded, transaction, valid_uuid
from .transfer import MAX_EXPANDED, MAX_FILE, decrypt, encrypt, write_file

MAX_ENTRIES = 1_000_000
MAX_MANIFEST = 128 * 1024 * 1024


def export_graph(store: Store, path: Path, password: str):
    if any(filename and Path(filename).resolve() == path.resolve() for _, _, filename in store.conn.execute("PRAGMA database_list")):
        raise GraphError("An archive must not overwrite an open database")
    with transaction(store.conn):
        graph = store.load()
        store.verify_references(graph)
        manifest = {"graph_version": VERSION, "collection": store.collection,
                    "heads": graph.heads, "commits": [graph.commits[key] for key in graph.order]}
        raw = encoded(manifest).encode()
        if len(raw) > MAX_MANIFEST:
            raise GraphError("Graph manifest exceeds archive limit; nothing was truncated")
        output, expanded, blobs = io.BytesIO(), len(raw), 0
        with zipfile.ZipFile(output, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("graph.json", raw)
            for digest, content in store.conn.execute("SELECT hash, content FROM graph_blobs ORDER BY hash"):
                if hashlib.sha256(content).hexdigest() != digest:
                    raise GraphError("Stored blob is damaged")
                expanded += len(content)
                blobs += 1
                if expanded > MAX_EXPANDED or blobs + 1 > MAX_ENTRIES:
                    raise GraphError("Complete graph exceeds archive limit; nothing was truncated")
                archive.writestr(f"blobs/{digest}", content)
        encrypted = encrypt(output.getvalue(), password)
    write_file(path, encrypted)
    return {"commits": len(graph.commits), "blobs": blobs, "bytes": len(encrypted)}


def import_graph(store: Store, path: Path, password: str, *, adopt=False):
    if path.stat().st_size > MAX_FILE:
        raise GraphError("Graph archive exceeds encrypted size limit")
    raw = decrypt(path.read_bytes(), password)
    try:
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            entries = archive.infolist()
            names = [entry.filename for entry in entries]
            if len(entries) > MAX_ENTRIES or sum(entry.file_size for entry in entries) > MAX_EXPANDED:
                raise GraphError("Graph archive exceeds expanded size limit")
            if len(set(names)) != len(names) or "graph.json" not in names or any(name != "graph.json" and re.fullmatch(r"blobs/[a-f0-9]{64}", name) is None for name in names):
                raise GraphError("Invalid graph archive paths")
            if archive.getinfo("graph.json").file_size > MAX_MANIFEST:
                raise GraphError("Graph manifest exceeds limit")
            manifest = json.loads(archive.read("graph.json"))
            if not isinstance(manifest, dict) or set(manifest) != {"graph_version", "collection", "heads", "commits"} or type(manifest["graph_version"]) is not int or manifest["graph_version"] != VERSION:
                raise GraphError("Unsupported graph archive")
            valid_uuid(manifest["collection"])
            if not isinstance(manifest["commits"], list) or not isinstance(manifest["heads"], list):
                raise GraphError("Invalid graph history")
            incoming = Graph(manifest["commits"])
            if incoming.heads != manifest["heads"] or (incoming.collection and incoming.collection != manifest["collection"]):
                raise GraphError("Invalid graph archive frontier")
            blobs = {name.split("/", 1)[1]: archive.read(name) for name in names if name.startswith("blobs/")}
        with transaction(store.conn):
            before = store.load()
            # Even an empty foreign archive requires explicit adoption.
            if manifest["collection"] != store.collection and (before.commits or store.conn.execute("SELECT 1 FROM graph_blobs LIMIT 1").fetchone() or not adopt):
                raise GraphError("Cannot join different collections")
            combined = store.receive(manifest["commits"], blobs, adopt=adopt)
            store.conn.execute("UPDATE graph_meta SET value=? WHERE key='collection'", (manifest["collection"],))
        return {"added": len(combined.commits) - len(before.commits), "commits": len(combined.commits), "blobs": len(blobs)}
    except (zipfile.BadZipFile, KeyError, TypeError, json.JSONDecodeError, UnicodeError, RuntimeError) as exc:
        raise GraphError("Invalid graph archive") from exc
