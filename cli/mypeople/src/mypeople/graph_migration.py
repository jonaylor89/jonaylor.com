"""Explicit one-shot legacy migration into a SEPARATE graph database.

The caller opens the source read-only. No inferred ownership repairs: legacy
person_id is retained with an explicit warning that pre-merge attribution is lost.
Original domain rows and existing contact history are retained as SourceRecords.
Caches, credentials, receipts, and transport capabilities are not domain data.
"""
from __future__ import annotations

import base64
import json
import sqlite3
import uuid
from pathlib import Path

from .graph import GraphError, Store, create_edge, create_object, encoded, transaction

DOMAIN_TABLES = (
    "people", "aliases", "identifiers", "events", "interactions", "relationship_overrides",
    "moments", "photos", "profiles", "distinct_people", "contact_merge_undo", "contact_changes",
)


def migrate(source: sqlite3.Connection, destination: Store):
    if source is destination.conn:
        raise GraphError("Migrate into a separate graph database")
    if destination.load().commits:
        raise GraphError("Migration requires an empty graph")
    if source.in_transaction:
        raise GraphError("Source must not have an open write transaction")
    source.execute("BEGIN")
    try:
        tables = {row[0] for row in source.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if "people" not in tables:
            raise GraphError("Not a legacy MyPeople database")
        with transaction(destination.conn):
            return _migrate(source, destination, tables)
    finally:
        source.rollback()  # release the read snapshot, never write to the source


def _migrate(source, store, tables):
    operations, rows, source_ids = [], {}, {}
    namespace = uuid.UUID(store.collection)
    def stable(key):
        return str(uuid.uuid5(namespace, key))
    def object_(kind, properties, key):
        op = create_object(kind, properties, id=stable(key))
        operations.append(op)
        return op["target"]
    def edge(kind, a, b, properties=None):
        operations.append(create_edge(kind, a, b, properties))
    def blob(data):
        return {"blob_hash": store.put_blob(data)}
    def archived(value):
        if isinstance(value, bytes):
            return blob(value)
        return value
    for table in DOMAIN_TABLES:
        if table not in tables:
            continue
        cursor = source.execute(f'SELECT * FROM "{table}"')
        columns = [column[0] for column in cursor.description]
        rows[table] = [dict(zip(columns, row)) for row in cursor]
        for index, row in enumerate(rows[table]):
            original = encoded({key: archived(value) for key, value in row.items()}).encode()
            source_ids[table, index] = object_("SourceRecord", {"system": "legacy-mypeople", "table": table, "row": index, "original": blob(original)}, f"source:{table}:{index}")
    people = {}
    for index, row in enumerate(rows.get("people", [])):
        key = row.get("contact_uid") or f"legacy:{row['id']}"
        person = object_("Person", {"legacy_id": row["id"], "legacy_contact_uid": row.get("contact_uid", ""), "is_me": bool(row.get("is_me")), "attribution_quality": "legacy_current_owner"}, f"person:{key}")
        people[row["id"]] = person
        edge("originated_from", person, source_ids["people", index])
        # Store the supplied display name; original structured names remain separate properties.
        card = json.loads(row.get("contact_data") or "{}")
        name = object_("Name", {"display": row["name"], **{k: card[k] for k in ("given", "family", "middle", "prefix", "suffix", "phonetic") if k in card}}, f"name:{key}")
        edge("has_name", person, name, {"preferred": True})
        for n, field in enumerate(card.get("fields", [])):
            point = object_("ContactPoint", field, f"field:{key}:{n}")
            edge("has_contact_point", person, point, {"preferred": bool(field.get("preferred"))})
            edge("originated_from", point, source_ids["people", index])
        if card.get("notes"):
            note = object_("Note", {"body": card["notes"], "origin": "legacy_card_notes"}, f"card-note:{key}")
            edge("has_note", person, note)
        for prop in ("birthday", "organization", "title"):
            if card.get(prop):
                claim = object_("Claim", {"predicate": prop, "value": card[prop], "asserted_by": "legacy_contact_card"}, f"card-claim:{key}:{prop}")
                edge("subject_of", person, claim)
                edge("originated_from", claim, source_ids["people", index])
        if card.get("photo"):
            asset = object_("Asset", {"content": blob(base64.b64decode(card["photo"], validate=True)), "role": "contact_photo"}, f"card-photo:{key}")
            edge("has_asset", person, asset)
        for prop in ("favorite", "preferred_channel", "region"):
            if prop in card:
                decision = object_("Decision", {"action": prop, "value": card[prop], "asserted_by": "legacy_contact_card"}, f"card-decision:{key}:{prop}")
                edge("targets", decision, person)
        if row.get("trashed"):
            operations.append({"id": stable(f"trash-operation:{key}"), "kind": "set_lifecycle", "target": person, "payload": {"value": "trashed"}, "replaces": [next(op["id"] for op in operations if op["target"] == person and op["kind"] == "create_object")]})
    for row in rows.get("people", []):
        if row.get("merged_into") is not None:
            if row["merged_into"] not in people:
                raise GraphError("Broken legacy merge reference")
            edge("same_person", people[row["id"]], people[row["merged_into"]], {"origin": "legacy_merge"})
    conversations = {}
    for table in ("aliases", "identifiers", "events", "interactions", "relationship_overrides", "moments", "photos", "profiles"):
        for index, row in enumerate(rows.get(table, [])):
            person = people.get(row.get("person_id"))
            if person is None:
                raise GraphError(f"Orphaned legacy {table} row")
            key = f"{table}:{index}"
            properties = {k: v for k, v in row.items() if k not in ("id", "person_id", "path")}
            association = {"attribution_quality": "legacy_current_owner"}
            if table == "aliases":
                obj = object_("Name", {"display": row["alias"], "label": "alias"}, key)
                edge("has_name", person, obj, association)
            elif table == "identifiers":
                obj = object_("ContactPoint", properties | {"matching_hint": True}, key)
                edge("has_contact_point", person, obj, association)
            elif table == "events":
                note = row["type"] == "note"
                obj = object_("Note" if note else "Claim", properties | ({"body": row["value"]} if note else {"predicate": row["type"]}), key)
                edge("has_note" if note else "subject_of", person, obj, association)
                if row.get("evidence"):
                    evidence = object_("Evidence", {"quote": row["evidence"], "source_ref": row.get("source_ref"), "said_at": row.get("said_at")}, f"evidence:{key}")
                    edge("drawn_from", evidence, source_ids[table, index])
                    if not note:
                        edge("supported_by", obj, evidence, {"confidence": row.get("confidence")})
                if row.get("status") == "rejected":
                    decision = object_("Decision", {"action": "reject", "origin": "legacy"}, f"decision:{key}")
                    edge("targets", decision, obj)
            elif table == "interactions":
                obj = object_("Interaction", properties, key)
                edge("participant", obj, person, association | {"role": "in" if row["direction"] == "in" else "out"})
                if row.get("thread"):
                    thread = (row["channel"], row["thread"])
                    if thread not in conversations:
                        conversations[thread] = object_("Conversation", {"channel": thread[0], "external_key": thread[1]}, f"conversation:{encoded(list(thread))}")
                    edge("in_conversation", obj, conversations[thread])
            elif table == "relationship_overrides":
                obj = object_("RelationshipPreferences", properties, key)
                edge("has_preferences", person, obj, association)
            elif table == "moments":
                obj = object_("Moment", properties, key)
                edge("about", obj, person)
            elif table == "photos":
                path = Path(row["path"])
                if not path.is_file():
                    raise GraphError("A referenced legacy photo is missing; migration was rolled back")
                obj = object_("Asset", properties | {"content": blob(path.read_bytes())}, key)
                edge("has_asset", person, obj, association)
            else:  # profile discovery is an assertion, not automatically a verified contact point
                obj = object_("Claim", properties | {"predicate": "public_profile", "value": row["url"]}, key)
                edge("subject_of", person, obj, association)
                decision = object_("Decision", {"action": row["status"], "origin": "legacy_profile_review"}, f"decision:{key}")
                edge("targets", decision, obj)
            edge("originated_from", obj, source_ids[table, index])
    for row in rows.get("distinct_people", []):
        edge("distinct_person", people[row["a"]], people[row["b"]])
    if not operations:
        raise GraphError("The legacy database has no domain records")
    commit = store.write(operations)
    store.conn.execute("INSERT INTO graph_meta VALUES ('legacy_migrated', ?)", (commit["id"],))
    return {"commit": commit["id"], "people": len(people), "source_records": len(source_ids),
            "warning": "Legacy associations preserve current ownership, not ownership lost in prior merges. Review conflated contacts before splitting."}
