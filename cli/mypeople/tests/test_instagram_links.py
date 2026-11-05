"""DM thread headers become Instagram profiles; nothing else on the page does."""
import json
from argparse import Namespace

import pytest

from mypeople import cli, identity, instagram_links, social_photos, socials
from mypeople.importers.common import add_interaction
from mypeople.photo_browser import BrowserError


class FakeBrowser:
    def __init__(self, headers):
        self.headers, self.opened = headers, []

    def instagram_thread(self, thread):
        self.opened.append(thread)
        found = self.headers.get(thread)
        if isinstance(found, Exception):
            raise found
        return (*found, "thread header") if found else (None, None, "no thread header")


def person(conn, name, display, thread, messages=1):
    pid = identity.resolve(conn, [("instagram", display.lower())], name, "instagram")
    for i in range(messages):
        add_interaction(conn, pid, f"2026-01-0{i + 1} 10:00:00", "instagram", "in", "hi", None,
                        f"instagram:{thread}:{i}:{display}:abc")
    return pid


def run(conn, headers, **kw):
    browser = FakeBrowser(headers)
    return instagram_links.collect(conn, instagram_links.targets(conn, **kw), browser, delay=0, echo=lambda _: None), browser


def profiles(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM profiles ORDER BY person_id, url")]


def test_header_confirms_profile_usable_for_photos(conn):
    pid = person(conn, "Ilias Anwar", "ilias", "111")
    stats, _ = run(conn, {"111": ("iliasanwar_", "ilias")})
    assert stats["confirmed"] == 1
    row = profiles(conn)[0]
    assert (row["url"], row["status"], row["site"]) == ("https://instagram.com/iliasanwar_", "confirmed", "instagram")
    assert json.loads(row["sources"]) == [{"source": "instagram_dm", "thread": "111"}]
    assert [t["url"] for t in social_photos.targets(conn, "instagram", pid)] == ["https://instagram.com/iliasanwar_"]


def test_display_name_mismatch_is_only_a_suggestion(conn):
    person(conn, "Kevin Keziah", "Kevin Keziah", "222")
    stats, _ = run(conn, {"222": ("honeykevin1", "Kev 🏀")})
    assert stats["suggested"] == 1
    assert profiles(conn)[0]["status"] == "suggested"


def test_rejections_win_and_existing_evidence_is_kept(conn):
    a = person(conn, "Alice", "Alice", "1")
    b = person(conn, "Bob", "Bob", "2")
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, status, sources) VALUES (?, 'instagram', ?, .5, 'rejected', '[]')",
                 (a, "https://instagram.com/alice"))
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, title, sources) VALUES (?, 'instagram', ?, .5, 'Bob B', ?)",
                 (b, "https://instagram.com/bob", json.dumps([{"source": "maigret"}])))
    stats, _ = run(conn, {"1": ("alice", "Alice"), "2": ("Bob", "Bob")})
    assert stats == {"confirmed": 1, "suggested": 0, "rejected": 1, "unavailable": 0, "failed": 0}
    alice, bob = profiles(conn)
    assert alice["status"] == "rejected"
    assert bob["status"] == "confirmed" and bob["title"] == "Bob B"
    assert {s["source"] for s in json.loads(bob["sources"])} == {"maigret", "instagram_dm"}


def test_resume_skips_read_threads_and_retries_failures(conn):
    person(conn, "Alice", "Alice", "1", messages=1)
    person(conn, "Bob", "Bob", "2", messages=3)
    _, browser = run(conn, {"1": ("alice", "Alice")})
    assert browser.opened == ["2", "1"]  # busiest first
    _, browser = run(conn, {"2": ("bob", "Bob")})
    assert browser.opened == ["2"]
    _, browser = run(conn, {}, again=True)
    assert browser.opened == ["2", "1"]
    assert {r["status"] for r in profiles(conn)} == {"confirmed"}


def test_group_threads_merged_people_and_bad_handles(conn):
    keep = person(conn, "Alice", "Alice", "1")
    drop = person(conn, "Alice A", "alice a", "2")
    identity.merge(conn, keep, drop)
    add_interaction(conn, keep, "2026-01-01 10:00:00", "instagram", "in", "hi", "group chat", "instagram:3:0:Alice:abc")
    stats, browser = run(conn, {"1": ("alice", "Alice"), "2": ("alice", "alice a")})
    assert sorted(browser.opened) == ["1", "2"]
    assert [(r["person_id"], r["status"]) for r in profiles(conn)] == [(keep, "confirmed")]
    with pytest.raises(ValueError):
        instagram_links.save(conn, instagram_links.targets(conn, again=True)[0], "../evil", "Alice")


def test_signed_out_session_stops_the_run(conn):
    person(conn, "Alice", "Alice", "1")
    with pytest.raises(BrowserError):
        run(conn, {"1": BrowserError("signed out")})
    assert conn.execute("SELECT COUNT(*) FROM instagram_thread_checks").fetchone()[0] == 0


def test_cli_dry_run_makes_no_requests(conn, capsys, monkeypatch):
    person(conn, "Alice", "Alice", "1")
    monkeypatch.setattr(instagram_links, "collect", lambda *a, **kw: pytest.fail("dry run opened threads"))
    cli.cmd_instagram_links(conn, Namespace(person=None, limit=None, dry_run=True, again=False, delay=4))
    assert "1 DM threads to read; no requests made." in capsys.readouterr().out


def test_rejected_profile_stays_out_of_review_after_reread(conn):
    person(conn, "Alice", "Alice", "1")
    run(conn, {"1": ("alice", "Ally")})
    socials.set_status(conn, profiles(conn)[0]["id"], "rejected")
    run(conn, {"1": ("alice", "Alice")}, again=True)
    assert profiles(conn)[0]["status"] == "rejected"


def test_non_instagram_header_is_skipped_not_fatal(conn):
    person(conn, "Alice", "Alice", "1", messages=2)
    person(conn, "Bob", "Bob", "2")
    stats, _ = run(conn, {"1": ("Facebook user", "Facebook user"), "2": ("bob", "Bob")})
    assert (stats["unavailable"], stats["confirmed"]) == (1, 1)
    assert [r["url"] for r in profiles(conn)] == ["https://instagram.com/bob"]
    assert instagram_links.targets(conn) == []  # placeholders are not retried


def test_retries_go_last_and_do_not_trip_the_streak(conn):
    n = instagram_links.MAX_FAILURE_STREAK
    for i in range(n):
        person(conn, f"Old {i}", f"old {i}", f"old{i}", messages=5)
    run(conn, {})  # first pass: all fail
    person(conn, "New", "new", "new")
    stats, browser = run(conn, {"new": ("newbie", "new")})
    assert browser.opened[0] == "new" and len(browser.opened) == n + 1
    assert stats["confirmed"] == 1 and stats["failed"] == n


def test_failure_streak_stops_the_run(conn):
    for i in range(instagram_links.MAX_FAILURE_STREAK + 2):
        person(conn, f"Person {i}", f"person {i}", str(i))
    stats, browser = run(conn, {})
    assert stats["failed"] == len(browser.opened) == instagram_links.MAX_FAILURE_STREAK
    assert len(instagram_links.targets(conn)) == instagram_links.MAX_FAILURE_STREAK + 2  # all retried later
