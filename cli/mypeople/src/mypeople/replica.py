"""Replicated, causal contact history (wire version 1).

Changes are immutable and address UUIDs, never SQLite IDs. Scalar fields are
multi-value registers; list fields are observed-remove sets of tagged additions.
Merge edges join identities without deleting their contact history. SQL is a
materialized compatibility view, not the replication authority. Messages are not
replicated. A split of an already merged message history is deliberately unsupported.
"""
from __future__ import annotations

import heapq
import json
import uuid
from dataclasses import dataclass, field

LISTS = {"fields", "originals", "source_records"}
DEFAULTS = dict.fromkeys(("given", "family", "middle", "prefix", "suffix", "phonetic", "birthday", "organization", "title", "notes", "photo", "preferred_channel"), "") | {
    "region": "US", "favorite": False, "user_edited": False, "legacy_unverified": False,
}
SCHEMA = """
CREATE TABLE IF NOT EXISTS contact_changes (id TEXT PRIMARY KEY, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS contact_projection (uid TEXT PRIMARY KEY, data TEXT NOT NULL);
"""


def encoded(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def card_values(card):
    return DEFAULTS | {k: v for k, v in card.items() if k not in LISTS | {"edit_id"}}


def ordered(changes):
    """Validate the entire DAG before accepting any part; iterative, bounded, no recursion."""
    if len(changes) > 200_000:
        raise ValueError("Contact history exceeds the supported limit")
    by_id, valid_uuids, parent_groups = {}, set(), {}
    for c in changes:
        if not isinstance(c, dict):
            raise ValueError("Invalid contact change")
        try:
            for value in [c["id"], c["contact_uid"], *c.get("parents", []), *c.get("links", [])]:
                if value not in valid_uuids:
                    if str(uuid.UUID(value)) != value:
                        raise ValueError("Noncanonical contact UUID")
                    valid_uuids.add(value)
            if not isinstance(c.get("parents", []), list) or len(set(c.get("parents", []))) != len(c.get("parents", [])):
                raise ValueError("Invalid contact parents")
            if not isinstance(c.get("links", []), list) or len(c.get("links", [])) > 10000:
                raise ValueError("Invalid contact merge")
            for key in ("values", "adds", "removes", "replaces"):
                if not isinstance(c.get(key, {}), dict):
                    raise ValueError("Invalid contact patch")
            if any(k not in LISTS or not isinstance(v, list) for key in ("adds", "removes") for k, v in c.get(key, {}).items()):
                raise ValueError("Invalid contact list patch")
            if any(k in LISTS | {"edit_id"} for k in c.get("values", {})):
                raise ValueError("Invalid scalar contact field")
            if any(not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags) for key in ("removes", "replaces") for tags in c.get(key, {}).values()):
                raise ValueError("Invalid removed contact field")
        except (KeyError, TypeError, AttributeError) as exc:
            raise ValueError("Invalid contact change") from exc
        c = {k: c.get(k, default) for k, default in (("id", None), ("contact_uid", None), ("parents", []), ("values", {}), ("adds", {}), ("removes", {}), ("links", []), ("replaces", {}))}
        parents = tuple(c["parents"])
        c["parents"] = parent_groups.setdefault(parents, c["parents"])
        if c["id"] in by_id and by_id[c["id"]] != c:
            raise ValueError("A contact change UUID was reused for different content")
        by_id[c["id"]] = c
    if len(by_id) > 100_000:
        raise ValueError("Contact history exceeds the supported limit")
    if sum(len(c["parents"]) for c in by_id.values()) > 8_000_000:
        raise ValueError("Contact history has too many parent edges")
    children = {i: [] for i in by_id}
    degrees = {}
    for i, c in by_id.items():
        degrees[i] = len(c.get("parents", []))
        for p in c.get("parents", []):
            if p not in by_id:
                raise ValueError("Contact history is missing a parent; sync its history first")
            children[p].append(i)
    ready = [i for i, degree in degrees.items() if not degree]
    heapq.heapify(ready)
    out = []
    while ready:
        i = heapq.heappop(ready)
        out.append(by_id[i])
        for child in children[i]:
            degrees[child] -= 1
            if not degrees[child]:
                heapq.heappush(ready, child)
    if len(out) != len(by_id):
        raise ValueError("Cyclic contact history")
    return out


@dataclass
class Contact:
    uid: str
    members: list[str]
    card: dict = field(default_factory=dict)
    trashed: bool = False
    conflicts: dict = field(default_factory=dict)
    tags: dict = field(default_factory=dict)
    registers: dict = field(default_factory=dict)
    is_me: bool = False


class History:
    def __init__(self, changes=()):
        self.changes = ordered(list(changes))
        self.by_id = {c["id"]: c for c in self.changes}
        parents = {p for c in self.changes for p in c.get("parents", [])}
        self.heads = sorted(self.by_id.keys() - parents)
        self._rank = {c["id"]: i for i, c in enumerate(self.changes)}
        self._parent_sets = {}
        for c in self.changes:
            if id(c["parents"]) not in self._parent_sets:
                self._parent_sets[id(c["parents"])] = set(c["parents"])
        created = {}
        for c in self.changes:
            if "name" in c["values"]: created.setdefault(c["contact_uid"], set()).add(c["id"])
        for c in self.changes:
            if c["links"]:
                if any(not any(dot == c["id"] or self.observed(dot, c["parents"]) for dot in created.get(uid, ()))
                       for uid in [c["contact_uid"], *c["links"]]):
                    raise ValueError("A merge references an unobserved contact")
        self.contacts = self._reduce()
        self.by_member = {uid: c for c in self.contacts.values() for uid in c.members}

    def observed(self, origin, heads):
        """Exact reachability without constructing the entire past for each field.

        Bulk bootstrap changes share frontiers. Most validations are direct parent
        membership; a later merge usually needs just one additional frontier lookup.
        Topological ranks safely prune branches that precede the sought ancestor.
        """
        rank = self._rank.get(origin)
        if rank is None: return False
        if origin in self._parent_sets.get(id(heads), heads): return True
        seen, todo, expanded = set(), list(heads), set()
        while todo:
            node = todo.pop()
            if node in seen or self._rank[node] < rank: continue
            seen.add(node)
            parents = self.by_id[node]["parents"]
            if origin in self._parent_sets[id(parents)]: return True
            if id(parents) not in expanded:
                expanded.add(id(parents))
                todo.extend(p for p in parents if p not in seen and self._rank[p] >= rank)
        return False

    def past(self, heads):
        seen, todo, expanded = set(), list(heads), set()
        while todo:
            i = todo.pop()
            if i not in self.by_id:
                raise ValueError("Unknown contact history head")
            if i not in seen:
                seen.add(i)
                parents = self.by_id[i]["parents"]
                if id(parents) not in expanded:
                    expanded.add(id(parents))
                    todo.extend(parents)
        return seen

    def missing(self, heads):
        known = self.past(heads)
        return [c for c in self.changes if c["id"] not in known]

    def _reduce(self):
        roots = {}
        def root(uid):
            roots.setdefault(uid, uid)
            trail = []
            while roots[uid] != uid:
                trail.append(uid); uid = roots[uid]
            for p in trail:
                roots[p] = uid
            return uid
        for c in self.changes:
            ids = [c["contact_uid"], *c.get("links", [])]
            r = min(root(uid) for uid in ids)
            for uid in ids:
                roots[root(uid)] = r
        members = {}
        for uid in roots:
            members.setdefault(root(uid), []).append(uid)
        scalars, additions, removals = {}, {}, set()
        # Registers retain only causally maximal writes, not arbitrary arrival order.
        for c in self.changes:
            r, cid = root(c["contact_uid"]), c["id"]
            for key, value in c.get("values", {}).items():
                register = scalars.setdefault((r, key), {})
                for old in c.get("replaces", {}).get(key, []):
                    if not self.observed(old, c["parents"]) or key not in self.by_id[old].get("values", {}):
                        raise ValueError("A contact edit replaces an unobserved value")
                    register.pop(old, None)
                register[cid] = value
            for key, values in c.get("adds", {}).items():
                for index, value in enumerate(values):
                    additions.setdefault((r, key), {})[f"{cid}:{key}:{index}"] = value
            for key, tags in c.get("removes", {}).items():
                for tag in tags:
                    origin = tag.split(":", 1)[0]
                    if not self.observed(origin, c["parents"]) or tag not in additions.get((r, key), {}):
                        raise ValueError("A contact edit removes an unobserved addition")
                    removals.add(tag)
        by_contact = {}
        for (uid, key), register in scalars.items():
            by_contact.setdefault(uid, {})[key] = register
        result = {}
        for r, uids in members.items():
            contact = Contact(r, sorted(uids), card=dict(DEFAULTS))
            contact.registers = by_contact.get(r, {})
            for key, register in contact.registers.items():
                value = register[max(register)]
                if key == "_trashed":
                    contact.trashed = value
                elif key == "_is_me":
                    contact.is_me = value
                else:
                    contact.card[key] = value
                if len({encoded(v) for v in register.values()}) > 1:
                    contact.conflicts[key] = [{"change": i, "value": v} for i, v in sorted(register.items())]
            for key in sorted(LISTS):
                tags = {t: v for t, v in additions.get((r, key), {}).items() if t not in removals}
                contact.tags[key] = tags
                # Sort by tag (ASCII UUID), not language-specific JSON key ordering.
                unique = {}
                for t, v in sorted(tags.items()):
                    unique.setdefault(encoded(v), v)
                contact.card[key] = list(unique.values())
            if "name" not in contact.card:
                raise ValueError("Contact history references an uncreated contact")
            from .contacts import validate
            validate(contact.card)
            if not isinstance(contact.trashed, bool) or not isinstance(contact.is_me, bool):
                raise ValueError("Invalid contact trash state")
            result[r] = contact
        return result

    def contact(self, uid):
        return self.by_member.get(uid)

    def merge_values(self, uids, card):
        authored = {key for uid in uids if (c := self.contact(uid)) for key in c.registers}
        return {key: value for key, value in card_values(card).items() if key in authored}

    def edit(self, uid, card=None, *, trashed=None, links=(), values=None, change_id=None):
        previous = self.contact(uid)
        scalar = dict(values or {})
        adds, removes = {}, {}
        if card is not None:
            before = card_values(previous.card) if previous else {}
            for key, value in card_values(card).items():
                if previous is None and key in DEFAULTS and value == DEFAULTS[key] and key not in scalar:
                    continue
                if key not in before or before[key] != value:
                    scalar[key] = value
            for key in sorted(LISTS):
                old = previous.tags.get(key, {}) if previous else {}
                items = card.get(key, [])
                if key == "fields":
                    items = [{"label": "", "preferred": False, "structured": "", "region": ""} | v for v in items]
                wanted = {encoded(v): v for v in items}
                existing = {encoded(v) for v in old.values()}
                new = [v for k, v in wanted.items() if k not in existing]
                gone = [t for t, v in old.items() if encoded(v) not in wanted]
                if new: adds[key] = new
                if gone: removes[key] = gone
        if trashed is not None and ((previous is None and trashed) or (previous is not None and (previous.trashed != trashed or "_trashed" in previous.conflicts))):
            scalar["_trashed"] = trashed
        scope = [c for target in [uid, *links] if (c := self.contact(target))]
        replaces = {key: sorted({dot for c in scope for dot in c.registers.get(key, {})}) for key in scalar}
        return {"id": change_id or str(uuid.uuid4()), "parents": self.heads, "contact_uid": uid,
                "values": scalar, "adds": adds, "removes": removes, "links": list(links), "replaces": replaces}


def prepare(conn):
    # No executescript: it would commit a surrounding receipt transaction.
    for statement in SCHEMA.split(";"):
        if statement.strip(): conn.execute(statement)


def load(conn):
    prepare(conn)
    return History([json.loads(r[0]) for r in conn.execute("SELECT data FROM contact_changes")])


def receive(conn, changes):
    if not isinstance(changes, list): raise ValueError("Invalid contact history list")
    if not conn.in_transaction: conn.execute("BEGIN IMMEDIATE")
    current = load(conn)
    history = History([*current.changes, *changes])
    for c in history.changes:
        if c["id"] not in current.by_id:
            conn.execute("INSERT INTO contact_changes VALUES (?, ?)", (c["id"], encoded(c)))
    materialize(conn, history)
    return history


def _sql_card(conn, row):
    if row["contact_data"]:
        card = json.loads(row["contact_data"])
    else:
        card = {"name": row["name"], "legacy_unverified": True, "fields": [dict(r) for r in conn.execute(
            "SELECT kind, value FROM identifiers WHERE person_id=? AND kind IN ('phone','email') ORDER BY id", (row["id"],))]}
    if card.get("name", "").strip() != row["name"]:
        card["name"] = row["name"]  # capture legacy SQL renames, not save() whitespace normalization
    return card


def capture(conn):
    """Record legacy CLI/import changes as field patches BEFORE receiving remote history.

    Serialize the read/append/projection transaction across CLI processes. Callers
    commit it with their operation/receipt; this function never commits internally.
    """
    if not conn.in_transaction: conn.execute("BEGIN IMMEDIATE")
    history = load(conn)
    changes = []
    for row in conn.execute("SELECT * FROM people WHERE is_me=0 AND merged_into IS NULL ORDER BY id").fetchall():
        uid = row["contact_uid"] or str(uuid.uuid4())
        if not row["contact_uid"]:
            conn.execute("UPDATE people SET contact_uid=? WHERE id=?", (uid, row["id"]))
        card = _sql_card(conn, row)
        state = {"card": card, "trashed": bool(row["trashed"])}
        old = conn.execute("SELECT data FROM contact_projection WHERE uid=?", (uid,)).fetchone()
        if old and json.loads(old[0]) == state and not (history.contact(uid) and history.contact(uid).is_me):
            continue
        links = [r[0] for r in conn.execute("SELECT contact_uid FROM people WHERE merged_into=? AND contact_uid<>''", (row["id"],)) if history.contact(r[0])]
        change = history.edit(uid, card, trashed=bool(row["trashed"]), links=links, values=(history.merge_values([uid, *links], card) if links else {}) | ({"_is_me": False} if history.contact(uid) and history.contact(uid).is_me else {}))
        changes.append(change)
        conn.execute("INSERT INTO contact_changes VALUES (?, ?)", (change["id"], encoded(change)))
        conn.execute("INSERT OR REPLACE INTO contact_projection VALUES (?, ?)", (uid, encoded(state)))
    if changes:
        history = History([*history.changes, *changes])
    # Preserve pre-upgrade redirect UUIDs too. They remain valid addresses on peers.
    from .identity import canonical
    aliases, seeds = {}, []
    for row in conn.execute("SELECT * FROM people WHERE merged_into IS NOT NULL AND is_me=0").fetchall():
        uid = row["contact_uid"] or str(uuid.uuid4())
        if history.contact(uid): continue
        target = conn.execute("SELECT * FROM people WHERE id=?", (canonical(conn, row["id"]),)).fetchone()
        if target is None or target["is_me"] or not history.contact(target["contact_uid"]): continue
        if not row["contact_uid"]: conn.execute("UPDATE people SET contact_uid=? WHERE id=?", (uid, row["id"]))
        seed = history.edit(uid, {"name": row["name"]})
        seeds.append(seed)
        aliases.setdefault(target["contact_uid"], []).append(uid)
    if seeds:
        for c in seeds: conn.execute("INSERT INTO contact_changes VALUES (?, ?)", (c["id"], encoded(c)))
        history = History([*history.changes, *seeds])
        links = [history.edit(uid, links=uids, values=history.merge_values([uid, *uids], history.contact(uid).card)) for uid, uids in aliases.items()]
        for c in links: conn.execute("INSERT INTO contact_changes VALUES (?, ?)", (c["id"], encoded(c)))
        history = History([*history.changes, *links])
    people = {r["id"]: r for r in conn.execute("SELECT id, contact_uid, merged_into, is_me FROM people")}
    hidden = set()
    for row in people.values():
        target = row
        while target["merged_into"] is not None: target = people[target["merged_into"]]
        c = history.contact(row["contact_uid"])
        if target["is_me"] and c and not c.is_me: hidden.add(c.uid)
    hiding = [history.edit(uid, values={"_is_me": True}) for uid in sorted(hidden)]
    if hiding:
        for c in hiding: conn.execute("INSERT INTO contact_changes VALUES (?, ?)", (c["id"], encoded(c)))
        history = History([*history.changes, *hiding])
    if changes or seeds or hiding:
        materialize(conn, history)
    return history


def materialize(conn, history):
    from . import contacts, identity
    for c in history.contacts.values():
        rows = {}
        for uid in c.members:
            row = conn.execute("SELECT * FROM people WHERE contact_uid=?", (uid,)).fetchone()
            if not row:
                pid = conn.execute("INSERT INTO people(name, contact_uid) VALUES (?, ?)", (c.card["name"], uid)).lastrowid
                row = conn.execute("SELECT * FROM people WHERE id=?", (pid,)).fetchone()
            rows[uid] = row
        keep = rows[c.uid]["id"]
        if c.is_me:
            # Never overwrite a private self-record with its historical public card.
            for row in rows.values(): conn.execute("UPDATE people SET is_me=1 WHERE id=?", (row["id"],))
            continue
        conn.execute("UPDATE people SET is_me=0 WHERE id=?", (keep,))
        # Compatibility projection for existing message/event queries. The immutable
        # contact originals and field dots above are never physically merged away.
        if len(rows) > 1:
            # The canonical UUID is chosen deterministically, not by display
            # name. Remember a nickname before projecting the chosen full name
            # onto that UUID, otherwise re-imports forget an explicit merge.
            for row in rows.values():
                if row["name"].casefold() != c.card["name"].casefold() and not identity.looks_like_identifier(row["name"]):
                    identity.add_alias(conn, keep, row["name"])
            active = [r["id"] for r in rows.values() if r["merged_into"] is None and r["id"] != keep]
            conn.execute("UPDATE people SET merged_into=NULL WHERE id=?", (keep,))
            for pid in active:
                identity.merge(conn, keep, pid)
            for row in rows.values():
                if row["id"] != keep:
                    conn.execute("UPDATE people SET merged_into=? WHERE id=?", (keep, row["id"]))
        state = {"card": c.card, "trashed": c.trashed}
        old = conn.execute("SELECT data FROM contact_projection WHERE uid=?", (c.uid,)).fetchone()
        if not old or json.loads(old[0]) != state:
            contacts.save(conn, c.uid, c.card, keep)
            conn.execute("UPDATE people SET trashed=? WHERE id=?", (int(c.trashed), keep))
        conn.execute("INSERT OR REPLACE INTO contact_projection VALUES (?, ?)", (c.uid, encoded(state)))


def change(conn, uid, card=None, **kwargs):
    history = capture(conn)
    c = history.edit(uid, card, **kwargs)
    return receive(conn, [c]), c
