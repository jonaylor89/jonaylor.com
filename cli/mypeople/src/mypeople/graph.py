"""Versioned object graph, wire v1. No SQL IDs, clock winners, or destructive merges.

This is the new engine foundation, not yet the authority for the legacy application.
Commit parents describe causality; domain edges are ordinary versioned entities.
All peers retain all commits and blobs. Projections are disposable.
"""
from __future__ import annotations

import copy
import datetime as dt
import hashlib
import heapq
import json
import math
import sqlite3
import uuid
from collections import defaultdict
from contextlib import contextmanager

VERSION = 1
MAX_COMMITS = 100_000
MAX_OPERATIONS = 1_000_000
OBJECT_TYPES = frozenset((
    "Person", "Name", "ContactPoint", "Note", "Claim", "SourceRecord", "Evidence",
    "Interaction", "Conversation", "Asset", "Relationship", "RelationshipPreferences",
    "Decision", "ProcessingRun", "Moment",
))
# Endpoints are checked as part of the replicated contract, not just in the UI.
EDGE_TYPES = {
    "has_name": ({"Person"}, {"Name"}),
    "has_contact_point": ({"Person"}, {"ContactPoint"}),
    "has_note": ({"Person"}, {"Note"}),
    "subject_of": ({"Person"}, {"Claim"}),
    "has_asset": ({"Person"}, {"Asset"}),
    "has_preferences": ({"Person"}, {"RelationshipPreferences"}),
    "same_person": ({"Person"}, {"Person"}),
    "distinct_person": ({"Person"}, {"Person"}),
    "participant": ({"Interaction", "Relationship"}, {"Person"}),
    "in_conversation": ({"Interaction"}, {"Conversation"}),
    "drawn_from": ({"Evidence"}, {"SourceRecord", "Interaction", "Note"}),
    "supported_by": ({"Claim"}, {"Evidence"}),
    "contradicted_by": ({"Claim"}, {"Evidence"}),
    "originated_from": (None, {"SourceRecord"}),
    "generated_by": (None, {"ProcessingRun"}),
    "targets": ({"Decision"}, None),
    "about": ({"Moment"}, {"Person", "Claim"}),
}
ATTRIBUTIONS = frozenset(("has_name", "has_contact_point", "has_note", "subject_of", "has_asset", "has_preferences", "participant"))


class GraphError(ValueError):
    pass


def uid() -> str:
    return str(uuid.uuid4())


def valid_uuid(value):
    try:
        if not isinstance(value, str) or str(uuid.UUID(value)) != value:
            raise ValueError
    except (ValueError, AttributeError):
        raise GraphError("Expected a canonical UUID") from None


def encoded(value) -> str:
    def validate(item, depth=0):
        if depth > 100:
            raise GraphError("JSON nesting exceeds supported depth")
        if isinstance(item, dict):
            if any(not isinstance(key, str) for key in item):
                raise GraphError("JSON object keys must be strings")
            for child in item.values():
                validate(child, depth + 1)
        elif isinstance(item, list):
            for child in item:
                validate(child, depth + 1)
        elif item is not None and type(item) not in (str, bool, int, float):
            raise GraphError("Expected JSON values")
        elif isinstance(item, float) and not math.isfinite(item):
            raise GraphError("Expected finite JSON values")
    try:
        validate(value)
        return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    except (ValueError, TypeError, RecursionError):
        raise GraphError("Expected finite JSON values") from None


def create_object(kind: str, properties: dict | None = None, *, id: str | None = None) -> dict:
    return {"id": uid(), "kind": "create_object", "target": id or uid(), "payload": {"type": kind, "properties": {} if properties is None else properties}, "replaces": []}


def create_edge(kind: str, source: str, target: str, properties: dict | None = None) -> dict:
    return {"id": uid(), "kind": "create_edge", "target": uid(), "payload": {"type": kind, "from": source, "to": target, "properties": {} if properties is None else properties}, "replaces": []}


class Graph:
    """Pure deterministic reducer. Input order and wall clocks cannot affect the result."""

    def __init__(self, commits=()):
        self.commits = {}
        for original in commits:
            c = copy.deepcopy(original)
            if not isinstance(c, dict) or set(c) != {"id", "collection", "peer", "recorded_at", "version", "parents", "operations"}:
                raise GraphError("Invalid commit shape")
            for key in ("id", "collection", "peer"):
                valid_uuid(c[key])
            if type(c["version"]) is not int or c["version"] != VERSION:
                raise GraphError("Unsupported graph version")
            if not isinstance(c["recorded_at"], str):
                raise GraphError("Invalid recorded time")
            try:
                when = dt.datetime.fromisoformat(c["recorded_at"])
                if when.utcoffset() is None:
                    raise ValueError
            except ValueError:
                raise GraphError("Recorded time must have a timezone") from None
            if not isinstance(c["parents"], list) or len(c["parents"]) > MAX_COMMITS:
                raise GraphError("Invalid commit parents")
            for parent in c["parents"]:
                valid_uuid(parent)
            if len(set(c["parents"])) != len(c["parents"]):
                raise GraphError("Duplicate commit parent")
            if not isinstance(c["operations"], list) or not c["operations"]:
                raise GraphError("A commit needs operations")
            encoded(c)
            previous = self.commits.get(c["id"])
            if previous is not None and encoded(previous) != encoded(c):
                raise GraphError("Commit UUID reused for different content")
            self.commits[c["id"]] = c
        if len(self.commits) > MAX_COMMITS or sum(len(c["operations"]) for c in self.commits.values()) > MAX_OPERATIONS:
            raise GraphError("Graph exceeds supported history size")
        collections = {c["collection"] for c in self.commits.values()}
        if len(collections) > 1:
            raise GraphError("Cannot join different collections")
        self.collection = next(iter(collections), None)
        children = defaultdict(list)
        pending = {}
        for c in self.commits.values():
            pending[c["id"]] = len(c["parents"])
            for parent in c["parents"]:
                if parent not in self.commits:
                    raise GraphError("Missing commit parent")
                children[parent].append(c["id"])
        ready = [key for key, n in pending.items() if not n]
        heapq.heapify(ready)
        self.order = []
        while ready:
            key = heapq.heappop(ready)
            self.order.append(key)
            for child in children.get(key, ()):
                pending[child] -= 1
                if not pending[child]:
                    heapq.heappush(ready, child)
        if len(self.order) != len(self.commits):
            raise GraphError("Cyclic commit history")
        self.heads = sorted(set(self.commits) - set(children))
        self.objects = {}
        self.edges = {}
        self.versions = defaultdict(dict)
        self.operations = {}
        self.origins = {}
        self.creation = {}
        for key in self.order:
            for op in self.commits[key]["operations"]:
                self._apply(key, op)

    def past(self, heads):
        seen, todo = set(), list(heads)
        while todo:
            key = todo.pop()
            if key not in self.commits:
                raise GraphError("Unknown graph frontier")
            if key not in seen:
                seen.add(key)
                todo.extend(self.commits[key]["parents"])
        return seen

    def observed(self, origin, commit):
        if origin == commit:
            return True  # only already-applied operations in this commit can be referenced
        todo, seen = list(self.commits[commit]["parents"]), set()
        while todo:
            key = todo.pop()
            if key == origin:
                return True
            if key not in seen:
                seen.add(key)
                todo.extend(self.commits[key]["parents"])
        return False

    def _require_entity(self, target, commit):
        if target not in self.creation or not self.observed(self.creation[target], commit):
            raise GraphError("Operation references an unobserved entity")

    @staticmethod
    def _properties(properties):
        if not isinstance(properties, dict) or any(not isinstance(k, str) or not k or k.startswith("_") for k in properties):
            raise GraphError("Invalid properties")

    def _apply(self, commit, op):
        if not isinstance(op, dict) or set(op) != {"id", "kind", "target", "payload", "replaces"}:
            raise GraphError("Invalid operation shape")
        valid_uuid(op["id"])
        valid_uuid(op["target"])
        if op["id"] in self.operations:
            raise GraphError("Operation UUID reused")
        target, payload, kind = op["target"], op["payload"], op["kind"]
        if not isinstance(payload, dict) or not isinstance(op["replaces"], list):
            raise GraphError("Invalid operation payload")
        for old in op["replaces"]:
            valid_uuid(old)
        if len(set(op["replaces"])) != len(op["replaces"]):
            raise GraphError("Duplicate replacement")
        if kind in ("create_object", "create_edge"):
            if target in self.creation or op["replaces"]:
                raise GraphError("Entity identity cannot be recreated")
            expected = {"type", "properties"} if kind == "create_object" else {"type", "from", "to", "properties"}
            if set(payload) != expected or not isinstance(payload["type"], str):
                raise GraphError("Invalid entity creation")
            self._properties(payload["properties"])
            if kind == "create_object":
                if payload["type"] not in OBJECT_TYPES:
                    raise GraphError("Unknown object type")
                self.objects[target] = {"type": payload["type"]}
            else:
                if payload["type"] not in EDGE_TYPES:
                    raise GraphError("Unknown edge type")
                for endpoint in (payload["from"], payload["to"]):
                    valid_uuid(endpoint)
                    self._require_entity(endpoint, commit)
                sources, targets = EDGE_TYPES[payload["type"]]
                for endpoint, allowed in ((payload["from"], sources), (payload["to"], targets)):
                    if allowed is not None and self.objects.get(endpoint, {}).get("type") not in allowed:
                        raise GraphError("Invalid edge endpoint type")
                if payload["type"] in ("same_person", "distinct_person") and payload["from"] == payload["to"]:
                    raise GraphError("Identity assertions need two people")
                self.edges[target] = {k: payload[k] for k in ("type", "from", "to")}
            self.creation[target] = commit
            values = payload["properties"] | {"_lifecycle": "active"}
        elif kind in ("set_property", "set_lifecycle"):
            self._require_entity(target, commit)
            if kind == "set_property":
                if set(payload) != {"property", "value"}:
                    raise GraphError("Invalid property edit")
                if not isinstance(payload["property"], str):
                    raise GraphError("Invalid property name")
                self._properties({payload["property"]: payload["value"]})
                values = {payload["property"]: payload["value"]}
            else:
                if set(payload) != {"value"} or payload["value"] not in ("active", "trashed", "retracted"):
                    raise GraphError("Invalid lifecycle")
                values = {"_lifecycle": payload["value"]}
            for prop in values:
                for old in op["replaces"]:
                    if old not in self.operations or not self.observed(self.origins[old], commit):
                        raise GraphError("Edit replaces an unobserved version")
                    earlier = self.operations[old]
                    earlier_payload = earlier["payload"]
                    matches = (earlier["kind"].startswith("create_") and (prop == "_lifecycle" or prop in earlier_payload["properties"])) or (earlier["kind"] == "set_lifecycle" and prop == "_lifecycle") or (earlier["kind"] == "set_property" and earlier_payload["property"] == prop)
                    if earlier["target"] != target or not matches:
                        raise GraphError("Replacement targets another property")
                    self.versions[target, prop].pop(old, None)
        else:
            raise GraphError("Unknown operation kind")
        self.operations[op["id"]] = op
        self.origins[op["id"]] = commit
        for prop, value in values.items():
            self.versions[target, prop][op["id"]] = value

    def alternatives(self, target, prop):
        return [{"operation": key, "value": value} for key, value in sorted(self.versions.get((target, prop), {}).items())]

    def value(self, target, prop, default=None):
        options = self.alternatives(target, prop)
        return options[-1]["value"] if options else default

    def conflicted(self, target, prop):
        return len({encoded(v) for v in self.versions.get((target, prop), {}).values()}) > 1

    def deletion_conflicts(self, target):
        conflicts = {}
        for lifecycle, state in self.versions.get((target, "_lifecycle"), {}).items():
            if state == "active":
                continue
            deletion = self.origins[lifecycle]
            for (entity, prop), versions in self.versions.items():
                if entity != target or prop == "_lifecycle":
                    continue
                for operation, value in versions.items():
                    edit = self.origins[operation]
                    if not self.observed(deletion, edit) and not self.observed(edit, deletion):
                        conflicts[lifecycle] = {"property": "_lifecycle", "value": state}
                        conflicts[operation] = {"property": prop, "value": value}
        return [{"operation": key, "value": value} for key, value in sorted(conflicts.items())]

    def active(self, target):
        # A provisional scalar is useful for display; not for exporting a deleted/conflicted entity.
        return not self.conflicted(target, "_lifecycle") and self.value(target, "_lifecycle") == "active"

    def edit(self, target, prop, value, *, replaces=None):
        if target not in self.creation:
            raise GraphError("Unknown entity")
        return {"id": uid(), "kind": "set_lifecycle" if prop == "_lifecycle" else "set_property", "target": target,
                "payload": {"value": value} if prop == "_lifecycle" else {"property": prop, "value": value},
                "replaces": sorted(self.versions.get((target, prop), {})) if replaces is None else replaces}

    def commit(self, peer, operations, collection=None):
        return {"id": uid(), "collection": collection or self.collection or uid(), "peer": peer,
                "recorded_at": dt.datetime.now(dt.timezone.utc).isoformat(), "version": VERSION,
                "parents": self.heads, "operations": operations}

    def entity(self, target):
        base = self.objects.get(target, self.edges.get(target))
        if base is None:
            raise GraphError("Unknown entity")
        properties, conflicts = {}, {}
        for entity, prop in sorted(self.versions):
            if entity == target:
                properties[prop] = self.value(target, prop)
                if self.conflicted(target, prop):
                    conflicts[prop] = self.alternatives(target, prop)
        deletion = self.deletion_conflicts(target)
        if deletion:
            conflicts["_deletion"] = deletion
        return {"id": target, **base, "properties": properties, "conflicts": conflicts}

    def components(self):
        roots = {key: key for key, obj in self.objects.items() if obj["type"] == "Person"}
        def root(key):
            while roots[key] != key:
                roots[key] = roots[roots[key]]
                key = roots[key]
            return key
        for key, edge in sorted(self.edges.items()):
            if edge["type"] == "same_person" and self.active(key):
                a, b = root(edge["from"]), root(edge["to"])
                roots[max(a, b)] = min(a, b)
        groups = defaultdict(list)
        for key in sorted(roots):
            groups[root(key)].append(key)
        contradictions = [key for key, edge in sorted(self.edges.items()) if edge["type"] == "distinct_person" and self.active(key) and root(edge["from"]) == root(edge["to"])]
        return {"groups": dict(groups), "contradictions": contradictions}

    def split(self, person, name, attributions):
        """Plan a conflated-person split. Never infer ownership from names or phone suffixes.

        The caller selects exact edges, including message participant edges. Source
        records/evidence remain untouched. Unselected associations are returned for review.
        """
        if self.objects.get(person, {}).get("type") != "Person" or not self.active(person):
            raise GraphError("Choose an active person")
        if not isinstance(name, str) or not name.strip():
            raise GraphError("The new person needs a name")
        if len(set(attributions)) != len(attributions) or not attributions:
            raise GraphError("Select distinct attribution edges to move")
        associated = {key: edge for key, edge in self.edges.items() if edge["type"] in ATTRIBUTIONS and self.active(key) and (edge["to"] == person if edge["type"] == "participant" else edge["from"] == person)}
        if any(key not in associated for key in attributions):
            raise GraphError("Selection is not an active attribution of this person")
        new_person, new_name = create_object("Person"), create_object("Name", {"display": name.strip()})
        new_id = new_person["target"]
        operations = [new_person, new_name, create_edge("has_name", new_id, new_name["target"]), create_edge("distinct_person", person, new_id)]
        for key in attributions:
            edge = associated[key]
            if any(entity == key and self.conflicted(entity, prop) for entity, prop in self.versions):
                raise GraphError("Resolve attribution conflicts before moving it")
            properties = {prop: self.value(key, prop) for entity, prop in self.versions if entity == key and prop != "_lifecycle"}
            operations.extend((self.edit(key, "_lifecycle", "retracted"), create_edge(edge["type"], new_id if edge["from"] == person else edge["from"], new_id if edge["to"] == person else edge["to"], properties)))
        return {"person": new_id, "operations": operations, "review": sorted(set(associated) - set(attributions))}


@contextmanager
def transaction(conn):
    """Nest safely inside an import/edit transaction; never implicitly commit it."""
    name = "graph_" + uuid.uuid4().hex
    conn.execute(f"SAVEPOINT {name}")
    try:
        yield
        conn.execute(f"RELEASE {name}")
    except BaseException:
        conn.execute(f"ROLLBACK TO {name}")
        conn.execute(f"RELEASE {name}")
        raise


class Store:
    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        with transaction(conn):
            for sql in (
                "CREATE TABLE IF NOT EXISTS graph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS graph_commits (id TEXT PRIMARY KEY, data TEXT NOT NULL)",
                "CREATE TABLE IF NOT EXISTS graph_blobs (hash TEXT PRIMARY KEY, content BLOB NOT NULL)",
            ):
                conn.execute(sql)
            for key in ("collection", "peer"):
                conn.execute("INSERT OR IGNORE INTO graph_meta VALUES (?, ?)", (key, uid()))
        self.peer = conn.execute("SELECT value FROM graph_meta WHERE key='peer'").fetchone()[0]

    @property
    def collection(self):
        # Read through: adoption may be rolled back by an enclosing transaction.
        return self.conn.execute("SELECT value FROM graph_meta WHERE key='collection'").fetchone()[0]

    def load(self):
        return Graph(json.loads(row[0]) for row in self.conn.execute("SELECT data FROM graph_commits"))

    def put_blob(self, content: bytes):
        digest = hashlib.sha256(content).hexdigest()
        self.conn.execute("INSERT OR IGNORE INTO graph_blobs VALUES (?, ?)", (digest, content))
        if self.conn.execute("SELECT content FROM graph_blobs WHERE hash=?", (digest,)).fetchone()[0] != content:
            raise GraphError("Stored blob is damaged")
        return digest

    def verify_references(self, graph):
        # Blob references have one canonical representation anywhere in properties.
        checked = set()
        def check(value):
            if isinstance(value, dict):
                if "blob_hash" in value:
                    digest = value["blob_hash"]
                    if not isinstance(digest, str):
                        raise GraphError("Invalid blob reference")
                    if digest not in checked:
                        if not self.conn.execute("SELECT 1 FROM graph_blobs WHERE hash=?", (digest,)).fetchone():
                            raise GraphError("Missing referenced blob")
                        checked.add(digest)
                for child in value.values():
                    check(child)
            elif isinstance(value, list):
                for child in value:
                    check(child)
        for c in graph.commits.values():
            check(c["operations"])

    def receive(self, commits, blobs=None, *, adopt=False):
        commits = list(commits)
        with transaction(self.conn):
            current = self.load()
            combined = Graph([*current.commits.values(), *commits])
            if combined.collection and combined.collection != self.collection:
                if current.commits or self.conn.execute("SELECT 1 FROM graph_blobs LIMIT 1").fetchone() or not adopt:
                    raise GraphError("Cannot join different collections")
                self.conn.execute("UPDATE graph_meta SET value=? WHERE key='collection'", (combined.collection,))
            for digest, content in (blobs or {}).items():
                if hashlib.sha256(content).hexdigest() != digest:
                    raise GraphError("Blob hash does not match content")
                self.put_blob(content)
            self.verify_references(combined)
            for c in commits:
                self.conn.execute("INSERT OR IGNORE INTO graph_commits VALUES (?, ?)", (c["id"], encoded(c)))
        return combined

    def write(self, operations):
        with transaction(self.conn):
            current = self.load()
            commit = current.commit(self.peer, operations, self.collection)
            self.receive([commit])
        return commit

    def split(self, person, name, attributions):
        with transaction(self.conn):
            plan = self.load().split(person, name, attributions)
            commit = self.write(plan.pop("operations"))
        return {**plan, "commit": commit["id"]}
