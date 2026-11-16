"""Replicated avatar candidates and explicit selection; blobs remain graph-owned.

A candidate is provenance, not image content. Identical bytes share a blob, while
source identities and original attribution remain separate through merges/splits.
"""
from __future__ import annotations

import datetime as dt
import hashlib
from pathlib import Path

from .graph import Store, GraphError, create_object, create_edge


def view(graph, person: str, *, members=None, assets=None):
    members = members or next((m for m in graph.components()["groups"].values() if person in m), [person])
    if assets is None:
        assets = {e["to"] for member in members for eid, e in graph.edges_from(member, {"has_asset"})
                  if graph.active(eid) and graph.active(e["to"])}
    candidates = []
    for obj in sorted(assets):
        p = {key: graph.value(obj, key) for key in graph.registers(obj)}
        digest = (p.get("content") or {}).get("blob_hash")
        if not digest or p.get("role") not in (None, "contact_photo", "profile_photo") or (p.get("role") is None and p.get("compat_table") != "photos"):
            continue
        candidates.append({"id": obj, "hash": digest, "source": p.get("source") or ("manual" if p.get("role") == "contact_photo" else "unknown"),
                           "source_identity": p.get("source_identity", ""), "width": p.get("width", 0), "height": p.get("height", 0),
                           "first_observed": p.get("first_observed", ""), "last_observed": p.get("last_observed", ""),
                           "source_updated_at": p.get("source_updated_at", ""), "legacy_manual": p.get("role") == "contact_photo"})
    choices = {v for member in members for v in graph.registers(member).get("photo_choice", {}).values() if isinstance(v, str)}
    # An explicit Automatic overrides the legacy editor's implicit manual choice.
    pinned = sorted(c["id"] for c in candidates if c["id"] in choices)
    if not choices:
        pinned = sorted(c["id"] for c in candidates if c["legacy_manual"])
    def rank(c):
        # Do not use download time as avatar freshness. Cap resolution utility;
        # a newer adequate avatar wins, while unknown dates stay unknown.
        side = min(c["width"], c["height"] or c["width"])
        return (side >= 96, c["source_updated_at"], min(side, 512), c["id"])
    automatic = max(candidates, key=rank, default=None)
    selected = next((c for c in candidates if pinned and c["id"] == pinned[0]), None) or automatic
    return {"candidates": candidates, "automatic_selected": automatic["id"] if automatic else "", "selected": selected["id"] if selected else "", "preferred": pinned[0] if pinned else "",
            "automatic": bool(choices == {""} or not choices and not pinned), "conflict": len(choices) > 1,
            "unavailable_preference": bool(choices - {""} and not pinned),
            "observed": sorted(op for member in members for op in graph.registers(member).get("photo_choice", {}))}


def _path(conn, digest):
    database = conn.execute("PRAGMA database_list").fetchone()[2]
    if database:
        directory = Path(database).parent / (Path(database).name + ".assets")
    else:
        import tempfile
        directory = Path(tempfile.gettempdir()) / ("mypeople-graph-" + Store(conn).collection)
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    path = directory / digest
    if not path.exists():
        blob = conn.execute("SELECT content FROM graph_blobs WHERE hash=?", (digest,)).fetchone()
        if not blob:
            return None
        from .transfer import write_file
        write_file(path, blob[0])
    return str(path)


def list_for(conn, person: str):
    from . import graph_runtime
    graph = graph_runtime.capture(conn)
    result = view(graph, person)
    for c in result["candidates"]:
        c["path"] = _path(conn, c["hash"])
    return result


def choose(conn, person: str, candidate: str, *, observed=None):
    from . import graph_runtime
    with graph_runtime._atomic(conn):
        graph = graph_runtime.capture(conn)
        members = next((m for m in graph.components()["groups"].values() if person in m), None)
        if members is None:
            raise GraphError("This contact is no longer available")
        result = view(graph, person, members=members)
        if observed is not None and observed != result["observed"]:
            raise GraphError("The photo preference changed on another device. Reload photos before choosing again.")
        if candidate and candidate not in {c["id"] for c in result["candidates"]}:
            raise GraphError("This photo is no longer available. Reopen the photo chooser.")
        ops = [graph.edit(member, "photo_choice", candidate) for member in members]
        graph_runtime.project(conn, graph_runtime._append(conn, graph, ops))


def save(conn, person_id: int, source: str, data: bytes, *, source_identity="", source_updated_at="") -> bool:
    from . import graph_runtime, photos
    if source_updated_at:
        timestamp = dt.datetime.fromisoformat(source_updated_at.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("A photo source timestamp needs a timezone")
        source_updated_at = timestamp.astimezone(dt.timezone.utc).isoformat().replace("+00:00", "Z")
    width, height = photos.image_dimensions(data)
    if not width or not height or width > 16384 or height > 16384 or width * height > 40_000_000 or len(data) > 10 * 1024 * 1024:
        return False
    with graph_runtime._atomic(conn):
        graph = graph_runtime.capture(conn)
        person = conn.execute("SELECT contact_uid FROM people WHERE id=?", (person_id,)).fetchone()[0]
        if not source_identity:
            identifiers = conn.execute("SELECT kind,value FROM identifiers WHERE person_id=? AND source=? ORDER BY kind,value", (person_id, source)).fetchall()
            source_identity = "|".join(f"{r[0]}:{r[1]}" for r in identifiers)
        digest = hashlib.sha256(data).hexdigest()
        current = view(graph, person)["candidates"]
        previous = next((c for c in current if c["hash"] == digest and c["source"] == source and c["source_identity"] == source_identity), None)
        now = dt.datetime.now(dt.timezone.utc).isoformat()
        if previous:
            rows = conn.execute("SELECT path FROM photos WHERE person_id=? AND source=?", (person_id, source)).fetchall()
            missing = any(not Path(r[0]).is_file() for r in rows)
            _path(conn, digest)  # restore disposable files from the authoritative blob
            observations = []
            if previous["last_observed"][:10] != now[:10]:
                observations.append(graph.edit(previous["id"], "last_observed", now))
            if source_updated_at and source_updated_at > previous["source_updated_at"]:
                observations.append(graph.edit(previous["id"], "source_updated_at", source_updated_at))
            if observations:
                graph_runtime.project(conn, graph_runtime._append(conn, graph, observations))
            return missing
        Store(conn).put_blob(data)
        props = {"content": {"blob_hash": digest}, "role": "profile_photo", "compat_table": "photos", "source": source,
                 "source_identity": source_identity, "width": width, "height": height,
                 "first_observed": now, "last_observed": now, "source_updated_at": source_updated_at}
        obj = create_object("Asset", props)
        graph_runtime.project(conn, graph_runtime._append(conn, graph, [obj, create_edge("has_asset", person, obj["target"])]))
        return True
