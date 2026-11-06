"""Authoritative graph and transactional SQL compatibility bridge.

Only immutable graph commits/blobs replicate. SQL row IDs and graph_rows are local
projection indexes. Triggers remember touched rows, so an import of a million rows
is reduced once at its transaction boundary, never once per INSERT. Remote
projection suppresses those triggers. No identity operation rewrites graph owners.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import sqlite3
from collections import defaultdict
from contextlib import contextmanager
from pathlib import Path

from .graph import (ATTRIBUTIONS, Graph, GraphError, Store, create_edge,
                    create_object, encoded, transaction, uid, valid_uuid)

TABLES = ("people", "aliases", "identifiers", "events", "interactions",
          "relationship_overrides", "moments", "photos", "profiles", "distinct_people")
KINDS = {"aliases": ("Name", "has_name"), "identifiers": ("ContactPoint", "has_contact_point"),
         "events": ("Claim", "subject_of"), "interactions": ("Interaction", "participant"),
         "relationship_overrides": ("RelationshipPreferences", "has_preferences"),
         "moments": ("Moment", "about"), "photos": ("Asset", "has_asset"),
         "profiles": ("Claim", "subject_of")}


@contextmanager
def _atomic(conn):
    # Reserve the writer before any read snapshot; two CLI processes must not
    # deadlock while upgrading a deferred read/savepoint to a write transaction.
    if not conn.in_transaction:
        conn.execute("BEGIN IMMEDIATE")
    with transaction(conn):
        yield


def enabled(conn):
    return bool(conn.execute("SELECT 1 FROM sqlite_master WHERE name='graph_runtime'").fetchone())


@contextmanager
def suppressed(conn):
    old = conn.execute("SELECT projecting FROM graph_runtime").fetchone()[0]
    conn.execute("UPDATE graph_runtime SET projecting=1")
    try:
        yield
    finally:
        conn.execute("UPDATE graph_runtime SET projecting=?", (old,))


def initialize(conn):
    """Upgrade in place, preserving current attribution and all original domain rows.

    Missing photos abort rather than silently losing data. This does not commit the
    caller's transaction. A fresh DB stays commit-free so it can adopt a collection.
    """
    with _atomic(conn):
        Store(conn)
        if enabled(conn):
            return
        conn.execute("CREATE TABLE graph_runtime (projecting INTEGER NOT NULL)")
        conn.execute("INSERT INTO graph_runtime VALUES (0)")
        conn.execute("CREATE TABLE graph_dirty (table_name TEXT, row_id INTEGER, PRIMARY KEY(table_name,row_id))")
        conn.execute("CREATE TABLE graph_deleted (table_name TEXT, row_id INTEGER, PRIMARY KEY(table_name,row_id))")
        conn.execute("CREATE TABLE graph_rows (table_name TEXT, row_id INTEGER, entity TEXT NOT NULL, edge TEXT, snapshot TEXT NOT NULL, PRIMARY KEY(table_name,row_id))")
        conn.execute("CREATE INDEX graph_rows_entity ON graph_rows(entity)")
        conn.execute("CREATE TABLE graph_children (person TEXT, key TEXT, entity TEXT NOT NULL, edge TEXT NOT NULL, snapshot TEXT NOT NULL, PRIMARY KEY(person,key))")
        existing = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        for table in TABLES:
            if table not in existing:
                continue
            for action, ref in (("INSERT", "NEW"), ("UPDATE", "NEW"), ("DELETE", "OLD")):
                deletion = f"INSERT OR IGNORE INTO graph_deleted VALUES ('{table}', OLD.rowid);" if action == "DELETE" else ""
                conn.execute(f'''CREATE TRIGGER graph_dirty_{table}_{action} AFTER {action} ON "{table}"
                    WHEN (SELECT projecting FROM graph_runtime)=0 BEGIN
                    INSERT OR IGNORE INTO graph_dirty VALUES ('{table}', {ref}.rowid); {deletion} END''')
            conn.execute(f"INSERT OR IGNORE INTO graph_dirty SELECT ?, rowid FROM {table}", (table,))
        graph = capture(conn, archive=True)
        # Preserve pre-cutover history/merge snapshots as opaque source originals;
        # these are evidence, not another active authority.
        ops = []
        store = Store(conn)
        for table in ("contact_changes", "contact_merge_undo"):
            if table in existing:
                cursor = conn.execute(f"SELECT * FROM {table}")
                columns = [c[0] for c in cursor.description]
                for row in cursor:
                    digest = store.put_blob(encoded(dict(zip(columns, row))).encode())
                    ops.append(create_object("SourceRecord", {"system": "legacy-mypeople", "table": table, "original": {"blob_hash": digest}}))
        if ops:
            _append(conn, graph, ops)


def _append(conn, graph, operations):
    if not operations:
        return graph
    store = Store(conn)
    commit = graph.commit(store.peer, operations, store.collection)
    # Validate before persisting; all batches share a single load/reduction.
    result = graph._append_local(commit)
    store.verify_references(result, commits=[commit])
    conn.execute("INSERT INTO graph_commits VALUES (?,?)", (commit["id"], encoded(commit)))
    return result


def _properties(graph):
    result = defaultdict(dict)
    for (entity, prop), versions in graph.versions.items():
        if prop != "_lifecycle" and versions:
            result[entity][prop] = versions[max(versions)]
    return result


def capture(conn, *, archive=False):
    if not enabled(conn):
        initialize(conn)
        return Store(conn).load()
    with _atomic(conn):
        graph = Store(conn).load()
        dirty = list(conn.execute("SELECT table_name,row_id FROM graph_dirty ORDER BY CASE table_name WHEN 'people' THEN 0 ELSE 1 END,table_name,row_id"))
        if not dirty:
            return graph
        store, ops = Store(conn), []
        props = _properties(graph)
        pending = {}
        def object_(kind, values, target=None):
            op = create_object(kind, values, id=target)
            ops.append(op)
            pending[op["target"]] = values
            return op["target"]
        def edge_(kind, a, b, values=None):
            op = create_edge(kind, a, b, values)
            ops.append(op)
            return op["target"]
        def edit(target, values):
            before = pending.get(target, props.get(target, {}))
            for key in before.keys() | values.keys():
                if before.get(key) != values.get(key):
                    ops.append(graph.edit(target, key, values.get(key)))
            pending[target] = values
        def retract(target):
            if target and graph.active(target):
                ops.append(graph.edit(target, "_lifecycle", "retracted"))
        def person_id(local):
            row = conn.execute("SELECT contact_uid FROM people WHERE id=?", (local,)).fetchone()
            if not row:
                raise GraphError("Orphaned SQL domain row")
            return row[0]
        # A DELETE followed by an INSERT may reuse an INTEGER PRIMARY KEY.
        # Retire the old identity before looking at the replacement row.
        for table,rowid in conn.execute("SELECT table_name,row_id FROM graph_deleted"):
            if table == "interactions": continue  # bounded blob batches own this bridge
            old = conn.execute("SELECT entity,edge FROM graph_rows WHERE table_name=? AND row_id=?",(table,rowid)).fetchone()
            if old:
                retract(old[1] or old[0])
                if table == "people":
                    conn.execute("DELETE FROM graph_children WHERE person=?",(old[0],))
                conn.execute("DELETE FROM graph_rows WHERE table_name=? AND row_id=?",(table,rowid))
        # People first: all association endpoints must precede their edge operations.
        for table, rowid in dirty:
            if table == "interactions": continue
            row = conn.execute(f'SELECT rowid AS _rowid_, * FROM "{table}" WHERE rowid=?', (rowid,)).fetchone()
            old = conn.execute("SELECT entity,edge,snapshot FROM graph_rows WHERE table_name=? AND row_id=?", (table,rowid)).fetchone()
            if row is None:
                if old:
                    retract(old[1] or old[0])
                    if table == "people":
                        retract(old[0])
                    conn.execute("DELETE FROM graph_rows WHERE table_name=? AND row_id=?", (table,rowid))
                continue
            values = dict(row)
            values.pop("_rowid_")
            snapshot = encoded(values)
            if old and old[2] == snapshot:
                continue
            entity, association = (old[0], old[1]) if old else (None, None)
            if table == "people":
                person = values["contact_uid"] or uid()
                valid_uuid(person)
                if not values["contact_uid"]:
                    with suppressed(conn):
                        conn.execute("UPDATE people SET contact_uid=? WHERE id=?", (person,rowid))
                    values["contact_uid"] = person
                    snapshot = encoded(values)
                if old and entity != person:
                    raise GraphError("A person UUID cannot be changed")
                entity = person
                card = json.loads(values.get("contact_data") or "{}")
                person_props = {"is_me": bool(values["is_me"]), "created_at": values["created_at"],
                                "attribution_quality": "legacy_current_owner" if archive else "asserted",
                                "card_metadata": ({"legacy_unverified":True} if not values.get("contact_data") else {}) | {k: v for k,v in card.items() if k not in CARD_KEYS}}
                # Do not change original attribution quality on ordinary SQL edits.
                if entity in graph.objects:
                    person_props["attribution_quality"] = props[entity].get("attribution_quality", "asserted")
                    edit(entity, person_props)
                else:
                    object_("Person", person_props, person)
                wanted = _card_entities(card, values["name"], store)
                children = {r[0]: r for r in conn.execute("SELECT key,entity,edge,snapshot FROM graph_children WHERE person=?", (person,))}
                for position, (key, (kind, relation, properties)) in enumerate(wanted.items()):
                    child = children.pop(key, None)
                    if child is None and key.startswith("field:"):
                        matches = [r for r in children.values() if r[0].startswith("field") and json.loads(r[3]) == properties]
                        if len(matches) == 1:
                            child = children.pop(matches[0][0])
                    if child is None and key.startswith("field_uid:"):
                        field_uid = key.partition(":")[2]
                        members = next((set(group) for group in graph.components()["groups"].values() if person in group), {person})
                        links = [(eid, edge) for eid, edge in graph.edges.items() if edge["type"] == "has_contact_point" and edge["from"] in members and edge["to"] == field_uid and graph.active(eid)]
                        if not links or graph.objects.get(field_uid, {}).get("type") != "ContactPoint":
                            raise GraphError("Contact field identity is not an association of this person")
                        edge_id = min(eid for eid, _ in links)
                        # Legacy matching hints have no card-child index. Preserve
                        # their provenance metadata when a derived card is saved.
                        properties = props[field_uid] | properties
                        if not card.get("legacy_unverified"):
                            properties.update(compat_table=None, matching_hint=False)
                        child = (key, field_uid, edge_id, encoded(props[field_uid]))
                    if child:
                        child_id, child_edge = child[1], child[2]
                        if json.loads(child[3]) != properties:
                            edit(child_id, properties)
                    else:
                        child_id = object_(kind, properties)
                        child_edge = edge_(relation, person, child_id, {"preferred": key == "name", "origin": "contact_card", "card_order":position})
                    storage_key = "field_uid:" + child_id if kind == "ContactPoint" else key
                    conn.execute("INSERT OR REPLACE INTO graph_children VALUES (?,?,?,?,?)", (person,storage_key,child_id,child_edge,encoded(properties)))
                for key, child_id, child_edge, _ in children.values():
                    retract(child_edge)
                    conn.execute("DELETE FROM graph_children WHERE person=? AND key=?", (person,key))
                trashed = bool(values.get("trashed"))
                if entity in graph.objects and (graph.value(entity, "_lifecycle") == "trashed") != trashed:
                    ops.append(graph.edit(entity, "_lifecycle", "trashed" if trashed else "active"))
                elif trashed and entity not in graph.objects:
                    creation = next(op for op in ops if op["target"] == entity and op["kind"] == "create_object")
                    ops.append({"id": uid(), "kind": "set_lifecycle", "target": entity, "payload": {"value": "trashed"}, "replaces": [creation["id"]]})
                before_merge = json.loads(old[2]).get("merged_into") if old else None
                after_merge = values.get("merged_into")
                if before_merge != after_merge:
                    for edge_id, e in graph.edges.items():
                        if e["type"] == "same_person" and entity in (e["from"], e["to"]) and graph.active(edge_id):
                            retract(edge_id)
                    if after_merge is not None:
                        # Created after the person pass, below.
                        pending["merge:" + person] = after_merge
            elif table == "distinct_people":
                if not entity:
                    entity = edge_("distinct_person", person_id(values["a"]), person_id(values["b"]))
            else:
                person = person_id(values["person_id"])
                kind, relation = KINDS[table]
                properties = {k:v for k,v in values.items() if k not in ("id", "person_id", "path")}
                properties["compat_table"] = table
                if table == "aliases":
                    properties = {"display": values["alias"], "label": "alias", "compat_table": table}
                elif table == "events":
                    if values["type"] == "note":
                        kind, relation = "Note", "has_note"
                        properties["body"] = values["value"]
                    else:
                        properties["predicate"] = values["type"]
                elif table == "profiles":
                    properties.update(predicate="public_profile", value=values["url"])
                elif table == "photos":
                    properties["content"] = {"blob_hash": store.put_blob(Path(values["path"]).read_bytes())}
                if entity:
                    edit(entity, properties)
                    previous_owner = json.loads(old[2]).get("person_id")
                    if previous_owner != values["person_id"]:
                        retract(association)
                        association = None
                else:
                    entity = object_(kind, properties)
                if not association:
                    association = edge_(relation, entity if relation in ("participant", "about") else person,
                                        person if relation in ("participant", "about") else entity,
                                        {"attribution_quality": "legacy_current_owner" if archive else "asserted"})
                if table == "interactions" and values.get("thread"):
                    thread_key = encoded([values["channel"], values["thread"]])
                    # Deterministic conversation UUID avoids duplicate thread objects.
                    import uuid
                    conversation = str(uuid.uuid5(uuid.UUID(store.collection), "conversation:" + thread_key))
                    if conversation not in graph.objects and conversation not in pending:
                        object_("Conversation", {"channel": values["channel"], "external_key": values["thread"]}, conversation)
                    if not old or json.loads(old[2]).get("thread") != values["thread"]:
                        if old:
                            for eid,e in graph.edges.items():
                                if e["type"] == "in_conversation" and e["from"] == entity:
                                    retract(eid)
                        edge_("in_conversation", entity, conversation)
            if archive:
                digest = store.put_blob(snapshot.encode())
                original = object_("SourceRecord", {"system": "legacy-mypeople", "table": table, "original": {"blob_hash": digest}})
                if table != "distinct_people":
                    edge_("originated_from", entity, original)
            conn.execute("INSERT OR REPLACE INTO graph_rows VALUES (?,?,?,?,?)", (table,rowid,entity,association,snapshot))
        from . import graph_interactions
        graph_interactions.capture(conn,graph,ops,archive=archive)
        for key, local in pending.items():
            if key.startswith("merge:"):
                edge_("same_person", key[6:], person_id(local), {"origin": "explicit_merge"})
        result = _append(conn, graph, ops)
        conn.execute("DELETE FROM graph_deleted")
        conn.execute("DELETE FROM graph_dirty")
        return result


CARD_KEYS = frozenset(("name", "given", "family", "middle", "prefix", "suffix", "phonetic", "fields", "notes", "birthday", "organization", "title", "photo", "favorite", "preferred_channel", "region"))


def _card_entities(card, name, store):
    wanted = {"name": ("Name", "has_name", {"display": name, **{k: card[k] for k in ("given","family","middle","prefix","suffix","phonetic") if k in card}})}
    for field in card.get("fields", []):
        field = {"label":"","preferred":False,"structured":"","region":""} | field
        object_id = field.pop("object_id", "")
        if object_id: valid_uuid(object_id)
        key = "field_uid:" + object_id if object_id else "field:" + encoded(field)
        wanted[key] = ("ContactPoint", "has_contact_point", field)
    # Empty scalar registers must already exist when peers fork, so two edits
    # of a previously empty field conflict instead of creating unrelated claims.
    wanted["notes"] = ("Note", "has_note", {"body": card.get("notes", ""), "origin": "contact_card_notes"})
    for key in ("birthday", "organization", "title"):
        wanted[key] = ("Claim", "subject_of", {"predicate": key, "value": card.get(key, ""), "asserted_by": "contact_card"})
    if card.get("photo"):
        try:
            data = base64.b64decode(card["photo"], validate=True)
        except (ValueError, binascii.Error):
            raise GraphError("Invalid contact photo") from None
        wanted["photo"] = ("Asset", "has_asset", {"content": {"blob_hash": store.put_blob(data)}, "role": "contact_photo"})
    # Preferences are attributable, versioned objects, not an opaque card.
    preferences = {"favorite":card.get("favorite",False),"preferred_channel":card.get("preferred_channel", ""),"region":card.get("region", "US")}
    if preferences:
        wanted["card_preferences"] = ("RelationshipPreferences", "has_preferences", preferences | {"origin": "contact_card"})
    return wanted


def bundle(conn, heads=None):
    graph = capture(conn)
    known = graph.past(heads or [])
    store = Store(conn)
    store.verify_references(graph)
    acknowledged_blobs = set()
    def references(value):
        if isinstance(value, dict):
            if isinstance(value.get("blob_hash"), str):
                acknowledged_blobs.add(value["blob_hash"])
            for child in value.values():
                references(child)
        elif isinstance(value, list):
            for child in value:
                references(child)
    for commit_id in known:
        references(graph.commits[commit_id]["operations"])
    return {"collection": store.collection, "heads": graph.heads,
            "commits": [graph.commits[c] for c in graph.order if c not in known],
            "blobs": {r[0]: base64.b64encode(r[1]).decode("ascii") for r in conn.execute("SELECT hash,content FROM graph_blobs") if r[0] not in acknowledged_blobs}}


def receive(conn, data):
    """Validate and merge a full or frontier-delta bundle atomically, then project SQL."""
    with _atomic(conn):
        if not enabled(conn):
            initialize(conn)
        current = capture(conn)
        if not isinstance(data, dict) or set(data) != {"collection", "heads", "commits", "blobs"}:
            raise GraphError("Invalid graph bundle")
        valid_uuid(data["collection"])
        if not isinstance(data["commits"], list) or not isinstance(data["heads"], list) or not isinstance(data["blobs"], dict):
            raise GraphError("Invalid graph bundle fields")
        store = Store(conn)
        if data["collection"] != store.collection and (current.commits or conn.execute("SELECT 1 FROM people LIMIT 1").fetchone()):
            raise GraphError("Cannot join different collections")
        merged = Graph([*current.commits.values(), *data["commits"]], copy_commits=False)
        if merged.collection and merged.collection != data["collection"]:
            raise GraphError("Bundle collection does not match its commits")
        # A sender's heads describe its own complete history (not the receiver's branches).
        sender_ids = merged.past(data["heads"])
        if any(c["id"] not in sender_ids for c in data["commits"]):
            raise GraphError("Bundle frontier omits commits")
        if len(set(data["heads"])) != len(data["heads"]):
            raise GraphError("Duplicate graph frontier")
        blobs = {}
        for digest, value in data["blobs"].items():
            try:
                content = base64.b64decode(value, validate=True) if isinstance(value, str) else None
            except (ValueError, binascii.Error):
                raise GraphError("Invalid graph blob encoding") from None
            if content is None or hashlib.sha256(content).hexdigest() != digest:
                raise GraphError("Blob hash does not match content")
            blobs[digest] = content
        # One validation/reduction per bundle, not a replay for every commit or
        # SQL row. All referenced blob availability is checked before writes.
        store.verify_references(merged, available_blobs=blobs)
        for content in blobs.values():
            store.put_blob(content)
        for commit in data["commits"]:
            conn.execute("INSERT OR IGNORE INTO graph_commits VALUES (?,?)", (commit["id"],encoded(commit)))
        if store.collection != data["collection"]:
            conn.execute("UPDATE graph_meta SET value=? WHERE key='collection'", (data["collection"],))
        project(conn, merged)
        return merged


def _view(graph):
    """Linear indexes shared by SQL/card/association projections."""
    props = _properties(graph)
    groups = graph.components()["groups"]
    canonical = {p: root for root, members in groups.items() for p in members}
    associations = defaultdict(list)
    for eid, edge in graph.edges.items():
        if not graph.active(eid):
            continue
        relation = edge["type"]
        if relation in ATTRIBUTIONS or relation == "about":
            person = edge["to"] if relation in ("participant", "about") else edge["from"]
            obj = edge["from"] if relation in ("participant", "about") else edge["to"]
            if obj in graph.objects and graph.active(obj):
                associations[canonical.get(person, person)].append((eid, relation, obj, person))
    return props, groups, canonical, associations


def _preferred_people(graph, canonical, props):
    preferred = {}
    rank = {c:i for i,c in enumerate(graph.order)}
    candidates = sorted(graph.edges, key=lambda e:(rank[graph.creation[e]],e))
    for eid in candidates:
        e = graph.edges[eid]
        person = props[eid].get("preferred_person")
        if e["type"] == "same_person" and graph.active(eid) and person in canonical:
            preferred[canonical[person]] = person
    return preferred


def cards(graph, conn=None):
    props, groups, canonical, associations = _view(graph)
    result = {}
    preferred = _preferred_people(graph,canonical,props)
    for root, members in groups.items():
        from .replica import DEFAULTS
        card = DEFAULTS | {"name": "Unnamed person", "fields": [], "originals": [], "source_records": []}
        regions = {owner:props[obj].get("region") for _,rel,obj,owner in associations[root] if rel == "has_preferences" and props[obj].get("region")}
        for member in sorted(members, reverse=True):
            card.update(props[member].get("card_metadata") or {})
        for key in ("originals","source_records"):
            card[key] = list(dict.fromkeys(v for member in members for v in (props[member].get(key) or (props[member].get("card_metadata") or {}).get(key,[]))))
        names, notes, conflicts = [], [], {}
        for eid, relation, obj, owner in sorted(associations[root],key=lambda row:(props[row[0]].get("card_order",1_000_000),row[0])):
            p = props[obj]
            if relation == "has_name":
                names.append((owner != preferred.get(root,root), not props[eid].get("preferred", False), p.get("label") == "alias", obj, p))
            elif relation == "has_contact_point":
                if (p.get("matching_hint") or p.get("compat_table") == "identifiers") and (not card.get("legacy_unverified") or p.get("kind") not in ("phone","email")):
                    continue
                field = {"label":"","preferred":False,"structured":"","region":""} | {k:v for k,v in p.items() if k not in ("compat_table", "source", "matching_hint")}
                if len(members) > 1 and field.get("kind") == "phone" and not field.get("region") and regions.get(owner):
                    field["region"] = regions[owner]
                field["object_id"] = obj
                if field.get("kind") and field.get("value") and field not in card["fields"]:
                    card["fields"].append(field)
            elif relation == "has_note" and p.get("origin") in ("contact_card_notes", "legacy_card_notes"):
                notes.append(p.get("body", ""))
            elif relation == "subject_of" and p.get("predicate") in ("birthday", "organization", "title") and p.get("asserted_by") in ("contact_card", "legacy_contact_card"):
                if p.get("value") or not card.get(p["predicate"]):
                    card[p["predicate"]] = p.get("value", "")
            elif relation == "has_preferences":
                card.update({k:p[k] for k in ("favorite", "preferred_channel", "region") if k in p})
            elif relation == "has_asset" and p.get("role") == "contact_photo" and conn is not None:
                digest = (p.get("content") or {}).get("blob_hash")
                blob = conn.execute("SELECT content FROM graph_blobs WHERE hash=?", (digest,)).fetchone()
                if blob:
                    card["photo"] = base64.b64encode(blob[0]).decode("ascii")
        if names:
            name = min(names)[4]
            card.update({k:v for k,v in name.items() if k in ("given","family","middle","prefix","suffix","phonetic")})
            card["name"] = name.get("display") or "Unnamed person"
        if notes:
            card["notes"] = "\n\n".join(dict.fromkeys(n for n in notes if n))
        result[root] = {"uid": root, "members": members, "card": card, "conflicts": conflicts,
                        "trashed": all(not graph.active(p) for p in members),
                        "is_me": any(props[p].get("is_me", False) for p in members)}
    # Decisions authored by native peers use the original foundation schema.
    targets = defaultdict(list)
    for eid,e in graph.edges.items():
        if e["type"] == "targets" and graph.active(eid):
            targets[e["from"]].append(e["to"])
    for obj, base in graph.objects.items():
        if base["type"] != "Decision" or not graph.active(obj):
            continue
        p = props[obj]
        for target in targets[obj]:
            root = canonical.get(target)
            if root in result and p.get("action") in ("favorite", "preferred_channel", "region"):
                if p["action"] == "favorite":
                    result[root]["card"]["favorite"] = bool(result[root]["card"].get("favorite") or p.get("value"))
                elif target == preferred.get(root,root) or not result[root]["card"].get(p["action"]):
                    result[root]["card"][p["action"]] = p.get("value")
    # Register conflicts map back to editable card field names for the existing UI.
    owner_by_object = {obj: root for root, rows in associations.items() for _,_,obj,_ in rows}
    for (obj, prop), versions in graph.versions.items():
        if len({encoded(v) for v in versions.values()}) <= 1:
            continue
        root = canonical.get(obj, owner_by_object.get(obj))
        if root not in result:
            continue
        field = "name" if prop == "display" else "notes" if prop == "body" and props[obj].get("origin") in ("contact_card_notes","legacy_card_notes") else props[obj].get("predicate",prop) if prop == "value" and props[obj].get("asserted_by") in ("contact_card","legacy_contact_card") else prop
        result[root]["conflicts"][field] = [{"change": operation, "value": value, "entity": obj, "property": prop} for operation,value in sorted(versions.items())]
    return result


def project(conn, graph=None):
    """Rebuild compatibility rows from graph entities; graph attribution is untouched.

    Local IDs are reused across remote refreshes, including after splits. SQL unique
    collisions may hide a duplicate compatibility row, never its graph object.
    """
    graph = graph or Store(conn).load()
    props, groups, canonical, associations = _view(graph)
    contact_cards = cards(graph, conn)
    from .contacts import rebuild_keys
    with suppressed(conn):
        people = {r["contact_uid"]: r["id"] for r in conn.execute("SELECT id,contact_uid FROM people")}
        for person in canonical:
            if person not in people:
                people[person] = conn.execute("INSERT INTO people(name,contact_uid) VALUES (?,?)", ("Unnamed person",person)).lastrowid
        preferred = _preferred_people(graph,canonical,props)
        displayed = {root:preferred.get(root,root) for root in groups}
        display_ids = {root:people[person] for root,person in displayed.items()}
        for person, root in canonical.items():
            c = contact_cards[root]
            own_names = [props[obj].get("display", "Unnamed person") for _,rel,obj,owner in associations[root] if rel == "has_name" and owner == person]
            name = c["card"]["name"] if person == displayed[root] else (own_names[0] if own_names else c["card"]["name"])
            conn.execute("UPDATE people SET name=?,contact_data=?,merged_into=?,is_me=?,trashed=? WHERE id=?", (name,encoded(c["card"]),None if person == displayed[root] else display_ids[root],int(c["is_me"]),int(c["trashed"]),people[person]))
            if person == displayed[root]:
                rebuild_keys(conn, display_ids[root], c["card"])
        old_rows = {(r["table_name"],r["entity"]): r["row_id"] for r in conn.execute("SELECT * FROM graph_rows WHERE table_name<>'people'")}
        photo_paths = {r[0]:r[1] for r in conn.execute("SELECT g.entity,p.path FROM graph_rows g JOIN photos p ON p.id=g.row_id WHERE g.table_name='photos'")}
        # Child indexes are local edit aids. Rebuild them so SQL card edits replace
        # the exact remote entity/version rather than spawning a duplicate card.
        conn.execute("DELETE FROM graph_children")
        desired = defaultdict(list)
        for root, rows in associations.items():
            if root not in people:
                continue
            for eid, relation, obj, owner in rows:
                p = props[obj]
                kind = graph.objects[obj]["type"]
                if kind in ("Interaction", "InteractionBatch"):
                    continue  # independent incremental interaction projection
                table = p.get("compat_table")
                child_key = None
                if relation == "has_name" and p.get("label") != "alias":
                    child_key = "name"
                elif relation == "has_contact_point" and table != "identifiers" and not p.get("matching_hint"):
                    child_key = "field_uid:" + obj
                elif relation == "has_note" and p.get("origin") in ("contact_card_notes", "legacy_card_notes"):
                    child_key = "notes"
                elif relation == "subject_of" and p.get("asserted_by") in ("contact_card", "legacy_contact_card"):
                    child_key = p.get("predicate")
                elif relation == "has_asset" and p.get("role") == "contact_photo":
                    child_key = "photo"
                elif relation == "has_preferences" and p.get("origin") == "contact_card":
                    child_key = "card_preferences"
                if child_key:
                    conn.execute("INSERT OR IGNORE INTO graph_children VALUES (?,?,?,?,?)", (displayed[root],child_key,obj,eid,encoded(p)))
                    continue
                if not table:
                    table = {"Name":"aliases", "ContactPoint":"identifiers", "Note":"events", "Interaction":"interactions", "RelationshipPreferences":"relationship_overrides", "Moment":"moments", "Asset":"photos", "Claim":"profiles" if p.get("predicate") == "public_profile" else "events"}.get(kind)
                if table not in KINDS:
                    continue
                v = {k:v for k,v in p.items() if k not in ("compat_table", "predicate", "body", "origin", "asserted_by", "content", "role", "matching_hint")}
                v["person_id"] = display_ids[root]
                if table == "aliases":
                    v = {"person_id": display_ids[root], "alias": p.get("display", "")}
                elif table == "identifiers":
                    v.setdefault("source", "graph")
                elif table == "events":
                    v.update(type="note" if kind == "Note" else p.get("predicate", p.get("type", "other")), value=p.get("body", p.get("value", "")))
                    v.setdefault("date", "")
                    v.setdefault("confidence", 1)
                    v.setdefault("source", "graph")
                    v.setdefault("status", "active")
                    v.setdefault("generation", 2 if v["status"] == "rejected" else 1)
                elif table == "profiles":
                    v["url"] = p.get("url", p.get("value", ""))
                    v.setdefault("site", "website")
                    v.setdefault("confidence", 1)
                elif table == "interactions":
                    v.setdefault("at", "")
                    v.setdefault("channel", "unknown")
                    v.setdefault("direction", "in")
                    v.setdefault("source_ref", "graph:" + obj)
                elif table == "photos":
                    digest = (p.get("content") or {}).get("blob_hash")
                    blob = conn.execute("SELECT content FROM graph_blobs WHERE hash=?", (digest,)).fetchone()
                    if not blob:
                        raise GraphError("Missing photo content")
                    # Derived assets live beside the explicitly selected database,
                    # never in a user's default photo directory.
                    database = conn.execute("PRAGMA database_list").fetchone()[2]
                    if not database:
                        import tempfile
                        directory = Path(tempfile.gettempdir()) / ("mypeople-graph-" + Store(conn).collection)
                    else:
                        directory = Path(database).parent / (Path(database).name + ".assets")
                    directory.mkdir(parents=True, exist_ok=True)
                    path = directory / digest
                    if not path.exists():
                        path.write_bytes(blob[0])
                    previous = photo_paths.get(obj)
                    if previous and Path(previous).is_file() and hashlib.sha256(Path(previous).read_bytes()).hexdigest() == digest:
                        path = Path(previous)
                    v["path"] = str(path)
                    v.setdefault("source", "graph:" + obj)
                desired[table].append((obj,eid,v))
        # Explicit decision reviews override provisional profile status.
        decisions = {}
        for eid,e in graph.edges.items():
            if e["type"] == "targets" and graph.active(eid) and graph.active(e["from"]):
                action = props[e["from"]].get("action")
                if action in ("confirmed", "rejected", "suggested", "reject"):
                    decisions[e["to"]] = "rejected" if action == "reject" else action
        for table in KINDS:
            if table != "interactions":
                conn.execute(f'DELETE FROM "{table}"')
        conn.execute("DELETE FROM distinct_people")
        conn.execute("DELETE FROM graph_rows WHERE table_name<>'interactions'")
        for person in canonical:
            local = people[person]
            row = dict(conn.execute("SELECT * FROM people WHERE id=?", (local,)).fetchone())
            conn.execute("INSERT INTO graph_rows VALUES (?,?,?,?,?)", ("people",local,person,None,encoded(row)))
        for table, rows in desired.items():
            # SQL uniqueness is a compatibility display rule only. Retain every
            # colliding original in graph and prefer the strongest explicit
            # review/generation in this disposable materialized view.
            if table == "events":
                rows.sort(key=lambda row:(-int(row[2].get("generation",1)),row[0]))
            elif table == "profiles":
                from .profile_urls import profile_url
                for obj,eid,v in rows:
                    v["url"] = profile_url(v.get("url", "")) or v.get("url", "")
                rows.sort(key=lambda row:({"confirmed":0,"rejected":1,"suggested":2}.get(row[2].get("status","suggested"),3),row[0]))
            elif table == "photos":
                rows.sort(key=lambda row:(-int(row[2].get("width",0)),row[0]))
            columns = {r[1] for r in conn.execute(f"PRAGMA table_info({table})")}
            used_ids = set()
            next_id = max([old_rows.get((table,obj), 0) for obj,_,_ in rows] + [0]) + 1
            for obj,eid,values in rows:
                v = {k:encoded(v) if isinstance(v,(dict,list)) else v for k,v in values.items() if k in columns and k != "id"}
                if table == "profiles" and obj in decisions:
                    v["status"] = decisions[obj]
                local = old_rows.get((table,obj))
                if "id" in columns:
                    if not local or local in used_ids:
                        local, next_id = next_id, next_id + 1
                    v["id"] = local
                    used_ids.add(local)
                keys = list(v)
                cursor = conn.execute(f'INSERT OR IGNORE INTO "{table}" ({",".join(keys)}) VALUES ({",".join("?" for _ in keys)})', [v[k] for k in keys])
                if cursor.rowcount:
                    local = v.get("id", v.get("person_id") if table == "relationship_overrides" else cursor.lastrowid)
                    row = dict(conn.execute(f'SELECT * FROM "{table}" WHERE rowid=?', (local,)).fetchone())
                    conn.execute("INSERT INTO graph_rows VALUES (?,?,?,?,?)", (table,local,obj,eid,encoded(row)))
        for eid,e in graph.edges.items():
            if e["type"] == "distinct_person" and graph.active(eid):
                a,b = sorted((people[e["from"]],people[e["to"]]))
                cur = conn.execute("INSERT OR IGNORE INTO distinct_people VALUES (?,?)", (a,b))
                if cur.rowcount:
                    conn.execute("INSERT INTO graph_rows VALUES (?,?,?,?,?)", ("distinct_people",cur.lastrowid,eid,None,encoded({"a":a,"b":b})))
        from . import graph_interactions
        graph_interactions.project(conn,graph,props=props,canonical=canonical,people=display_ids)
        conn.execute("DELETE FROM graph_dirty")
        conn.execute("DELETE FROM graph_deleted")


def associations(conn, person_uid):
    return _associations(conn,capture(conn),person_uid)


def _associations(conn,graph,person_uid):
    valid_uuid(person_uid)
    props, groups, canonical, rows = _view(graph)
    root = canonical.get(person_uid)
    if root is None:
        raise GraphError("Unknown person")
    card = cards(graph, conn)[root]["card"]
    conversations = {e["from"]: e["to"] for eid,e in graph.edges.items() if e["type"] == "in_conversation" and graph.active(eid)}
    result = []
    for eid, relation, obj, owner in sorted(rows[root]):
        if relation not in ATTRIBUTIONS:
            continue
        p = props[obj]
        kind = ("message" if relation == "participant" else "profile" if p.get("predicate") == "public_profile" else "fact" if relation == "subject_of" else "phone" if p.get("kind") == "phone" else "email" if p.get("kind") == "email" else graph.objects[obj]["type"].lower())
        label = p.get("display") or p.get("body") or p.get("text") or p.get("value") or p.get("url") or p.get("source") or kind
        result.append({"id": eid, "kind": kind, "label": str(label), "object_id": obj, "owner_uid": owner,
                       "thread": p.get("thread") or props[conversations.get(obj)].get("external_key"),
                       "conversation_id": conversations.get(obj), "channel": p.get("channel"), "at": p.get("at"), "properties": p})
    return {"uid": root, "name": card["name"], "heads": graph.heads, "members": groups[root], "associations": result,
            "review": graph.components()["contradictions"]}


def split(conn, person_uid, name, edges, *, heads=None):
    with _atomic(conn):
        graph = capture(conn)
        if heads is not None and (not isinstance(heads, list) or sorted(heads) != graph.heads):
            raise GraphError("Contact changed; reload associations before splitting")
        if not isinstance(edges, list) or any(not isinstance(e, str) for e in edges):
            raise GraphError("Select attribution edge UUIDs")
        # The displayed component may contain several original owners. Plan each
        # exact attribution move, still creating only one new person.
        available = _associations(conn,graph,person_uid)
        selected = {r["id"]: r for r in available["associations"]}
        if not edges or len(set(edges)) != len(edges) or any(e not in selected for e in edges):
            raise GraphError("Select distinct active associations of this person")
        if not isinstance(name, str) or not name.strip():
            raise GraphError("The new person needs a name")
        unverified = any(selected[eid]["kind"] == "phone" and (
            (graph.value(selected[eid]["owner_uid"], "card_metadata", {}) or {}).get("legacy_unverified")
            or graph.value(selected[eid]["object_id"], "compat_table") == "identifiers"
            or graph.value(selected[eid]["object_id"], "matching_hint", False)) for eid in edges)
        person_properties = {"is_me": False} | ({"card_metadata": {"legacy_unverified": True}} if unverified else {})
        new_person, new_name = create_object("Person", person_properties), create_object("Name", {"display": name.strip()})
        person = new_person["target"]
        ops = [new_person,new_name,create_edge("has_name",person,new_name["target"],{"preferred":True})]
        for member in available["members"]:
            ops.append(create_edge("distinct_person",member,person))
        props = _properties(graph)
        for eid in edges:
            e = graph.edges[eid]
            if any(graph.conflicted(eid,p) for entity,p in graph.versions if entity == eid):
                raise GraphError("Resolve attribution conflicts before moving it")
            ops.append(graph.edit(eid,"_lifecycle","retracted"))
            moved = props[eid] | ({"preferred":False,"alias":True} if e["type"] == "has_name" else {})
            ops.append(create_edge(e["type"], e["from"] if e["type"] == "participant" else person,
                                   person if e["type"] == "participant" else e["to"], moved))
        result = _append(conn,graph,ops)
        project(conn,result)
        local = conn.execute("SELECT id FROM people WHERE contact_uid=?", (person,)).fetchone()[0]
        return {"person_id":local,"contact_uid":person,"review":sorted(set(selected)-set(edges)),"heads":result.heads}


def plan_edit(graph, person_uid, card=None, *, values=None, trashed=None, links=(), **kwargs):
    """Plan a native graph card edit against exactly the observed frontier.

    Used by legacy UI wrappers as well as queued pre-cutover edits. It never
    reconstructs ownership by coalescing SQL rows.
    """
    valid_uuid(person_uid)
    values = dict(values or {})
    projected = cards(graph, kwargs["store"].conn if kwargs.get("store") else None)
    props, groups, canonical, associations = _view(graph)
    root = canonical.get(person_uid, person_uid)
    previous = projected.get(root)
    ops = []
    def add_object(kind, p):
        op = create_object(kind,p)
        ops.append(op)
        return op["target"]
    def put(entity, p):
        before = props.get(entity,{})
        for key in before.keys() | p.keys():
            if before.get(key) != p.get(key):
                ops.append(graph.edit(entity,key,p.get(key)))
    if previous is None:
        ops.append(create_object("Person",{"is_me":False},id=person_uid))
        if card is None:
            card = {"name":values.get("name", "Unnamed person")}
    if card is None and values:
        # Resolve scalar register conflicts explicitly even if the chosen display
        # value already equals our provisional scalar.
        unresolved = {k:v for k,v in values.items() if k in (previous or {}).get("conflicts",{})}
        for field,value in unresolved.items():
            for option in previous["conflicts"][field]:
                entity,prop = option["entity"],option["property"]
                if not any(op["target"] == entity and op.get("payload",{}).get("property") == prop for op in ops):
                    ops.append(graph.edit(entity,prop,value))
        if unresolved and set(values) <= unresolved.keys() | {"user_edited"}:
            return graph.commit(kwargs.get("peer") or uid(),ops,kwargs.get("collection"))
        card = dict(previous["card"])
        card.update({k:v for k,v in values.items() if not k.startswith("_")})
    if card is not None:
        from .contacts import validate
        validate(card)
        # No photo decoding is needed here: blobs are supplied by change(), which
        # calls the same planner with a blob-capable Store adapter below.
        store = kwargs.get("store")
        if store is None:
            class Blobs:
                def put_blob(self, content):
                    return hashlib.sha256(content).hexdigest()
            store = Blobs()
        wanted = _card_entities(card,card["name"].strip(),store)
        existing = defaultdict(list)
        for eid,relation,obj,owner in associations.get(root,[]):
            p = props[obj]
            key = None
            if relation == "has_name" and p.get("label") != "alias": key = "name"
            elif relation == "has_contact_point":
                hint = p.get("compat_table") == "identifiers" or p.get("matching_hint")
                if not hint or ((previous or {}).get("card",{}).get("legacy_unverified") and p.get("kind") in ("phone", "email")):
                    key = "field_uid:" + obj
            elif relation == "has_note" and p.get("origin") in ("contact_card_notes","legacy_card_notes"): key = "notes"
            elif relation == "subject_of" and p.get("asserted_by") in ("contact_card","legacy_contact_card"): key = p.get("predicate")
            elif relation == "has_asset" and p.get("role") == "contact_photo": key = "photo"
            elif relation == "has_preferences" and p.get("origin") == "contact_card": key = "card_preferences"
            if key:
                existing[key].append((eid,obj))
        # A user-added website is an explicit profile assertion. Preserve public
        # discovery provenance and an explicit rejection rather than replacing it.
        from .profile_urls import profile_url, site
        for field in card.get("fields",[]):
            if field.get("kind") != "website" or not field.get("user_added"):
                continue
            url = profile_url(field.get("value", ""))
            if not url:
                continue
            matches = [obj for _,rel,obj,_ in associations.get(root,[]) if rel == "subject_of" and props[obj].get("predicate") == "public_profile" and profile_url(props[obj].get("url",props[obj].get("value", ""))) == url]
            origin = {"source":"manual_contact","url":url}
            if matches:
                for obj in matches:
                    p = props[obj]
                    if p.get("status") == "rejected": continue
                    sources = json.loads(p.get("sources") or "[]") if isinstance(p.get("sources", "[]"),str) else list(p.get("sources",[]))
                    if origin not in sources: sources.append(origin)
                    put(obj,p | {"status":"confirmed","confidence":1,"sources":encoded(sources)})
            else:
                obj = add_object("Claim",{"compat_table":"profiles","predicate":"public_profile","value":url,"url":url,"site":site(url),"status":"confirmed","confidence":1,"reason":"Profile URL explicitly added to the contact by the user.","sources":encoded([origin])})
                ops.append(create_edge("subject_of",root,obj))
        for position,(key,(kind,relation,p)) in enumerate(wanted.items()):
            old = existing.pop(key,[])
            if not old and key.startswith("field:"):
                matches = [(k,v) for k,v in existing.items() if k.startswith("field_uid:") and len(v) == 1 and props[v[0][1]] == p]
                if len(matches) == 1:
                    old = existing.pop(matches[0][0])
            if not old and key.startswith("field_uid:"):
                raise GraphError("Contact field identity is not an association of this person")
            if old:
                # Names on other original people remain attributable to them.
                # Editing the displayed name updates only the preferred name.
                eid,obj = min(old,key=lambda pair:(not props[pair[0]].get("preferred",False),pair[1]))
                if relation == "has_contact_point" and (props[obj].get("compat_table") == "identifiers" or props[obj].get("matching_hint")):
                    p = props[obj] | p
                    if not card.get("legacy_unverified"):
                        p.update(compat_table=None, matching_hint=False)
                put(obj,p)
                if props[eid].get("card_order") != position:
                    ops.append(graph.edit(eid,"card_order",position))
            else:
                obj = add_object(kind,p)
                ops.append(create_edge(relation,root,obj,{"preferred":key == "name","origin":"contact_card","card_order":position}))
        for old in existing.values():
            for eid,obj in old:
                ops.append(graph.edit(eid,"_lifecycle","retracted"))
        metadata = {k:v for k,v in card.items() if k not in CARD_KEYS and k != "edit_id"}
        if previous is not None:
            if props[root].get("card_metadata",{}) != metadata:
                ops.append(graph.edit(root,"card_metadata",metadata))
        elif metadata:
            ops.append({"id":uid(),"kind":"set_property","target":root,"payload":{"property":"card_metadata","value":metadata},"replaces":[]})
    if "_is_me" in values and root in graph.objects:
        ops.append(graph.edit(root,"is_me",bool(values["_is_me"])))
    if trashed is None:
        trashed = values.get("_trashed")
    if trashed is not None:
        for member in groups.get(root,[root]):
            if member in graph.objects:
                if graph.value(member,"_lifecycle") != ("trashed" if trashed else "active") or graph.conflicted(member,"_lifecycle"):
                    ops.append(graph.edit(member,"_lifecycle","trashed" if trashed else "active"))
            elif trashed:
                creation = next(op for op in ops if op["target"] == member and op["kind"] == "create_object")
                ops.append({"id":uid(),"kind":"set_lifecycle","target":member,"payload":{"value":"trashed"},"replaces":[creation["id"]]})
    for other in links:
        if other != root and canonical.get(other) != root:
            if other not in graph.objects:
                raise GraphError("A merge references an unknown person")
            ops.append(create_edge("same_person",root,other))
    if not ops:
        return None
    return graph.commit(kwargs.get("peer") or uid(),ops,kwargs.get("collection"))


def unmerge(conn, person_id):
    """Retract identity assertions, never restore an old SQL snapshot over edits."""
    with _atomic(conn):
        graph = capture(conn)
        row = conn.execute("SELECT contact_uid FROM people WHERE id=?", (person_id,)).fetchone()
        if row is None:
            raise GraphError("Unknown person")
        members = next((set(m) for m in graph.components()["groups"].values() if row[0] in m),set())
        ops = [graph.edit(eid,"_lifecycle","retracted") for eid,e in graph.edges.items() if e["type"] == "same_person" and e["from"] in members and e["to"] in members and graph.active(eid)]
        if not ops:
            raise GraphError("No merge to undo")
        result = _append(conn,graph,ops)
        project(conn,result)
        return {"members":sorted(members),"heads":result.heads}


def merge(conn, person_ids, preferred=None):
    """Join identities without moving/deleting any authoritative associations."""
    with _atomic(conn):
        ids = list(dict.fromkeys(person_ids))
        if len(ids) < 2:
            raise GraphError("Choose at least two people")
        from .db import sync_legacy_extraction
        sync_legacy_extraction(conn, tuple(ids))
        conn.execute(f"DELETE FROM extraction_state WHERE person_id IN ({','.join('?' for _ in ids)})", ids)
        graph = capture(conn)
        people = [conn.execute("SELECT contact_uid FROM people WHERE id=?", (p,)).fetchone() for p in ids]
        if len(ids) < 2 or any(p is None for p in people):
            raise GraphError("Choose at least two people")
        if preferred is None:
            preferred = max(ids,key=lambda p:conn.execute("SELECT COUNT(*) FROM interactions WHERE person_id=?",(p,)).fetchone()[0])
        preferred_uid = conn.execute("SELECT contact_uid FROM people WHERE id=?",(preferred,)).fetchone()[0]
        ops = [create_edge("same_person",people[0][0],p[0],{"origin":"explicit_merge","preferred_person":preferred_uid}) for p in people[1:] if p[0] != people[0][0]]
        for eid,e in graph.edges.items():
            if e["type"] == "has_name" and e["from"] in {p[0] for p in people} and graph.active(eid):
                wanted = e["from"] == preferred_uid
                if graph.value(eid,"preferred",False) != wanted:
                    ops.append(graph.edit(eid,"preferred",wanted))
        result = _append(conn,graph,ops)
        project(conn,result)
        root = next(root for root,members in result.components()["groups"].items() if people[0][0] in members)
        from .identity import canonical as local_canonical
        return local_canonical(conn,conn.execute("SELECT id FROM people WHERE contact_uid=?", (root,)).fetchone()[0])
