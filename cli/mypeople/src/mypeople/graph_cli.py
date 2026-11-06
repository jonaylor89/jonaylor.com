"""Explicit graph workbench. Requires a separate store path; no default personal DB."""
from __future__ import annotations

import json
import sqlite3
from contextlib import closing
from pathlib import Path

from .graph import EDGE_TYPES, OBJECT_TYPES, GraphError, Store, create_edge, create_object, transaction


def run(_conn, args):
    path = args.store.expanduser().resolve()
    source_path = args.source.expanduser().resolve() if args.action == "migrate" else None
    if source_path == path:
        raise SystemExit("Choose a separate graph store; the source database must remain untouched.")
    if args.action in ("export", "import") and args.path.expanduser().resolve() == path:
        raise SystemExit("The archive and graph store must be separate files.")
    if args.action == "export" and args.path.expanduser().resolve() == args.password_file.expanduser().resolve():
        raise SystemExit("An archive must not overwrite its passphrase file.")
    if args.action not in ("init", "migrate", "import") and not path.is_file():
        raise SystemExit("Graph store does not exist. Run graph init or migrate first.")
    if path.exists() and path.stat().st_size:
        with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as check:
            if check.execute("SELECT 1 FROM sqlite_master WHERE name='people'").fetchone():
                raise SystemExit("This is a legacy app database. Choose a separate graph store.")
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        with transaction(conn):
            store = Store(conn)
            graph = store.load()
            action = args.action
            if action == "init":
                result = {"collection": store.collection, "peer": store.peer}
            elif action == "migrate":
                from .graph_migration import migrate
                with closing(sqlite3.connect(source_path.as_uri() + "?mode=ro", uri=True)) as source:
                    result = migrate(source, store)
            elif action == "status":
                result = {"collection": store.collection, "peer": store.peer, "commits": len(graph.commits), "objects": len(graph.objects), "edges": len(graph.edges), "heads": graph.heads, "identities": graph.components()}
            elif action == "show":
                result = graph.entity(args.id)
                result["associations"] = [graph.entity(key) for key, edge in sorted(graph.edges.items()) if args.id in (edge["from"], edge["to"])]
            elif action == "history":
                result = [graph.commits[key] for key in graph.order]
            elif action == "create":
                op = create_object(args.type, json.loads(args.properties))
                result = {"object": op["target"], "commit": store.write([op])["id"]}
            elif action == "link":
                op = create_edge(args.type, args.from_id, args.to_id, json.loads(args.properties))
                result = {"edge": op["target"], "commit": store.write([op])["id"]}
            elif action == "set":
                result = store.write([graph.edit(args.id, args.property, json.loads(args.value))])
            elif action in ("retract", "restore"):
                result = store.write([graph.edit(args.id, "_lifecycle", "retracted" if action == "retract" else "active")])
            elif action == "split":
                result = store.split(args.id, args.name, args.move)
            elif action in ("export", "import"):
                from .graph_transfer import export_graph, import_graph
                from .transfer import key_file
                password = key_file(args.password_file)
                result = export_graph(store, args.path, password) if action == "export" else import_graph(store, args.path, password, adopt=args.adopt)
            else:
                raise GraphError("Unknown graph action")
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except (ValueError, OSError, sqlite3.Error) as exc:
        raise SystemExit(str(exc)) from None
    finally:
        conn.close()


def parser(sub):
    p = sub.add_parser("graph", help="advanced graph workbench for a separate standalone store")
    p.add_argument("--store", required=True, type=Path, help="separate graph SQLite file, never the live legacy DB")
    actions = p.add_subparsers(dest="action", required=True)
    for action in ("init", "status", "history"):
        actions.add_parser(action)
    m = actions.add_parser("migrate", help="read a legacy DB without modifying it; destination must be empty")
    m.add_argument("--source", required=True, type=Path)
    c = actions.add_parser("create")
    c.add_argument("type", choices=sorted(OBJECT_TYPES))
    c.add_argument("--properties", default="{}", help="JSON object")
    link = actions.add_parser("link")
    link.add_argument("type", choices=sorted(EDGE_TYPES))
    link.add_argument("from_id")
    link.add_argument("to_id")
    link.add_argument("--properties", default="{}")
    for action in ("show", "set", "retract", "restore", "split"):
        command = actions.add_parser(action)
        command.add_argument("id")
        if action == "set":
            command.add_argument("property")
            command.add_argument("value", help="JSON value, e.g. '\"work\"'")
        elif action == "split":
            command.add_argument("--name", required=True)
            command.add_argument("--move", action="append", required=True, help="exact attribution edge UUID; repeat for each association")
    for action in ("export", "import"):
        command = actions.add_parser(action)
        command.add_argument("path", type=Path)
        command.add_argument("--password-file", required=True, type=Path)
        if action == "import":
            command.add_argument("--adopt", action="store_true", help="join an empty store to the archive's collection")
    p.set_defaults(func=run, needs_db=False)
