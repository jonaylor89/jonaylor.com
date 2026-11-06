"""SQLite storage. Everything lives in one local file the user owns."""

from __future__ import annotations

import json
import os
import sqlite3
from pathlib import Path

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    merged_into INTEGER REFERENCES people(id),
    is_me       INTEGER NOT NULL DEFAULT 0  -- the user's own record
);

-- Nicknames and other names a person goes by.
CREATE TABLE IF NOT EXISTS aliases (
    person_id INTEGER NOT NULL REFERENCES people(id),
    alias     TEXT NOT NULL,
    UNIQUE (person_id, alias COLLATE NOCASE)
);

-- Every way a person shows up in a source: phone, email, handle.
CREATE TABLE IF NOT EXISTS identifiers (
    id        INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id),
    kind      TEXT NOT NULL,
    value     TEXT NOT NULL,
    source    TEXT NOT NULL,
    UNIQUE (kind, value)
);

-- Dated facts about a person. A person's profile is derived from these.
-- date is '' (unknown), 'YYYY', 'YYYY-MM', 'YYYY-MM-DD', or '--MM-DD' (no year).
CREATE TABLE IF NOT EXISTS events (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES people(id),
    type       TEXT NOT NULL,
    value      TEXT NOT NULL,
    date       TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL,
    source     TEXT NOT NULL,
    source_ref TEXT,
    evidence   TEXT,
    status     TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime')),
    said_at    TEXT,  -- when it came up: the time of the message it was read from
    UNIQUE (person_id, type, value, date)
);

-- Contact between the user and a person. Text is kept locally for extraction.
CREATE TABLE IF NOT EXISTS interactions (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES people(id),
    at         TEXT NOT NULL,
    channel    TEXT NOT NULL,
    direction  TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    text       TEXT,
    thread     TEXT,
    source_ref TEXT NOT NULL UNIQUE,
    extracted  INTEGER NOT NULL DEFAULT 0  -- already read by event extraction
);
CREATE INDEX IF NOT EXISTS interactions_person_at ON interactions (person_id, at);

-- Relationships are inferred from interactions; these are the user's corrections.
CREATE TABLE IF NOT EXISTS relationship_overrides (
    person_id    INTEGER PRIMARY KEY REFERENCES people(id),
    category     TEXT,
    closeness    REAL,
    cadence_days REAL,
    muted        INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS moments (
    id          INTEGER PRIMARY KEY,
    key         TEXT NOT NULL UNIQUE,
    person_id   INTEGER NOT NULL REFERENCES people(id),
    kind        TEXT NOT NULL,
    reason      TEXT NOT NULL,
    context     TEXT,
    score       REAL NOT NULL,
    surfaced_on TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'new'
);

-- Profile pictures found in local sources, copied under ~/.mypeople/photos.
CREATE TABLE IF NOT EXISTS photos (
    id        INTEGER PRIMARY KEY,
    person_id INTEGER NOT NULL REFERENCES people(id),
    source    TEXT NOT NULL,
    path      TEXT NOT NULL,
    width     INTEGER NOT NULL DEFAULT 0,
    UNIQUE (person_id, source)
);

-- Fetch provenance and retry cache. Signed CDN URLs and login cookies are never stored here.
CREATE TABLE IF NOT EXISTS photo_fetches (
    person_id INTEGER NOT NULL REFERENCES people(id),
    url TEXT NOT NULL,
    fetched_at REAL NOT NULL,
    status TEXT NOT NULL,
    detail TEXT NOT NULL,
    PRIMARY KEY (person_id, url)
);

-- Public profiles found by web search. Suggestions until the user confirms them.
CREATE TABLE IF NOT EXISTS profiles (
    id         INTEGER PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES people(id),
    site       TEXT NOT NULL,
    url        TEXT NOT NULL,
    title      TEXT NOT NULL DEFAULT '',
    snippet    TEXT NOT NULL DEFAULT '',
    confidence REAL NOT NULL,
    reason     TEXT NOT NULL DEFAULT '',
    status     TEXT NOT NULL DEFAULT 'suggested',  -- suggested | confirmed | rejected
    found_at   TEXT NOT NULL DEFAULT (datetime('now')),
    assessment TEXT NOT NULL DEFAULT 'possible',
    evidence   TEXT NOT NULL DEFAULT '{}',
    sources    TEXT NOT NULL DEFAULT '[]',
    UNIQUE (person_id, url)
);

-- Public metadata cache, shared across searches; never raw page bodies.
CREATE TABLE IF NOT EXISTS profile_fetches (
    url         TEXT PRIMARY KEY,
    fetched_at  REAL NOT NULL,
    evidence    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS profile_searches (
    person_id   INTEGER PRIMARY KEY REFERENCES people(id),
    searched_at TEXT NOT NULL,
    cost        REAL NOT NULL DEFAULT 0
);

-- Separate from Exa history; retain paid Autumn work across interruptions.
CREATE TABLE IF NOT EXISTS autumn_searches (
    person_id INTEGER PRIMARY KEY REFERENCES people(id),
    task_id   TEXT NOT NULL,
    completed INTEGER NOT NULL DEFAULT 0
);

-- Instagram DM threads whose partner was read from the signed-in session; failed ones are retried.
CREATE TABLE IF NOT EXISTS instagram_thread_checks (
    thread     TEXT PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES people(id),
    checked_at REAL NOT NULL,
    status     TEXT NOT NULL,  -- confirmed | suggested | rejected | unavailable | failed
    detail     TEXT NOT NULL
);

-- Pairs of people the user said are different people despite sharing a name (a < b).
CREATE TABLE IF NOT EXISTS distinct_people (
    a INTEGER NOT NULL REFERENCES people(id),
    b INTEGER NOT NULL REFERENCES people(id),
    PRIMARY KEY (a, b)
);

-- Legacy: per-person extraction watermarks from before interactions.extracted.
CREATE TABLE IF NOT EXISTS extraction_state (
    person_id           INTEGER PRIMARY KEY REFERENCES people(id),
    last_interaction_id INTEGER NOT NULL
);
"""


def default_path() -> Path:
    return Path(os.environ.get("MYPEOPLE_DB", Path.home() / ".mypeople" / "mypeople.db"))


class GraphConnection(sqlite3.Connection):
    """Capture compatibility mutations in the very same SQLite transaction."""

    def commit(self):
        from . import graph_runtime
        if graph_runtime.enabled(self) and self.execute("SELECT 1 FROM graph_dirty LIMIT 1").fetchone():
            graph_runtime.capture(self)
        super().commit()

    def __exit__(self, exc_type, exc_value, traceback):
        if exc_type is None:
            try:
                self.commit()
            except BaseException:
                self.rollback()
                raise
        else:
            self.rollback()
        return False


def _backup_before_graph(conn, path):
    """Owner-only, no-overwrite SQLite snapshot before modifying a legacy DB."""
    if str(path) == ":memory:" or not conn.execute("SELECT 1 FROM sqlite_master WHERE name='people'").fetchone():
        return None
    if conn.execute("SELECT 1 FROM sqlite_master WHERE name='graph_runtime'").fetchone():
        return None
    import datetime
    import uuid
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    target = path.with_name(path.name + '.pre-graph-' + stamp + '-' + uuid.uuid4().hex[:8] + '.sqlite3')
    fd = os.open(target, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    backup = None
    try:
        backup = sqlite3.connect(target)
        conn.backup(backup)
        backup.close()
        return target
    except BaseException:
        if backup is not None: backup.close()
        target.unlink(missing_ok=True)
        raise


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(path) if path else default_path()
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, timeout=60, factory=GraphConnection)  # shared CLI jobs
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA recursive_triggers = ON")
    backup = _backup_before_graph(conn, path)
    if str(path) != ':memory:':
        conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    _migrate(conn)
    from . import graph_runtime
    try:
        graph_runtime.initialize(conn)
        if backup:
            conn.execute("INSERT OR REPLACE INTO graph_meta VALUES ('pre_graph_backup',?)", (str(backup),))
        conn.commit()
    except BaseException:
        conn.rollback()
        conn.close()
        raise
    return conn


def _migrate(conn: sqlite3.Connection) -> None:
    people_columns = {r["name"] for r in conn.execute("PRAGMA table_info(people)")}
    for column, declaration in (("contact_uid", "TEXT NOT NULL DEFAULT ''"), ("contact_data", "TEXT NOT NULL DEFAULT ''"), ("trashed", "INTEGER NOT NULL DEFAULT 0")):
        if column not in people_columns:
            conn.execute(f"ALTER TABLE people ADD COLUMN {column} {declaration}")
    import uuid
    for row in conn.execute("SELECT id FROM people WHERE contact_uid=''").fetchall():
        conn.execute("UPDATE people SET contact_uid=? WHERE id=?", (str(uuid.uuid4()), row["id"]))
    conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS people_contact_uid ON people(contact_uid) WHERE contact_uid <> ''")
    conn.execute("CREATE TABLE IF NOT EXISTS contact_keys (person_id INTEGER NOT NULL REFERENCES people(id), kind TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(person_id, kind, value))")
    conn.execute("CREATE INDEX IF NOT EXISTS contact_keys_lookup ON contact_keys(kind, value)")
    conn.execute("""CREATE TABLE IF NOT EXISTS contact_merge_undo (
        id INTEGER PRIMARY KEY, keep_id INTEGER NOT NULL, person_ids TEXT NOT NULL,
        before_data TEXT NOT NULL, after_data TEXT NOT NULL, undone INTEGER NOT NULL DEFAULT 0)""")
    if "is_me" not in {r["name"] for r in conn.execute("PRAGMA table_info(people)")}:
        conn.execute("ALTER TABLE people ADD COLUMN is_me INTEGER NOT NULL DEFAULT 0")
    columns = {r["name"] for r in conn.execute("PRAGMA table_info(interactions)")}
    if "extracted" not in columns:
        conn.execute("ALTER TABLE interactions ADD COLUMN extracted INTEGER NOT NULL DEFAULT 0")
    profile_columns = {r['name'] for r in conn.execute('PRAGMA table_info(profiles)')}
    for column, default in (("assessment", "possible"), ("evidence", "{}"), ("sources", "[]")):
        if column not in profile_columns:
            conn.execute(f"ALTER TABLE profiles ADD COLUMN {column} TEXT NOT NULL DEFAULT '{default}'")
    if "assessment" not in profile_columns:
        normalize_profiles(conn)
    conn.execute("CREATE INDEX IF NOT EXISTS interactions_pending ON interactions (person_id, extracted)")
    sync_legacy_extraction(conn)
    if "said_at" not in {r["name"] for r in conn.execute("PRAGMA table_info(events)")}:
        conn.execute("ALTER TABLE events ADD COLUMN said_at TEXT")
        backfill_said_at(conn)
    if "generation" not in {r["name"] for r in conn.execute("PRAGMA table_info(events)")}:
        # Odd is present and even is forgotten; see events.reconcile.
        conn.execute("ALTER TABLE events ADD COLUMN generation INTEGER NOT NULL DEFAULT 1")
        conn.execute("UPDATE events SET generation = 2 WHERE status = 'rejected'")
    from .snapchat_links import backfill
    backfill(conn)
    conn.commit()


def normalize_profiles(conn: sqlite3.Connection) -> None:
    """Merge known URL aliases on upgrade, preserving explicit user decisions.

    Confirmed wins over rejected, which wins over an automated suggestion. Record
    old URLs and decisions as provenance instead of silently discarding them.
    """
    from .profile_urls import profile_url

    groups: dict[tuple, list] = {}
    for row in conn.execute("SELECT * FROM profiles ORDER BY id"):
        groups.setdefault((row['person_id'], profile_url(row['url']) or row['url']), []).append(row)
    priority = {"confirmed": 0, "rejected": 1, "suggested": 2}
    for (_, url), rows in groups.items():
        rows.sort(key=lambda r: priority[r['status']])
        keep = rows[0]
        if len(rows) == 1 and keep['url'] == url:
            continue
        sources = json.loads(keep['sources'])
        for row in rows:
            sources.append({"source": "legacy_alias", "url": row['url'], "decision": row['status']})
        for row in rows[1:]:
            conn.execute("DELETE FROM profiles WHERE id = ?", (row['id'],))
        conn.execute("UPDATE profiles SET url = ?, sources = ? WHERE id = ?", (url, json.dumps(sources), keep['id']))


def evidence_time(rows, evidence: str | None) -> str | None:
    """The time of the message an evidence quote came from, among these interaction rows."""
    if not evidence:
        return None
    # Quotes can span lines or carry a speaker label; any distinctive line is enough to find them.
    for line in sorted(evidence.splitlines(), key=len, reverse=True):
        needle = line.split(": ", 1)[-1].strip().strip("“”\"'")[:80].lower()
        if len(needle) < 8:
            continue
        for r in rows:
            if r["text"] and needle in r["text"].lower():
                return r["at"]
    return None


def backfill_said_at(conn: sqlite3.Connection) -> None:
    """Date facts read before said_at existed by finding their quotes in the messages."""
    events = conn.execute(
        "SELECT id, person_id, evidence, created_at FROM events "
        "WHERE said_at IS NULL AND source NOT IN ('vcard', 'manual', 'note')"
    ).fetchall()
    by_person: dict[int, list] = {}
    for e in events:
        by_person.setdefault(e["person_id"], []).append(e)
    for person_id, rows in by_person.items():
        texts = conn.execute(
            "SELECT at, text FROM interactions WHERE person_id = ? AND text IS NOT NULL ORDER BY at DESC", (person_id,)
        ).fetchall()
        for e in rows:
            # '' marks "couldn't tell": treated as old news rather than as just learned.
            conn.execute("UPDATE events SET said_at = ? WHERE id = ?", (evidence_time(texts, e["evidence"]) or "", e["id"]))
    # Notes and manual entries were said when they were added.
    conn.execute("UPDATE events SET said_at = created_at WHERE said_at IS NULL AND source IN ('manual', 'note')")


def sync_legacy_extraction(conn: sqlite3.Connection, person_ids: tuple[int, ...] | None = None) -> None:
    """Turn per-person watermarks (written by older versions) into per-message flags."""
    scope = f" AND person_id IN ({', '.join('?' * len(person_ids))})" if person_ids else ""
    conn.execute(
        "UPDATE interactions SET extracted = 1 WHERE extracted = 0 AND id <= "
        "(SELECT last_interaction_id FROM extraction_state s WHERE s.person_id = interactions.person_id)" + scope,
        person_ids or (),
    )
