"""Identity resolution: one Person across address book, messages, and email."""

from __future__ import annotations

import json
import re
import sqlite3


class PersonNotFound(LookupError):
    pass


def normalize_phone(raw: str, region: str | None = None) -> str | None:
    digits = re.sub(r"\D", "", raw)
    from .contacts import phone
    normalized, _ = phone(raw, region)
    # Preserve the legacy NANP matching key, but NEVER truncate international
    # numbers. Dialing uses the separate, original contact-card value.
    if normalized:
        return normalized[2:] if normalized.startswith("+1") and len(normalized) == 12 else normalized
    if len(digits) < 7:
        return None
    return ("+" if raw.strip().startswith("+") else "") + digits


def normalize_email(raw: str) -> str | None:
    raw = raw.strip().lower()
    return raw if "@" in raw else None


def normalize_handle(raw: str) -> tuple[str, str] | None:
    """Classify a raw handle (iMessage id, address, number) as (kind, value)."""
    if "@" in raw:
        email = normalize_email(raw)
        return ("email", email) if email else None
    phone = normalize_phone(raw)
    return ("phone", phone) if phone else None


def looks_like_identifier(name: str) -> bool:
    return "@" in name or not re.search(r"[^\W\d_]", name)


def find_by_identifier(conn: sqlite3.Connection, kind: str, value: str) -> int | None:
    from .contacts import phone, contact_phone
    key = phone(value)[0] if kind == "phone" else value.strip().lower()
    if kind in ("phone", "email") and key:
        matches = conn.execute("SELECT DISTINCT p.id, p.contact_data FROM contact_keys k JOIN people p ON p.id=k.person_id WHERE k.kind=? AND k.value=? AND p.merged_into IS NULL AND p.trashed=0", (kind, key)).fetchall()
        if kind == "phone":
            matches = [r for r in matches if not r["contact_data"] or not (card := json.loads(r["contact_data"])).get("legacy_unverified") or any(f.get("kind") == "phone" and contact_phone(card, f)[0] == key for f in card.get("fields", []))]
        if len(matches) > 1:
            return None  # a shared household address/number is not a unique person
        if matches:
            return matches[0]["id"]
    row = conn.execute(
        "SELECT person_id FROM identifiers WHERE kind = ? AND value = ?", (kind, value)
    ).fetchone()
    if not row:
        return None
    pid = canonical(conn, row["person_id"])
    if kind in ("phone", "email"):
        person = conn.execute("SELECT contact_data FROM people WHERE id=?", (pid,)).fetchone()
        if person and person["contact_data"]:
            card = json.loads(person["contact_data"])
            if card.get("user_edited") or (kind == "phone" and any(f.get("kind") == "phone" for f in card.get("fields", []))):
                # A historical suffix-only identifier must not override a full,
                # country-aware contact number (or a manually removed field).
                return None
    return pid


def canonical(conn: sqlite3.Connection, person_id: int) -> int:
    """Follow merge pointers to the surviving person."""
    while True:
        row = conn.execute("SELECT merged_into FROM people WHERE id = ?", (person_id,)).fetchone()
        if row is None or row["merged_into"] is None:
            return person_id
        person_id = row["merged_into"]


def matches_known_name(conn: sqlite3.Connection, person_id: int, name: str) -> bool:
    """Recognize prior explicit merges without inferring identity from nicknames.

    A dropped record's name remains evidence even if the surviving card was
    renamed or the merge happened on a replicated peer. Follow every redirect,
    not just direct children, and never do fuzzy/first-name matching here.
    """
    person_id = canonical(conn, person_id)
    folded = " ".join(name.split()).casefold()
    if not folded:
        return False
    members = (
        "WITH RECURSIVE members(id, name, contact_uid) AS ("
        "SELECT id, name, contact_uid FROM people WHERE id=? UNION "
        "SELECT p.id, p.name, p.contact_uid FROM people p JOIN members m ON p.merged_into=m.id) "
    )
    names = conn.execute(members + "SELECT name FROM members UNION SELECT alias FROM aliases WHERE person_id IN (SELECT id FROM members)", (person_id,))
    matches = lambda rows: any(" ".join(row[0].split()).casefold() == folded for row in rows if row[0])
    if matches(names):
        return True
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='contact_changes'").fetchone():
        # Older replicated merges overwrote the root's nickname without saving
        # an alias. Its immutable authored name still proves that prior identity.
        return matches(conn.execute(members +
            "SELECT json_extract(data, '$.values.name') FROM contact_changes "
            "WHERE json_extract(data, '$.contact_uid') IN (SELECT contact_uid FROM members)", (person_id,)))
    return False


def add_identifier(conn: sqlite3.Connection, person_id: int, kind: str, value: str, source: str) -> None:
    conn.execute(
        "INSERT OR IGNORE INTO identifiers (person_id, kind, value, source) VALUES (?, ?, ?, ?)",
        (person_id, kind, value, source),
    )


def create_person(conn: sqlite3.Connection, name: str) -> int:
    import uuid
    return conn.execute("INSERT INTO people (name, contact_uid) VALUES (?, ?)", (name, str(uuid.uuid4()))).lastrowid


def resolve(
    conn: sqlite3.Connection,
    identifiers: list[tuple[str, str]],
    name: str | None,
    source: str,
    create: bool = True,
    match_name: bool = False,
) -> int | None:
    """Find the person behind these identifiers, attaching any new ones.

    match_name allows falling back to an exact (case-insensitive) name match,
    which is only safe for address book entries the user curated themselves.
    """
    person_id = None
    for kind, value in identifiers:
        person_id = find_by_identifier(conn, kind, value)
        if person_id:
            break
    if person_id is None and match_name and name:
        rows = conn.execute(
            "SELECT id FROM people WHERE merged_into IS NULL AND is_me = 0 AND lower(name) = lower(?)", (name,)
        ).fetchall()
        if len(rows) == 1:
            person_id = rows[0]["id"]
    if person_id is None:
        if not create:
            return None
        person_id = create_person(conn, name or identifiers[0][1])
    elif name and not looks_like_identifier(name):
        current = conn.execute("SELECT name FROM people WHERE id = ?", (person_id,)).fetchone()["name"]
        if looks_like_identifier(current):
            conn.execute("UPDATE people SET name = ? WHERE id = ?", (name, person_id))
    for kind, value in identifiers:
        add_identifier(conn, person_id, kind, value, source)
    return person_id


def lookup(conn: sqlite3.Connection, query: str) -> sqlite3.Row:
    """Find one person by id, exact name or nickname, or a unique part of one. 'me' finds the user."""
    if query.lower() in ("me", "myself") and (user := me(conn)):
        return user
    if query.isdigit():
        row = conn.execute("SELECT * FROM people WHERE id = ?", (int(query),)).fetchone()
        if row:
            return conn.execute(
                "SELECT * FROM people WHERE id = ?", (canonical(conn, row["id"]),)
            ).fetchone()
    live = "SELECT * FROM people WHERE merged_into IS NULL AND "
    by_alias = "id IN (SELECT person_id FROM aliases WHERE lower(alias) {} lower(?))"
    rows = conn.execute(live + f"(lower(name) = lower(?) OR {by_alias.format('=')})", (query, query)).fetchall()
    if not rows:
        like = f"%{query}%"
        rows = conn.execute(live + f"(lower(name) LIKE lower(?) OR {by_alias.format('LIKE')})", (like, like)).fetchall()
    if len(rows) == 1:
        return rows[0]
    if not rows:
        raise PersonNotFound(f"No one matches {query!r}.")
    names = ", ".join(f"{r['name']} (#{r['id']})" for r in rows[:10])
    hint = ""
    if len({" ".join(r["name"].lower().split()) for r in rows}) == 1:
        hint = f"\nUse an id instead, or if they're one person: mypeople merge {rows[0]['id']} {rows[1]['id']}"
    raise PersonNotFound(f"{query!r} is ambiguous: {names}{hint}")


def merge(conn: sqlite3.Connection, keep_id: int, drop_id: int) -> None:
    """Fold drop_id into keep_id. The dropped row stays as a redirect."""
    if keep_id == drop_id:
        return
    from . import graph_runtime
    if graph_runtime.enabled(conn):
        graph_runtime.merge(conn, [keep_id, drop_id], preferred=keep_id)
        return
    from .db import normalize_profiles, sync_legacy_extraction

    # Pin down what's already been read for both before their histories combine.
    sync_legacy_extraction(conn, (keep_id, drop_id))
    conn.execute("DELETE FROM extraction_state WHERE person_id IN (?, ?)", (keep_id, drop_id))
    conn.execute("UPDATE identifiers SET person_id = ? WHERE person_id = ?", (keep_id, drop_id))
    conn.execute("UPDATE interactions SET person_id = ? WHERE person_id = ?", (keep_id, drop_id))
    conn.execute(
        "UPDATE events SET generation = d.generation, status = d.status FROM events d WHERE events.person_id = ? AND d.person_id = ? "
        "AND events.type = d.type AND events.value = d.value AND events.date = d.date AND d.generation > events.generation",
        (keep_id, drop_id))
    conn.execute("UPDATE OR IGNORE events SET person_id = ? WHERE person_id = ?", (keep_id, drop_id))
    conn.execute("DELETE FROM events WHERE person_id = ?", (drop_id,))
    conn.execute("UPDATE moments SET person_id = ? WHERE person_id = ?", (keep_id, drop_id))
    conn.execute("UPDATE OR IGNORE aliases SET person_id = ? WHERE person_id = ?", (keep_id, drop_id))
    conn.execute("DELETE FROM aliases WHERE person_id = ?", (drop_id,))
    conn.execute("UPDATE OR IGNORE photos SET person_id = ? WHERE person_id = ?", (keep_id, drop_id))
    conn.execute("DELETE FROM photos WHERE person_id = ?", (drop_id,))
    normalize_profiles(conn)
    priority = {"confirmed": 0, "rejected": 1, "suggested": 2}
    for dropped in conn.execute("SELECT * FROM profiles WHERE person_id = ?", (drop_id,)).fetchall():
        kept = conn.execute("SELECT * FROM profiles WHERE person_id = ? AND url = ?", (keep_id, dropped['url'])).fetchone()
        if kept is None:
            conn.execute("UPDATE profiles SET person_id = ? WHERE id = ?", (keep_id, dropped['id']))
            continue
        winner = dropped if priority[dropped['status']] < priority[kept['status']] else kept
        sources = json.loads(kept['sources']) + json.loads(dropped['sources'])
        sources.append({"source": "person_merge", "url": dropped['url'], "decision": dropped['status']})
        conn.execute("UPDATE profiles SET status=?, title=?, snippet=?, confidence=?, reason=?, assessment=?, evidence=?, sources=? WHERE id=?",
                     (*[winner[k] for k in ('status', 'title', 'snippet', 'confidence', 'reason', 'assessment', 'evidence')],
                      json.dumps(sources), kept['id']))
        conn.execute("DELETE FROM profiles WHERE id = ?", (dropped['id'],))
    conn.execute("DELETE FROM profile_searches WHERE person_id = ?", (drop_id,))
    conn.execute(
        "UPDATE people SET is_me = MAX(is_me, (SELECT is_me FROM people WHERE id = ?)) WHERE id = ?", (drop_id, keep_id)
    )
    conn.execute(
        "INSERT OR IGNORE INTO relationship_overrides (person_id, category, closeness, cadence_days, muted) "
        "SELECT ?, category, closeness, cadence_days, muted FROM relationship_overrides WHERE person_id = ?",
        (keep_id, drop_id),
    )
    conn.execute("DELETE FROM relationship_overrides WHERE person_id = ?", (drop_id,))
    from .contacts import card_for, rebuild_keys
    kept = conn.execute("SELECT * FROM people WHERE id=?", (keep_id,)).fetchone()
    dropped = conn.execute("SELECT * FROM people WHERE id=?", (drop_id,)).fetchone()
    a, b = card_for(kept), card_for(dropped)
    if b:
        if a:
            incoming_fields = [f | ({"region": b.get("region", "US")} if f.get("kind") == "phone" and not f.get("region") else {}) for f in b.get("fields", [])]
            a["fields"] = list({json.dumps(f, sort_keys=True): f for f in a.get("fields", []) + incoming_fields}.values())
            a["source_records"] = list(dict.fromkeys(a.get("source_records", []) + b.get("source_records", [])))
            a["originals"] = list(dict.fromkeys(a.get("originals", []) + b.get("originals", [])))
            for key, value in b.items():
                if not a.get(key):
                    a[key] = value
            if b.get("notes") and b["notes"] != a.get("notes"):
                a["notes"] = a.get("notes", "") + "\n\n" + b["notes"]
        else:
            a = b | {"name": kept["name"]}
        a["name"] = kept["name"]
        conn.execute("UPDATE people SET contact_data=? WHERE id=?", (json.dumps(a, ensure_ascii=False), keep_id))
        rebuild_keys(conn, keep_id, a)
    conn.execute("UPDATE people SET merged_into = ? WHERE id = ?", (keep_id, drop_id))


def name_duplicates(conn: sqlite3.Connection) -> list[list[sqlite3.Row]]:
    """Groups of live people sharing a full name: likely one person seen through different sources."""
    rows = conn.execute(
        "SELECT p.*, (SELECT COUNT(*) FROM interactions i WHERE i.person_id = p.id) AS n "
        "FROM people p WHERE merged_into IS NULL AND is_me = 0 ORDER BY n DESC"
    ).fetchall()
    groups: dict[str, list[sqlite3.Row]] = {}
    for r in rows:
        if not looks_like_identifier(r["name"]):
            groups.setdefault(" ".join(r["name"].lower().split()), []).append(r)
    return [g for g in groups.values() if len(g) > 1]


def me(conn: sqlite3.Connection) -> sqlite3.Row | None:
    return conn.execute("SELECT * FROM people WHERE is_me = 1 AND merged_into IS NULL").fetchone()


def set_me(conn: sqlite3.Connection, person_ids: list[int]) -> int:
    """Mark these records as the user, folding them into one."""
    current = me(conn)
    keep = current["id"] if current else person_ids[0]
    conn.execute("UPDATE people SET is_me = 1 WHERE id = ?", (keep,))
    for pid in person_ids:
        merge(conn, keep, canonical(conn, pid))
    return keep


def my_addresses(conn: sqlite3.Connection) -> set[str]:
    """The user's own email addresses, as recorded on their own record."""
    row = me(conn)
    if not row:
        return set()
    return {r["value"] for r in conn.execute("SELECT value FROM identifiers WHERE person_id = ? AND kind = 'email'", (row["id"],))}


def aliases(conn: sqlite3.Connection, person_id: int) -> list[str]:
    return [r["alias"] for r in conn.execute("SELECT alias FROM aliases WHERE person_id = ? ORDER BY rowid", (person_id,))]


def add_alias(conn: sqlite3.Connection, person_id: int, alias: str) -> None:
    conn.execute("INSERT OR IGNORE INTO aliases (person_id, alias) VALUES (?, ?)", (person_id, alias.strip()))
