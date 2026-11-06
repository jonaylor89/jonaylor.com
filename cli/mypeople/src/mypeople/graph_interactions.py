"""Bounded, lossless interaction blobs and incremental SQL materialization.

Wire payloads contain no SQL identities. A batch has one explicit participant and
at most 256 records grouped by original owner/channel/thread. Updating a record
replaces the content reference, never the old immutable blob. Local indexes are
not replicated. Both helpers run in the runtime's outer transaction; capture's
operations MUST be appended before that transaction commits. project must run
with the runtime's dirty triggers suppressed. Neither helper commits.
"""
from __future__ import annotations

import gzip
import hashlib
import io
import json
from collections import defaultdict

from .graph import GraphError, Store, create_edge, create_object, encoded, valid_uuid

BATCH_SIZE = 256
MAX_BATCH_JSON = 16 * 1024 * 1024


def _write(store, rows):
    raw = encoded(rows).encode()
    if len(raw) > MAX_BATCH_JSON:
        raise GraphError("Interaction batch exceeds the lossless payload limit")
    return store.put_blob(gzip.compress(raw, mtime=0))


def _schema(conn):
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name='graph_interaction_batches'").fetchone():
        return
    conn.execute("""CREATE TABLE graph_interaction_batches (
        entity TEXT PRIMARY KEY, digest TEXT NOT NULL, owner TEXT NOT NULL,
        edge TEXT NOT NULL, person_id INTEGER NOT NULL)""")
    conn.execute("""CREATE TABLE graph_interaction_rows (
        source_ref TEXT PRIMARY KEY, row_id INTEGER NOT NULL UNIQUE,
        batch TEXT NOT NULL, original_owner TEXT NOT NULL)""")
    conn.execute("CREATE INDEX graph_interaction_rows_batch ON graph_interaction_rows(batch)")


def _raw(row):
    return {k: v for k, v in dict(row).items() if k not in ("id", "person_id", "_rowid_")}


def _read(conn, digest):
    row = conn.execute("SELECT content FROM graph_blobs WHERE hash=?", (digest,)).fetchone()
    if row is None or hashlib.sha256(row[0]).hexdigest() != digest:
        raise GraphError("Missing or damaged interaction batch content")
    try:
        raw = row[0]
        if raw.startswith(b"\x1f\x8b"):
            with gzip.GzipFile(fileobj=io.BytesIO(raw)) as stream:
                raw = stream.read(MAX_BATCH_JSON + 1)
        if len(raw) > MAX_BATCH_JSON:
            raise GraphError("Interaction batch exceeds the lossless payload limit")
        rows = json.loads(raw)
    except (ValueError, UnicodeError, OSError, EOFError):
        raise GraphError("Invalid interaction batch JSON") from None
    if not isinstance(rows, list) or not 1 <= len(rows) <= BATCH_SIZE:
        raise GraphError("Interaction batch must contain 1..256 records")
    refs = set()
    for item in rows:
        if (not isinstance(item, dict) or any(k in item for k in ("id", "person_id", "_rowid_"))
                or not isinstance(item.get("source_ref"), str) or not item["source_ref"]
                or item["source_ref"] in refs):
            raise GraphError("Invalid interaction batch record identity")
        refs.add(item["source_ref"])
    return rows


def _metadata(rows, digest):
    channel, thread = rows[0].get("channel"), rows[0].get("thread")
    if any(r.get("channel") != channel or r.get("thread") != thread for r in rows):
        raise GraphError("Interaction batch crosses channel/thread boundaries")
    times = sorted(r["at"] for r in rows if isinstance(r.get("at"), str) and r["at"])
    return {"content": {"blob_hash": digest}, "count": len(rows), "channel": channel,
            "thread": thread, "first_at": times[0] if times else "", "last_at": times[-1] if times else ""}


def batch_label(properties):
    """An explicit whole-chunk selection, not a claim about inferred identity."""
    p = properties
    return (f"{p.get('count', 0)} messages · {p.get('channel') or 'unknown'}"
            + (f" · {p['thread']}" if p.get("thread") else "")
            + (f" · {p['first_at']} – {p.get('last_at', '')}" if p.get("first_at") else ""))


def capture(conn, graph, operations, *, archive=False):
    """Consume interaction dirty markers, adding O(chunks) graph operations.

    Call after assigning person UUIDs. New imports are streamed in bounded chunks;
    only changed existing chunks are decoded. Original ownership is copied from
    the local mapping, never guessed from a name, thread, or merged component.
    """
    _schema(conn)
    store = Store(conn)
    changed = {}
    pending = defaultdict(list)

    def load(batch):
        if batch not in changed:
            state = conn.execute("SELECT digest,owner,edge,person_id FROM graph_interaction_batches WHERE entity=?", (batch,)).fetchone()
            if state is None:
                raise GraphError("Missing local interaction batch mapping")
            if graph.objects.get(batch, {}).get("type") == "Interaction":
                rows = [_raw({key: graph.value(batch, key) for entity, key in graph.versions if entity == batch and not key.startswith('_')})]
            else:
                rows = _read(conn, state[0])
            changed[batch] = (state, {r["source_ref"]: r for r in rows})
        return changed[batch]

    def flush(key):
        rows = sorted(pending.pop(key), key=lambda r: r["source_ref"])
        owner, original, channel, thread, local = key
        digest = _write(store, rows)
        p = _metadata(rows, digest) | {"encoding": "gzip-json"} | {"original_owner": original,
                "attribution_quality": "legacy_current_owner" if archive else "asserted"}
        obj = create_object("InteractionBatch", p)
        edge = create_edge("participant", obj["target"], owner,
                           {"attribution_quality": p["attribution_quality"]})
        operations.extend((obj, edge))
        batch = obj["target"]
        conn.execute("INSERT INTO graph_interaction_batches VALUES (?,?,?,?,?)",
                     (batch, digest, owner, edge["target"], local))
        for r in rows:
            # source_ref is the stable cross-peer identity, rowid stays local.
            rowid = conn.execute("SELECT id FROM interactions WHERE source_ref=?", (r["source_ref"],)).fetchone()[0]
            conn.execute("INSERT OR REPLACE INTO graph_interaction_rows VALUES (?,?,?,?)",
                         (r["source_ref"], rowid, batch, original))

    # DELETE/INSERT may reuse a local ID; retire the old mapping first.
    deleted = conn.execute("""SELECT m.source_ref,m.batch FROM graph_deleted d
        JOIN graph_interaction_rows m ON m.row_id=d.row_id WHERE d.table_name='interactions'""").fetchall()
    for ref, batch in deleted:
        load(batch)[1].pop(ref, None)
        conn.execute("DELETE FROM graph_interaction_rows WHERE source_ref=?", (ref,))

    cursor = conn.execute("""SELECT i.*,p.contact_uid AS _owner,
        m.source_ref AS _old_ref,m.batch AS _batch,m.original_owner AS _original
        FROM graph_dirty d JOIN interactions i ON i.id=d.row_id
        LEFT JOIN people p ON p.id=i.person_id
        LEFT JOIN graph_interaction_rows m ON m.row_id=i.id
        WHERE d.table_name='interactions'
        ORDER BY i.person_id,i.channel,i.thread,i.id""")
    columns = [c[0] for c in cursor.description]
    for raw in cursor:
        v = dict(zip(columns, raw))
        owner, ref, batch, original = (v.pop(k) for k in ("_owner", "_old_ref", "_batch", "_original"))
        if not owner:
            raise GraphError("Interaction owner has no graph UUID")
        record = _raw(v)
        if not isinstance(record.get("source_ref"), str) or not record["source_ref"]:
            raise GraphError("Interaction requires stable source_ref")
        if batch:
            state, rows = load(batch)
            before = rows.pop(ref, None)
            if before == record and state[3] == v["person_id"]:
                rows[ref] = before
                continue
            if state[3] == v["person_id"] and before and (before.get("channel"), before.get("thread")) == (record.get("channel"), record.get("thread")):
                rows[record["source_ref"]] = record
                conn.execute("UPDATE graph_interaction_rows SET source_ref=? WHERE row_id=?", (record["source_ref"], v["id"]))
                continue
            conn.execute("DELETE FROM graph_interaction_rows WHERE row_id=?", (v["id"],))
        key = (owner, original or owner, record.get("channel"), record.get("thread"), v["person_id"])
        # Input is grouped; flush partial chunks at group boundaries rather
        # than retaining one partial payload for every person in the import.
        if pending and key not in pending:
            for previous_key in list(pending):
                flush(previous_key)
        pending[key].append(record)
        if len(pending[key]) == BATCH_SIZE:
            flush(key)
    for key in list(pending):
        flush(key)

    for batch, (state, by_ref) in changed.items():
        if not by_ref:
            if graph.active(state[2]):
                operations.append(graph.edit(state[2], "_lifecycle", "retracted"))
            conn.execute("DELETE FROM graph_interaction_batches WHERE entity=?", (batch,))
            continue
        rows = sorted(by_ref.values(), key=lambda r: r["source_ref"])
        if graph.objects.get(batch, {}).get("type") == "Interaction":
            # Legacy single objects remain singles when flags/text are edited.
            values = rows[0]
            for key, value in values.items():
                if graph.value(batch, key) != value:
                    operations.append(graph.edit(batch, key, value))
            digest = hashlib.sha256(encoded(values).encode()).hexdigest()
        else:
            digest = _write(store, rows)
            for key, value in (_metadata(rows, digest) | {"encoding": "gzip-json"}).items():
                if graph.value(batch, key) != value:
                    operations.append(graph.edit(batch, key, value))
        conn.execute("UPDATE graph_interaction_batches SET digest=? WHERE entity=?", (digest, batch))
    conn.execute("DELETE FROM graph_dirty WHERE table_name='interactions'")
    conn.execute("DELETE FROM graph_deleted WHERE table_name='interactions'")


def project(conn, graph, *, props=None, canonical=None, people=None):
    """Incrementally project batches and legacy/override Interaction entities.

    Caller supplies canonical UUID -> displayed local person ID as ``people``.
    Without indexes the helper derives them. Stable source_ref reuses local IDs.
    Unchanged batches never read payloads or update any interaction SQL rows.
    """
    _schema(conn)
    if canonical is None:
        canonical = {p: root for root, members in graph.components()["groups"].items() for p in members}
    if people is None:
        people = {r[0]: r[1] for r in conn.execute("SELECT contact_uid,id FROM people WHERE merged_into IS NULL")}
    if props is None:
        props = defaultdict(dict)
        for (entity, key), versions in graph.versions.items():
            if not key.startswith('_') and versions:
                props[entity][key] = versions[max(versions)]

    def values(obj):
        return props.get(obj, {})

    # Select only explicit participant endpoints. No owner is inferred for blobs
    # lacking an attribution. Multiple explicit edges remain in graph history.
    active = {}
    for eid, edge in sorted(graph.edges.items()):
        obj = edge["from"]
        if (edge["type"] == "participant" and graph.active(eid) and graph.active(obj)
                and graph.objects.get(obj, {}).get("type") in ("InteractionBatch", "Interaction")):
            owner = edge["to"]
            root = canonical.get(owner, owner)
            if root not in people:
                raise GraphError("Interaction participant is missing from SQL projection")
            active[obj] = (owner, eid, people[root])
    previous = {r[0]: tuple(r[1:]) for r in conn.execute("SELECT entity,digest,owner,edge,person_id FROM graph_interaction_batches")}
    removed_override = any(graph.objects.get(obj, {}).get("type") == "Interaction"
                           for obj in previous.keys() - active.keys())
    obsolete = []
    for obj in previous.keys() - active.keys():
        obsolete.extend((ref, rowid, obj) for ref, rowid in conn.execute(
            "SELECT source_ref,row_id FROM graph_interaction_rows WHERE batch=?", (obj,)))
        conn.execute("DELETE FROM graph_interaction_batches WHERE entity=?", (obj,))

    singles = {obj: _raw(values(obj)) for obj in active if graph.objects[obj]["type"] == "Interaction"}
    overrides = {p.get("source_ref", "graph:" + obj) for obj, p in singles.items()}
    columns = {r[1] for r in conn.execute("PRAGMA table_info(interactions)")} - {"id", "person_id"}
    # Singles follow batches, so explicit individual source_ref overrides win.
    for obj in sorted(active, key=lambda o: (o in singles, o)):
        owner, edge, local = active[obj]
        p = values(obj)
        single = obj in singles
        if single:
            row = {k: v for k, v in singles[obj].items() if k not in ("compat_table", "content")}
            row.setdefault("source_ref", "graph:" + obj)
            row.setdefault("at", row.get("timestamp", ""))
            row.setdefault("channel", "unknown")
            row.setdefault("direction", "in")
            row.setdefault("text", None)
            row.setdefault("thread", None)
            row.setdefault("extracted", 0)
            rows = [row]
            digest = hashlib.sha256(encoded(row).encode()).hexdigest()
        else:
            digest = (p.get("content") or {}).get("blob_hash")
            if not isinstance(digest, str):
                raise GraphError("Interaction batch has no content reference")
        signature = (digest, owner, edge, local)
        if previous.get(obj) == signature and (single or not removed_override):
            continue
        if not single:
            valid_uuid(p.get("original_owner"))
            rows = _read(conn, digest)
            metadata = _metadata(rows, digest)
            if any(p.get(k) != value for k, value in metadata.items()):
                raise GraphError("Interaction batch metadata does not match content")
        wanted = {r["source_ref"] for r in rows if single or r["source_ref"] not in overrides}
        old = conn.execute("SELECT source_ref,row_id FROM graph_interaction_rows WHERE batch=?", (obj,)).fetchall()
        for ref, rowid in old:
            if ref not in wanted:
                obsolete.append((ref, rowid, obj))
        for r in rows:
            ref = r["source_ref"]
            if ref not in wanted:
                continue
            v = {k: encoded(value) if isinstance(value, (dict, list)) else value for k, value in r.items() if k in columns}
            v["person_id"] = local
            keys = list(v)
            sql = (f'INSERT INTO interactions ({",".join(keys)}) VALUES ({",".join("?" for _ in keys)}) '
                   f'ON CONFLICT(source_ref) DO UPDATE SET {",".join(k + "=excluded." + k for k in keys if k != "source_ref")}')
            conn.execute(sql, [v[k] for k in keys])
            rowid = conn.execute("SELECT id FROM interactions WHERE source_ref=?", (ref,)).fetchone()[0]
            original = p.get("original_owner") or owner
            conn.execute("INSERT OR REPLACE INTO graph_interaction_rows VALUES (?,?,?,?)", (ref, rowid, obj, original))
        conn.execute("INSERT OR REPLACE INTO graph_interaction_batches VALUES (?,?,?,?,?)", (obj, *signature))
    # Defer removals until all new chunks/overrides have claimed source_refs.
    # A moved record must UPDATE its old row, not DELETE/INSERT with a new ID.
    for ref, rowid, obj in obsolete:
        mapping = conn.execute("SELECT batch FROM graph_interaction_rows WHERE source_ref=?", (ref,)).fetchone()
        if mapping and mapping[0] == obj:
            conn.execute("DELETE FROM interactions WHERE id=?", (rowid,))
            conn.execute("DELETE FROM graph_interaction_rows WHERE source_ref=?", (ref,))
