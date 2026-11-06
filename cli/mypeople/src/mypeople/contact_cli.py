"""Local-first CLI contact editing and conflict review."""
from __future__ import annotations

import json
import uuid

from . import contacts, identity, replica


def merge(conn, uids, preferred=None):
    from . import graph_runtime
    if graph_runtime.enabled(conn):
        ids = []
        for uid in dict.fromkeys(uids):
            row = conn.execute("SELECT id FROM people WHERE contact_uid=?", (uid,)).fetchone()
            if row is None: raise ValueError("Choose existing contacts")
            ids.append(row[0])
        keep = graph_runtime.merge(conn, ids)
        return replica.load(conn).contact(conn.execute("SELECT contact_uid FROM people WHERE id=?", (keep,)).fetchone()[0])
    h = replica.capture(conn)
    people = [h.contact(uid) for uid in dict.fromkeys(uids)]
    if len({c.uid for c in people if c}) < 2 or any(c is None for c in people):
        raise ValueError("Choose at least two different contacts")
    first = h.contact(preferred) if preferred else people[0]
    card = dict(first.card)
    for other in people:
        if other.uid == first.uid: continue
        for key, value in other.card.items():
            if key not in replica.LISTS and not card.get(key): card[key] = value
        if other.card.get("notes") and other.card["notes"] != card.get("notes"):
            card["notes"] = "\n\n".join(filter(None, (card.get("notes", ""), other.card["notes"])))
        card["favorite"] = bool(card.get("favorite") or other.card.get("favorite"))
        card["legacy_unverified"] = bool(card.get("legacy_unverified") or other.card.get("legacy_unverified"))
    values = h.merge_values([p.uid for p in people], card)
    if any("_trashed" in p.registers for p in people): values["_trashed"] = first.trashed
    c = h.edit(first.uid, links=[p.uid for p in people], values=values)
    return replica.receive(conn, [c]).contact(first.uid)


def run(conn, args):
    try:
        h = replica.capture(conn)
        if args.action in ("associations", "split"):
            from . import graph_runtime
            if not args.person: raise ValueError("Supply a contact name, #id or UUID")
            person = conn.execute("SELECT * FROM people WHERE contact_uid=?", (args.person,)).fetchone()
            if person is None: person = identity.lookup(conn,args.person)
            if args.action == "associations":
                result = graph_runtime.associations(conn,person["contact_uid"])
            else:
                result = graph_runtime.split(conn,person["contact_uid"],args.name,args.move,heads=args.heads)
            conn.commit()
            print(json.dumps(result,ensure_ascii=False))
            return
        if args.action == "create":
            if not args.person: raise ValueError("Supply a display name")
            uid, card = str(uuid.uuid4()), {"name": args.person}
        else:
            person = identity.lookup(conn, args.person) if args.person else None
            if args.action not in ("history", "conflicts") and person is None:
                raise ValueError("Supply a contact name or #id")
            c = h.contact(person["contact_uid"]) if person else None
            uid, card = (c.uid, dict(c.card)) if c else (None, None)
        previous = None if args.action == "create" else (c.card if c else None)
        if args.action == "history":
            for change in h.changes:
                if not uid or change["contact_uid"] in h.contact(uid).members:
                    print(json.dumps(change, ensure_ascii=False))
        elif args.action == "conflicts":
            found = False
            for c in ([h.contact(uid)] if uid else h.contacts.values()):
                for field, options in c.conflicts.items():
                    found = True
                    print(f"{c.card['name']} ({c.uid}) · {field}")
                    for option in options:
                        value = "<photo>" if field == "photo" else json.dumps(option["value"], ensure_ascii=False)
                        print(f"  {option['change']}  {value}")
            if not found: print("No contact conflicts.")
        elif args.action == "resolve":
            choice = next((v for v in h.contact(uid).conflicts.get(args.field, []) if v["change"] == args.change), None)
            if choice is None: raise ValueError("Choose a field and change UUID from `mypeople contact conflicts`")
            replica.change(conn, uid, values={args.field: choice["value"]})
            print("Conflict resolved locally. Sync to share the resolution.")
        elif args.action in ("trash", "restore"):
            replica.change(conn, uid, trashed=args.action == "trash")
            print("Moved to trash." if args.action == "trash" else "Restored.")
        else:
            if args.card:
                card = json.loads(args.card.read_text())
            for setting in args.set:
                key, sep, value = setting.partition("=")
                if not sep or key not in replica.DEFAULTS.keys() | {"name"}: raise ValueError("Use --set FIELD=VALUE for a scalar contact field")
                if isinstance(replica.DEFAULTS.get(key), bool):
                    if value not in ("true", "false"): raise ValueError(f"{key} must be true or false")
                    value = value == "true"
                card[key] = value
            for addition in args.add:
                kind, sep, value = addition.partition("=")
                if not sep or kind not in ("phone", "email", "address", "website", "im", "anniversary"): raise ValueError("Use --add KIND=VALUE")
                addition = {"kind": kind, "value": value}
                fields = card.get("fields", [])
                matches = [f for f in fields if f.get("kind") == kind and f["value"].strip() == value.strip()]
                if kind == "website" and matches:
                    card["fields"] = [f | {"user_added": True} if f in matches else f for f in fields]
                else:
                    if kind == "website":
                        addition["user_added"] = True
                    card["fields"] = [*fields, addition]
            for removal in args.remove:
                kind, sep, value = removal.partition("=")
                if not sep: raise ValueError("Use --remove KIND=VALUE")
                card["fields"] = [f for f in card.get("fields", []) if (f["kind"], f["value"]) != (kind, value)]
            contacts.validate(card)
            card = contacts.mark_manual_websites(card, previous)
            card["user_edited"] = True
            replica.change(conn, uid, card)
            print(f"Saved {card['name']} locally ({uid}).")
        conn.commit()
    except (ValueError, OSError) as exc:
        conn.rollback()
        raise SystemExit(str(exc)) from None


def parser(sub):
    from pathlib import Path
    p = sub.add_parser("contact", help="edit replicated contacts and review causal history/conflicts")
    p.add_argument("action", choices=("create", "edit", "trash", "restore", "history", "conflicts", "resolve", "associations", "split"))
    p.add_argument("person", nargs="?", help="contact name/#id, or display name for create")
    p.add_argument("field", nargs="?", help="resolve: conflicted field")
    p.add_argument("change", nargs="?", help="resolve: chosen change UUID")
    p.add_argument("--name", help="split: display name for the new person")
    p.add_argument("--move", action="append", default=[], metavar="EDGE_UUID", help="split: exact attribution edge to move; repeat for each selection")
    p.add_argument("--heads", action="append", default=None, metavar="COMMIT_UUID", help="split: expected association frontier; repeat for each head")
    p.add_argument("--card", type=Path, help="full contact card JSON")
    p.add_argument("--set", action="append", default=[], metavar="FIELD=VALUE")
    p.add_argument("--add", action="append", default=[], metavar="KIND=VALUE",
                   help="add a contact detail; supported social website URLs are also confirmed profiles")
    p.add_argument("--remove", action="append", default=[], metavar="KIND=VALUE")
    p.set_defaults(func=run)
