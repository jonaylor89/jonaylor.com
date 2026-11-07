"""Persistent working index of the replicated graph: the Python side of docs/mypeople/indexed-store.md.

`graph_commits` stays the authority. This index holds what replaying it produces (entities,
the live register values, operation origins, canonical commit order and heads), so a caller
reads current state without replaying history. It lives in the same database and changes in
the same transaction as the commits it reflects, so the two cannot drift apart.

New commits are reduced by the very same `Graph._apply` rules, run against SQLite through the
reducer's state hooks; a full replay and the index must always agree, and tests check that
they do (`MYPEOPLE_GRAPH_VERIFY=1`). The index is disposable: it is rebuilt from the commits
whenever its format changes, a commit it doesn't know appears, or anything looks inconsistent.
Nothing here replicates; peers only ever exchange commits and blobs.
"""
from __future__ import annotations

import heapq
import json
import os
import sqlite3
import uuid
import weakref
from collections.abc import Mapping

from .graph import MAX_COMMITS, MAX_OPERATIONS, Graph, GraphError, check_commit, encoded, transaction

FORMAT = 1
# Above this many unknown commits, one in-memory replay and a bulk write beats applying each.
BULK = 2000

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS graph_index_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    # seq: the order commits reached this index (projection watermarks); rank: canonical replay order.
    "CREATE TABLE IF NOT EXISTS graph_index_commits (id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, rank INTEGER NOT NULL, parents TEXT NOT NULL) WITHOUT ROWID",
    "CREATE TABLE IF NOT EXISTS graph_index_entities (id TEXT PRIMARY KEY, edge INTEGER NOT NULL, type TEXT NOT NULL, src TEXT, dst TEXT, creation TEXT NOT NULL, ordinal INTEGER NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS graph_index_entity_src ON graph_index_entities(src, type)",
    "CREATE INDEX IF NOT EXISTS graph_index_entity_dst ON graph_index_entities(dst, type)",
    "CREATE INDEX IF NOT EXISTS graph_index_entity_type ON graph_index_entities(type, edge)",
    "CREATE INDEX IF NOT EXISTS graph_index_entity_creation ON graph_index_entities(creation)",
    # written: the properties an operation wrote, which is all a later `replaces` needs to check.
    "CREATE TABLE IF NOT EXISTS graph_index_operations (id TEXT PRIMARY KEY, origin TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL, written TEXT NOT NULL) WITHOUT ROWID",
    "CREATE INDEX IF NOT EXISTS graph_index_operation_origin ON graph_index_operations(origin)",
    "CREATE INDEX IF NOT EXISTS graph_index_operation_target ON graph_index_operations(target)",
    # Live alternatives only: a replaced version is deleted, exactly as the reducer pops it.
    "CREATE TABLE IF NOT EXISTS graph_index_registers (entity TEXT NOT NULL, property TEXT NOT NULL, op TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (entity, property, op)) WITHOUT ROWID",
    # Values that SQL keeps unique across people (identifiers, moment keys), for scoped projection.
    "CREATE INDEX IF NOT EXISTS graph_index_register_value ON graph_index_registers(property, value) WHERE property IN ('value', 'key')",
    # The people each commit involves, as history shows them. Only a later attribution edge to an
    # object the commit touched can change that, and creating one clears exactly those entries.
    "CREATE TABLE IF NOT EXISTS graph_index_affected (id TEXT PRIMARY KEY, people TEXT NOT NULL) WITHOUT ROWID",
)
TABLES = ("graph_index_commits", "graph_index_entities", "graph_index_operations", "graph_index_registers", "graph_index_affected")
OWNERSHIP = ("has_name", "has_contact_point", "has_note", "subject_of", "has_asset", "has_preferences")


# Bumped whenever a graph writes the index through a connection. Another graph read through the
# same connection was a snapshot from before; it notices on its next read and replays exactly
# the commits it had seen, so code holding an older graph keeps the snapshot it was given.
_generations: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _generation(conn) -> int:
    try:
        return _generations.get(conn, 0)
    except TypeError:
        return 0


def _bump(conn) -> int:
    try:
        _generations[conn] = _generations.get(conn, 0) + 1
        return _generations[conn]
    except TypeError:
        return 0


def _dump(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def verifying() -> bool:
    return os.environ.get("MYPEOPLE_GRAPH_VERIFY") == "1"


# --- opening --------------------------------------------------------------------------------

def _meta(conn) -> dict | None:
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='graph_index_meta'").fetchone():
        return None
    meta = dict(conn.execute("SELECT key, value FROM graph_index_meta").fetchall())
    return meta if meta.get("format") == str(FORMAT) else None


def _source(conn) -> tuple[int, int]:
    return tuple(conn.execute("SELECT COUNT(*), COALESCE(MAX(rowid), 0) FROM graph_commits").fetchone())


def _current(conn, meta) -> bool:
    count, top = _source(conn)
    if count != int(meta["commits"]):
        return False
    if top == int(meta["source"]):
        return True
    # Rows after the watermark that this index already holds (a writer that hasn't noted them).
    return not conn.execute("SELECT 1 FROM graph_commits g WHERE g.rowid > ? AND NOT EXISTS (SELECT 1 FROM graph_index_commits c WHERE c.id = g.id) LIMIT 1",
                            (int(meta["source"]),)).fetchone()


def load(conn) -> "IndexedGraph | None":
    """The index, brought up to date with graph_commits. None if it can't be written right now
    (a read-only database, or another writer holds the lock), in which case the caller replays."""
    if not conn.execute("SELECT 1 FROM sqlite_master WHERE name='graph_commits'").fetchone():
        return None
    meta = _meta(conn)
    if meta is not None and _current(conn, meta):
        return IndexedGraph(conn)
    if not _write(conn, lambda: _catch_up(conn, meta)):
        return None
    graph = IndexedGraph(conn)
    if verifying():
        verify(conn)
    return graph


def _write(conn, work) -> bool:
    """Run `work` in the caller's transaction, or in a short one of our own that never waits."""
    if conn.in_transaction:
        with transaction(conn):
            work()
        return True
    old = conn.execute("PRAGMA busy_timeout").fetchone()[0]
    try:
        conn.execute("PRAGMA busy_timeout = 0")
        conn.execute("BEGIN IMMEDIATE")
    except sqlite3.OperationalError:
        return False
    finally:
        conn.execute(f"PRAGMA busy_timeout = {int(old)}")
    try:
        work()
    except sqlite3.OperationalError:
        conn.rollback()
        return False
    except BaseException:
        conn.rollback()
        raise
    sqlite3.Connection.commit(conn)  # nothing to capture: only index tables changed
    return True


def _catch_up(conn, meta) -> None:
    if meta is None:
        return _build(conn)
    unknown = conn.execute("SELECT g.data FROM graph_commits g WHERE g.rowid > ? AND NOT EXISTS (SELECT 1 FROM graph_index_commits c WHERE c.id = g.id) ORDER BY g.rowid",
                           (int(meta["source"]),)).fetchall()
    count, _ = _source(conn)
    if not unknown or len(unknown) > BULK or int(meta["commits"]) + len(unknown) != count:
        return _build(conn)  # rows vanished or the watermark is wrong: start again from the commits
    # Written by a CLI that predates the index. They were validated then; check them again anyway.
    IndexedGraph(conn).apply_commits([json.loads(r[0]) for r in unknown])
    noted(conn)


def _build(conn, graph: Graph | None = None) -> None:
    """Replace the index with one written from a full replay."""
    if graph is None:
        graph = Graph((json.loads(r[0]) for r in conn.execute("SELECT data FROM graph_commits")), copy_commits=False)
    for sql in SCHEMA:
        conn.execute(sql)
    for table in TABLES:
        conn.execute(f"DELETE FROM {table}")
    conn.execute("DELETE FROM graph_index_meta")
    conn.executemany("INSERT INTO graph_index_commits VALUES (?,?,?,?)",
                     ((cid, n, n, _dump(graph.commits[cid]["parents"])) for n, cid in enumerate(graph.order)))
    entities, operations = [], []
    for cid in graph.order:
        for ordinal, op in enumerate(graph.commits[cid]["operations"]):
            target, payload = op["target"], op["payload"]
            if op["kind"] == "create_object":
                entities.append((target, 0, payload["type"], None, None, cid, ordinal))
            elif op["kind"] == "create_edge":
                entities.append((target, 1, payload["type"], payload["from"], payload["to"], cid, ordinal))
            operations.append((op["id"], cid, target, op["kind"], _dump(list(_written(op)))))
    conn.executemany("INSERT INTO graph_index_entities VALUES (?,?,?,?,?,?,?)", entities)
    conn.executemany("INSERT INTO graph_index_operations VALUES (?,?,?,?,?)", operations)
    conn.executemany("INSERT INTO graph_index_registers VALUES (?,?,?,?)",
                     ((entity, prop, op, _dump(value)) for (entity, prop), versions in graph.versions.items() for op, value in versions.items()))
    count, top = _source(conn)
    _put_meta(conn, format=FORMAT, commits=len(graph.commits), operations=len(operations), seq=len(graph.order) - 1,
              source=top, heads=graph.heads, collection=graph.collection, epoch=uuid.uuid4().hex)
    conn.execute("DELETE FROM graph_index_meta WHERE key = 'projected'")  # seq numbers start again
    if count != len(graph.commits):
        raise GraphError("Graph history changed while it was being indexed")
    _bump(conn)


def _put_meta(conn, **values) -> None:
    """heads and collection are JSON, epoch is text, the rest are integers."""
    conn.executemany("INSERT OR REPLACE INTO graph_index_meta VALUES (?, ?)",
                     ((k, _dump(v) if k in ("heads", "collection") else v if k == "epoch" else str(int(v))) for k, v in values.items()))


def _written(op) -> tuple:
    if op["kind"].startswith("create_"):
        return tuple(op["payload"]["properties"])
    return (op["payload"]["property"],) if op["kind"] == "set_property" else ("_lifecycle",)


def projected(conn) -> int | None:
    """The index seq up to which SQL compatibility rows reflect the graph, if known."""
    row = conn.execute("SELECT value FROM graph_index_meta WHERE key = 'projected'").fetchone() if _meta(conn) else None
    return int(row[0]) if row else None


def set_projected(conn, seq: int) -> None:
    conn.execute("INSERT OR REPLACE INTO graph_index_meta VALUES ('projected', ?)", (str(int(seq)),))


def noted(conn) -> None:
    """Call after inserting commits the index already holds into graph_commits."""
    if _meta(conn) is not None:
        count, top = _source(conn)
        _put_meta(conn, source=top)
        if verifying():
            verify(conn)


def rebuild(conn, graph: Graph | None = None) -> None:
    """Rebuild from a full replay; `graph` may be one the caller already validated."""
    with transaction(conn):
        _build(conn, graph)


# --- the index as a graph ---------------------------------------------------------------------

class IndexedGraph(Graph):
    """The Graph interface over the persistent index.

    Point reads (one entity, one person's associations) are single indexed queries. Iterating
    every entity loads the whole index into memory once, which is the slow path that only full
    projections and exports take. Writes go straight to SQLite in the caller's transaction.
    """

    def __init__(self, conn):  # deliberately not Graph.__init__: nothing is replayed
        self.conn = conn
        self._reload()

    def _reload(self):
        meta = dict(self.conn.execute("SELECT key, value FROM graph_index_meta").fetchall())
        self._epoch = meta["epoch"]
        self._gen = _generation(self.conn)
        self._frozen = False
        self.heads = json.loads(meta["heads"])
        self.collection = json.loads(meta["collection"])
        self._count, self._op_count, self._seq = int(meta["commits"]), int(meta["operations"]), int(meta["seq"])
        self._entities: dict[str, tuple | None] = {}
        self._regs: dict[str, dict] = {}
        self._complete = False
        self._lists = None
        self._parents: dict[str, list] | None = None
        self._ranks: dict[str, int] | None = None
        self._order = None
        self._ancestors: dict[str, set] = {}
        self._frontier = None
        self._components = None
        self._observed_cache = {}
        self._ordinal = 0
        self.objects = _Entities(self, False)
        self.edges = _Entities(self, True)
        self.versions = _Versions(self)
        self.commits = _Commits(self)
        self.creation = _Creation(self)
        self.origins = _Origins(self)
        self.operations = _Operations(self)

    # --- reading ---

    def _fresh(self):
        if not self._frozen and self._gen != _generation(self.conn):
            self._freeze()

    def _freeze(self):
        """Another graph wrote the index since this one was read: become the snapshot we were."""
        meta = dict(self.conn.execute("SELECT key, value FROM graph_index_meta").fetchall())
        if meta.get("epoch") != self._epoch:
            raise GraphError("The graph index was rebuilt while an older view of it was in use")
        rows = self.conn.execute("SELECT g.data FROM graph_commits g JOIN graph_index_commits c ON c.id = g.id WHERE c.seq <= ?",
                                 (self._seq,)).fetchall()
        snapshot = Graph((json.loads(r[0]) for r in rows), copy_commits=False)
        ranks = {cid: n for n, cid in enumerate(snapshot.order)}
        ordinals = {op["target"]: n for cid in snapshot.order for n, op in enumerate(snapshot.commits[cid]["operations"]) if op["kind"].startswith("create_")}
        self._entities = {}
        for key, base in snapshot.objects.items():
            creation = snapshot.creation[key]
            self._entities[key] = (base["type"], 0, None, None, creation, ordinals[key], ranks[creation])
        for key, base in snapshot.edges.items():
            creation = snapshot.creation[key]
            self._entities[key] = (base["type"], 1, base["from"], base["to"], creation, ordinals[key], ranks[creation])
        self._lists = {False: list(snapshot.objects), True: list(snapshot.edges)}
        self._regs = {}
        for (entity, prop), versions in snapshot.versions.items():
            if versions:
                self._regs.setdefault(entity, {})[prop] = dict(versions)
        self._parents = {cid: list(c["parents"]) for cid, c in snapshot.commits.items()}
        self._ranks, self._order = ranks, list(snapshot.order)
        self.heads, self.collection, self._count = snapshot.heads, snapshot.collection, len(snapshot.commits)
        self._ancestors, self._components = {}, None
        self._complete = self._frozen = True
        for mapping in (self.objects, self.edges):
            mapping._bases.clear()

    def _row(self, key):
        self._fresh()
        if key not in self._entities:
            if self._complete:
                return None
            self._entities[key] = self.conn.execute(
                "SELECT e.type, e.edge, e.src, e.dst, e.creation, e.ordinal, c.rank FROM graph_index_entities e "
                "JOIN graph_index_commits c ON c.id = e.creation WHERE e.id = ?", (key,)).fetchone()
            if self._entities[key] is not None:
                self._entities[key] = tuple(self._entities[key])
        return self._entities[key]

    def registers(self, target):
        self._fresh()
        regs = self._regs.get(target)
        if regs is None:
            regs = {}
            if not self._complete:
                for prop, op, value in self.conn.execute(
                        "SELECT property, op, value FROM graph_index_registers WHERE entity = ? ORDER BY property, op", (target,)):
                    regs.setdefault(prop, {})[op] = json.loads(value)
            self._regs[target] = regs
        return regs

    def preload(self):
        """Everything in memory, for callers that walk the whole graph."""
        self._fresh()
        if self._complete:
            return
        rows = self.conn.execute("SELECT e.id, e.type, e.edge, e.src, e.dst, e.creation, e.ordinal, c.rank FROM graph_index_entities e "
                                 "JOIN graph_index_commits c ON c.id = e.creation ORDER BY c.rank, e.ordinal").fetchall()
        lists = {False: [], True: []}
        for key, *row in rows:
            self._entities[key] = tuple(row)
            lists[bool(row[1])].append(key)
        regs: dict[str, dict] = {}
        for entity, prop, op, value in self.conn.execute("SELECT entity, property, op, value FROM graph_index_registers ORDER BY entity, property, op"):
            regs.setdefault(entity, {}).setdefault(prop, {})[op] = json.loads(value)
        self._regs = regs
        self._lists = lists
        self._complete = True

    def _select_edges(self, where, args):
        rows = self.conn.execute(
            "SELECT e.id, e.type, e.edge, e.src, e.dst, e.creation, e.ordinal, c.rank FROM graph_index_entities e "
            f"JOIN graph_index_commits c ON c.id = e.creation WHERE e.edge = 1 AND {where} ORDER BY c.rank, e.ordinal", args).fetchall()
        out = []
        for key, *row in rows:
            self._entities.setdefault(key, tuple(row))
            out.append((key, self.edges[key]))
        return out

    def edges_from(self, source, types=None):
        self._fresh()
        if self._complete:
            return super().edges_from(source, types)
        if types is None:
            return self._select_edges("e.src = ?", (source,))
        types = sorted(types)
        return self._select_edges(f"e.src = ? AND e.type IN ({','.join('?' * len(types))})", (source, *types))

    def edges_to(self, target, types=None):
        self._fresh()
        if self._complete:
            return super().edges_to(target, types)
        if types is None:
            return self._select_edges("e.dst = ?", (target,))
        types = sorted(types)
        return self._select_edges(f"e.dst = ? AND e.type IN ({','.join('?' * len(types))})", (target, *types))

    def edges_of_type(self, types):
        self._fresh()
        if self._complete:
            return super().edges_of_type(types)
        types = sorted(types)
        return self._select_edges(f"e.type IN ({','.join('?' * len(types))})", tuple(types))

    def objects_of_type(self, kind):
        self._fresh()
        if self._complete:
            return sorted(key for key in self._lists[False] if self._entities[key][0] == kind)
        return [r[0] for r in self.conn.execute("SELECT id FROM graph_index_entities WHERE edge = 0 AND type = ? ORDER BY id", (kind,))]

    def entities_with(self, prop, value):
        """Entities with a live `prop` (value or key) equal to `value`."""
        self._fresh()
        if self._complete:
            return [entity for entity, regs in self._regs.items() if value in regs.get(prop, {}).values()]
        return [r[0] for r in self.conn.execute("SELECT DISTINCT entity FROM graph_index_registers WHERE property = ? AND value = ?", (prop, _dump(value)))]

    def creation_order(self, entity):
        row = self._row(entity)
        return (row[6], row[5])

    def _rank(self, commit):
        self._fresh()
        if self._ranks is not None:
            return self._ranks[commit]
        return self.conn.execute("SELECT rank FROM graph_index_commits WHERE id = ?", (commit,)).fetchone()[0]

    @property
    def order(self):
        self._fresh()
        if self._order is None:
            self._order = [r[0] for r in self.conn.execute("SELECT id FROM graph_index_commits ORDER BY rank")]
        return self._order

    def _indexed(self, commit):
        self._fresh()
        if self._parents is not None:
            return commit in self._parents
        return self.conn.execute("SELECT 1 FROM graph_index_commits WHERE id = ?", (commit,)).fetchone() is not None

    def _parent_map(self):
        if self._parents is None:
            self._parents = {cid: json.loads(parents) for cid, parents in self.conn.execute("SELECT id, parents FROM graph_index_commits")}
        return self._parents

    def past(self, heads):
        parents = self._parent_map()
        seen, todo = set(), list(heads)
        while todo:
            key = todo.pop()
            if key not in parents:
                raise GraphError("Unknown graph frontier")
            if key not in seen:
                seen.add(key)
                todo.extend(parents[key])
        return seen

    def observed(self, origin, commit):
        if origin == commit:
            return True
        if commit == self._frontier:
            # Its parents were every head, so everything indexed before it is in its past.
            return self._indexed(origin)
        if commit not in self._ancestors:
            self._ancestors[commit] = self.past(self._parent_map()[commit])
        return origin in self._ancestors[commit]

    def components(self):
        if self._components is None:
            roots = {key: key for key in self.objects_of_type("Person")}

            def root(key):
                while roots[key] != key:
                    roots[key] = roots[roots[key]]
                    key = roots[key]
                return key
            identity = sorted(self.edges_of_type(("same_person", "distinct_person")))
            for key, edge in identity:
                if edge["type"] == "same_person" and self.active(key):
                    a, b = root(edge["from"]), root(edge["to"])
                    roots[max(a, b)] = min(a, b)
            groups = {}
            for key in sorted(roots):
                groups.setdefault(root(key), []).append(key)
            contradictions = [key for key, edge in identity if edge["type"] == "distinct_person" and self.active(key) and root(edge["from"]) == root(edge["to"])]
            self._components = {"groups": groups, "contradictions": contradictions}
        return {"groups": {k: list(v) for k, v in self._components["groups"].items()}, "contradictions": list(self._components["contradictions"])}

    def entity(self, target):
        base = self.objects.get(target, self.edges.get(target))
        if base is None:
            raise GraphError("Unknown entity")
        properties, conflicts = {}, {}
        for prop in sorted(self.registers(target)):
            properties[prop] = self.value(target, prop)
            if self.conflicted(target, prop):
                conflicts[prop] = self.alternatives(target, prop)
        deletion = self.deletion_conflicts(target)
        if deletion:
            conflicts["_deletion"] = deletion
        return {"id": target, **base, "properties": properties, "conflicts": conflicts}

    def deletion_conflicts(self, target):
        regs = self.registers(target)
        conflicts = {}
        for lifecycle, state in regs.get("_lifecycle", {}).items():
            if state == "active":
                continue
            deletion = self.origins[lifecycle]
            for prop, versions in regs.items():
                if prop == "_lifecycle":
                    continue
                for operation, value in versions.items():
                    edit = self.origins[operation]
                    if not self.observed(deletion, edit) and not self.observed(edit, deletion):
                        conflicts[lifecycle] = {"property": "_lifecycle", "value": state}
                        conflicts[operation] = {"property": prop, "value": value}
        return [{"operation": key, "value": value} for key, value in sorted(conflicts.items())]

    def affected_since(self, seq):
        """Every entity an operation touched in commits that reached the index after `seq`."""
        self._fresh()
        if self._frozen:
            raise GraphError("Project from the current graph, not an older view of it")
        return {r[0] for r in self.conn.execute(
            "SELECT DISTINCT o.target FROM graph_index_operations o JOIN graph_index_commits c ON c.id = o.origin WHERE c.seq > ?", (seq,))}

    def commits_touching(self, entities):
        self._fresh()
        if self._frozen:
            entities = set(entities)
            return {cid for cid in self._order for op in self.commits[cid]["operations"] if op["target"] in entities}
        entities = list(entities)
        found = set()
        for n in range(0, len(entities), 500):
            chunk = entities[n:n + 500]
            found.update(r[0] for r in self.conn.execute(
                f"SELECT DISTINCT origin FROM graph_index_operations WHERE target IN ({','.join('?' * len(chunk))})", chunk))
        return found

    def affected_people(self, commit, owners=OWNERSHIP):
        """People a commit involves, as the history UI counts them: those it targets directly,
        the endpoints of edges it touches, and the owner of every object it touches, where an
        object's owner comes from its last attribution edge (`owners` types, or participant)."""
        self._fresh()
        if self._frozen:
            raise GraphError("History comes from the current graph, not an older view of it")
        if tuple(owners) == OWNERSHIP:
            cached = self.conn.execute("SELECT people FROM graph_index_affected WHERE id = ?", (commit,)).fetchone()
            if cached is not None:
                return set(json.loads(cached[0]))
        people = self._affected_people(commit, owners)
        if tuple(owners) == OWNERSHIP:
            try:
                self.conn.execute("INSERT OR REPLACE INTO graph_index_affected VALUES (?, ?)", (commit, _dump(sorted(people))))
            except sqlite3.OperationalError:
                pass  # a read-only or busy database just computes it again next time
        return people

    def _affected_people(self, commit, owners):
        owners = sorted(owners)
        marks = ",".join("?" * len(owners))
        people = {r[0] for r in self.conn.execute(
            "SELECT o.target FROM graph_index_operations o JOIN graph_index_entities e ON e.id = o.target "
            "WHERE o.origin = ? AND e.edge = 0 AND e.type = 'Person'", (commit,))}
        for end in ("src", "dst"):
            people.update(r[0] for r in self.conn.execute(
                f"SELECT p.id FROM graph_index_operations o JOIN graph_index_entities e ON e.id = o.target AND e.edge = 1 "
                f"JOIN graph_index_entities p ON p.id = e.{end} AND p.edge = 0 AND p.type = 'Person' WHERE o.origin = ?", (commit,)))
        people.update(r[0] for r in self.conn.execute(
            f"""SELECT person FROM (
                  SELECT person, ROW_NUMBER() OVER (PARTITION BY target ORDER BY rank DESC, ordinal DESC) AS n FROM (
                    SELECT o.target AS target, a.src AS person, c.rank AS rank, a.ordinal AS ordinal
                      FROM graph_index_operations o JOIN graph_index_entities a ON a.dst = o.target AND a.type IN ({marks})
                      JOIN graph_index_commits c ON c.id = a.creation WHERE o.origin = ?
                    UNION ALL
                    SELECT o.target, a.dst, c.rank, a.ordinal
                      FROM graph_index_operations o JOIN graph_index_entities a ON a.src = o.target AND a.type = 'participant'
                      JOIN graph_index_commits c ON c.id = a.creation WHERE o.origin = ?))
                WHERE n = 1""", (*owners, commit, commit)))
        return people

    @property
    def seq(self):
        return self._seq

    # --- reducer state hooks ---

    def _has_operation(self, op_id):
        return self.conn.execute("SELECT 1 FROM graph_index_operations WHERE id = ?", (op_id,)).fetchone() is not None

    def _created(self, target):
        row = self._row(target)
        return row[4] if row else None

    def _create(self, target, base, is_edge, commit):
        row = (base["type"], int(is_edge), base.get("from"), base.get("to"), commit, self._ordinal, self._rank(commit) if self._ranks is None else self._ranks[commit])
        self.conn.execute("INSERT INTO graph_index_entities (id, type, edge, src, dst, creation, ordinal) VALUES (?,?,?,?,?,?,?)", (target, *row[:6]))
        self._entities[target] = row
        if self._lists is not None:
            self._lists[is_edge].append(target)
        self._components = None
        if is_edge and (base["type"] in OWNERSHIP or base["type"] == "participant"):
            owned = base["to"] if base["type"] in OWNERSHIP else base["from"]
            self.conn.execute("DELETE FROM graph_index_affected WHERE id IN (SELECT origin FROM graph_index_operations WHERE target = ?)", (owned,))

    def _operation(self, op_id):
        row = self.conn.execute("SELECT origin, kind, target, written FROM graph_index_operations WHERE id = ?", (op_id,)).fetchone()
        return None if row is None else (row[0], row[1], row[2], tuple(json.loads(row[3])))

    def _drop_version(self, target, prop, op_id):
        self.conn.execute("DELETE FROM graph_index_registers WHERE entity = ? AND property = ? AND op = ?", (target, prop, op_id))
        regs = self._regs.get(target)
        if regs is not None and prop in regs:
            regs[prop].pop(op_id, None)
            if not regs[prop]:
                del regs[prop]
        self._components = None

    def _record_operation(self, op, commit):
        self.conn.execute("INSERT INTO graph_index_operations VALUES (?,?,?,?,?)", (op["id"], commit, op["target"], op["kind"], _dump(list(_written(op)))))
        self._op_count += 1

    def _set_version(self, target, prop, op_id, value):
        self.conn.execute("INSERT OR REPLACE INTO graph_index_registers VALUES (?,?,?,?)", (target, prop, op_id, _dump(value)))
        self.registers(target).setdefault(prop, {})[op_id] = value
        self._components = None

    # --- writing ---

    def _append_local(self, commit):
        if commit["parents"] != self.heads or self._indexed(commit["id"]):
            raise GraphError("Local commit does not extend the current frontier")
        if self._frozen:
            current = IndexedGraph(self.conn)  # an older view: the commit joins today's history
            current.apply_commits([commit])
            return current
        self.apply_commits([commit])
        return self

    def apply_commits(self, commits):
        """Validate and index commits exactly as a replay of the whole history would.
        Returns the new ones in the order they were applied. Callers persist them to graph_commits."""
        self._fresh()
        if self._frozen:
            raise GraphError("Write through the current graph, not an older view of it")
        fresh: dict[str, tuple[dict, str]] = {}
        for c in commits:
            text = check_commit(c)
            if c["id"] in fresh:
                if fresh[c["id"]][1] != text:
                    raise GraphError("Commit UUID reused for different content")
                continue
            if self._indexed(c["id"]):
                stored = self.conn.execute("SELECT data FROM graph_commits WHERE id = ?", (c["id"],)).fetchone()
                if stored is not None and encoded(json.loads(stored[0])) != text:
                    raise GraphError("Commit UUID reused for different content")
                continue
            fresh[c["id"]] = (c, text)
        if not fresh:
            return []
        collections = {c["collection"] for c, _ in fresh.values()} | ({self.collection} if self.collection else set())
        if len(collections) > 1:
            raise GraphError("Cannot join different collections")
        if self._count + len(fresh) > MAX_COMMITS or self._op_count + sum(len(c["operations"]) for c, _ in fresh.values()) > MAX_OPERATIONS:
            raise GraphError("Graph exceeds supported history size")
        pending, children = {}, {}
        for cid, (c, _) in fresh.items():
            pending[cid] = 0
            for parent in c["parents"]:
                if parent in fresh:
                    pending[cid] += 1
                    children.setdefault(parent, []).append(cid)
                elif not self._indexed(parent):
                    raise GraphError("Missing commit parent")
        ready = [cid for cid, n in pending.items() if not n]
        heapq.heapify(ready)
        order = []
        while ready:
            cid = heapq.heappop(ready)
            order.append(cid)
            for child in children.get(cid, ()):
                pending[child] -= 1
                if not pending[child]:
                    heapq.heappush(ready, child)
        if len(order) != len(fresh):
            raise GraphError("Cyclic commit history")
        try:
            with transaction(self.conn):
                reorder = False
                for cid in order:
                    c = fresh[cid][0]
                    frontier = sorted(c["parents"]) == self.heads
                    reorder = reorder or not frontier
                    self._seq += 1
                    rank = self._count  # provisional for a non-frontier commit; reranked below
                    self.conn.execute("INSERT INTO graph_index_commits VALUES (?,?,?,?)", (cid, self._seq, rank, _dump(c["parents"])))
                    self._count += 1
                    if self._parents is not None:
                        self._parents[cid] = list(c["parents"])
                    if self._ranks is not None:
                        self._ranks[cid] = rank
                    self._order = None
                    self._frontier = cid if frontier else None
                    for ordinal, op in enumerate(c["operations"]):
                        self._ordinal = ordinal
                        self._apply(cid, op)
                    self.heads = sorted((set(self.heads) - set(c["parents"])) | {cid})
                    self.collection = self.collection or c["collection"]
                self._frontier = None
                if reorder:
                    self._rerank()
                _put_meta(self.conn, commits=self._count, operations=self._op_count, seq=self._seq, heads=self.heads, collection=self.collection)
            self._gen = _bump(self.conn)
        except BaseException:
            self._reload()  # the savepoint was rolled back; so must our caches be
            raise
        return [fresh[cid][0] for cid in order]

    def _rerank(self):
        """Canonical replay order after commits arrived out of it (the same Kahn walk as Graph)."""
        parents = self._parent_map()
        children, pending = {}, {}
        for cid, ps in parents.items():
            pending[cid] = len(ps)
            for p in ps:
                children.setdefault(p, []).append(cid)
        ready = [cid for cid, n in pending.items() if not n]
        heapq.heapify(ready)
        ranks = {}
        while ready:
            cid = heapq.heappop(ready)
            ranks[cid] = len(ranks)
            for child in children.get(cid, ()):
                pending[child] -= 1
                if not pending[child]:
                    heapq.heappush(ready, child)
        current = dict(self.conn.execute("SELECT id, rank FROM graph_index_commits").fetchall())
        self.conn.executemany("UPDATE graph_index_commits SET rank = ? WHERE id = ?",
                              ((rank, cid) for cid, rank in ranks.items() if current.get(cid) != rank))
        self._ranks = ranks
        self._order = None
        for key, row in list(self._entities.items()):
            if row is not None:
                self._entities[key] = (*row[:6], ranks[row[4]])
        if self._lists is not None:
            for is_edge in (False, True):
                self._lists[is_edge].sort(key=lambda key: (self._entities[key][6], self._entities[key][5]))


class _Entities(Mapping):
    def __init__(self, graph, edge):
        self.graph, self.edge = graph, edge
        self._bases = {}

    def __getitem__(self, key):
        row = self.graph._row(key)
        if row is None or bool(row[1]) != self.edge:
            raise KeyError(key)
        base = self._bases.get(key)
        if base is None:
            base = self._bases[key] = {"type": row[0], "from": row[2], "to": row[3]} if self.edge else {"type": row[0]}
        return base

    def __contains__(self, key):
        row = self.graph._row(key)
        return row is not None and bool(row[1]) == self.edge

    def __iter__(self):
        self.graph.preload()
        return iter(list(self.graph._lists[self.edge]))

    def __len__(self):
        self.graph.preload()
        return len(self.graph._lists[self.edge])


class _Versions(Mapping):
    """(entity, property) -> {operation: value}; reads like the reducer's defaultdict."""

    def __init__(self, graph):
        self.graph = graph

    def __getitem__(self, key):
        return self.graph.registers(key[0]).get(key[1], {})

    def get(self, key, default=None):
        return self.graph.registers(key[0]).get(key[1], default)

    def __contains__(self, key):
        return key[1] in self.graph.registers(key[0])

    def __iter__(self):
        self.graph.preload()
        return iter([(entity, prop) for entity, props in self.graph._regs.items() for prop, versions in props.items() if versions])

    def items(self):
        self.graph.preload()
        return [((entity, prop), versions) for entity, props in self.graph._regs.items() for prop, versions in props.items() if versions]

    def __len__(self):
        return len(self.items())


class _Commits(Mapping):
    def __init__(self, graph):
        self.graph = graph
        self._cache = {}

    def __getitem__(self, key):
        if key not in self._cache:
            row = self.graph.conn.execute("SELECT data FROM graph_commits WHERE id = ?", (key,)).fetchone()
            if row is None or not self.graph._indexed(key):
                raise KeyError(key)
            self._cache[key] = json.loads(row[0])
        return self._cache[key]

    def __contains__(self, key):
        return self.graph._indexed(key)

    def __iter__(self):
        return iter(self.graph.order)

    def __len__(self):
        return self.graph._count

    def values(self):
        rows = dict(self.graph.conn.execute("SELECT id, data FROM graph_commits").fetchall())
        return [self._cache.get(cid) or json.loads(rows[cid]) for cid in self.graph.order]


class _Creation(Mapping):
    def __init__(self, graph):
        self.graph = graph

    def __getitem__(self, key):
        row = self.graph._row(key)
        if row is None:
            raise KeyError(key)
        return row[4]

    def __contains__(self, key):
        return self.graph._row(key) is not None

    def __iter__(self):
        self.graph.preload()
        return iter([*self.graph._lists[False], *self.graph._lists[True]])

    def __len__(self):
        return len(list(iter(self)))


class _Origins(Mapping):
    def __init__(self, graph):
        self.graph = graph

    def __getitem__(self, key):
        row = self.graph.conn.execute("SELECT origin FROM graph_index_operations WHERE id = ?", (key,)).fetchone()
        if row is None:
            raise KeyError(key)
        return row[0]

    def __iter__(self):
        return iter([r[0] for r in self.graph.conn.execute("SELECT id FROM graph_index_operations")])

    def __len__(self):
        return self.graph._op_count


class _Operations(Mapping):
    """operation id -> the operation, read from its commit."""

    def __init__(self, graph):
        self.graph = graph

    def __getitem__(self, key):
        origin = self.graph.origins[key]
        return next(op for op in self.graph.commits[origin]["operations"] if op["id"] == key)

    def __contains__(self, key):
        return self.graph._has_operation(key)

    def __iter__(self):
        return iter(self.graph.origins)

    def __len__(self):
        return self.graph._op_count


# --- checking ---------------------------------------------------------------------------------

def verify(conn) -> None:
    """Fail loudly if the index differs from a full replay of graph_commits."""
    replay = Graph((json.loads(r[0]) for r in conn.execute("SELECT data FROM graph_commits")), copy_commits=False)
    index = IndexedGraph(conn)
    index.preload()
    problems = []
    if index.heads != replay.heads:
        problems.append("heads")
    if index.collection != replay.collection:
        problems.append("collection")
    if index.order != replay.order:
        problems.append("order")
    if dict(index.objects.items()) != replay.objects or list(index.objects) != list(replay.objects):
        problems.append("objects")
    if dict(index.edges.items()) != replay.edges or list(index.edges) != list(replay.edges):
        problems.append("edges")
    if {k: v for k, v in index.versions.items()} != {k: v for k, v in replay.versions.items() if v}:
        problems.append("registers")
    if {k: index.creation[k] for k in index.creation} != replay.creation:
        problems.append("creation")
    if dict(conn.execute("SELECT id, origin FROM graph_index_operations").fetchall()) != replay.origins:
        problems.append("operations")
    fresh = IndexedGraph(conn)
    for commit, people in conn.execute("SELECT id, people FROM graph_index_affected").fetchall():
        if sorted(fresh._affected_people(commit, OWNERSHIP)) != json.loads(people):
            problems.append("affected")
            break
    if problems:
        raise AssertionError(f"Graph index differs from a full replay: {', '.join(problems)}")
