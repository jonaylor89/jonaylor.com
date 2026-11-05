import datetime as dt
from html import escape

import pytest

from mypeople import identity
from mypeople.importers.instagram import import_instagram


def export(tmp_path):
    info = tmp_path / "personal_information/personal_information"
    info.mkdir(parents=True)
    (info / "personal_information.html").write_text(
        '<table><tr><td>Name<div><div>Me Myself</div></div></td></tr></table>'
    )
    return tmp_path


def message(sender, text, date="Oct 20, 2026 3:15 pm"):
    return (
        '<div class="pam _a6-g"><h2>' + escape(sender) + '</h2>'
        '<div class="_a6-p"><div><div></div><div>' + text + '</div>'
        '<div><ul><li>❤️Someone (reaction date)</li></ul></div></div></div>'
        '<div class="_a6-o">' + date + '</div></div>'
    )


def thread(root, folder, title, content, page=1):
    path = root / "your_instagram_activity/messages/inbox" / folder
    path.mkdir(parents=True, exist_ok=True)
    (path / f"message_{page}.html").write_text('<h1>' + title + '</h1>' + content)


def test_html_import(conn, tmp_path):
    root = export(tmp_path)
    me = identity.resolve(conn, [("email", "me@example.com")], "Me Myself", "test")
    identity.set_me(conn, [me])
    thread(root, "marcus_111", "Marcus Lee",
           message("Marcus Lee", "café &amp; tea 😂<br>tomorrow?") + message("Me Myself", "yes!"))
    # Identical messages within one HTML minute must not disappear.
    thread(root, "marcus_111", "Marcus Lee", message("Me Myself", "yes!"), page=2)
    thread(root, "lurker_222", "Lurker Person", message("Lurker Person", "hi"))
    thread(root, "deleted_333", "Instagram User", message("Instagram User", "hi"))
    thread(root, "crew_444", "The Crew",
           '<div class="_a6-g"><h2>Participants: Marcus Lee and Me Myself</h2></div>'
           '<div class="_a6-g"><h2>Group Invite Link: On</h2><div class="_a6-p">link</div></div>'
           + message("Marcus Lee", "group hello") + message("Me Myself", "hello all"))
    stats = import_instagram(conn, root)
    assert stats["interactions"] == 4
    rows = conn.execute("SELECT direction, text, thread, at FROM interactions ORDER BY id").fetchall()
    assert {(r["direction"], r["text"], r["thread"]) for r in rows} == {
        ("in", "café & tea 😂\ntomorrow?", None), ("out", "yes!", None),
        ("in", "group hello", "group chat"),
    }
    expected = dt.datetime(2026, 10, 20, 15, 15, tzinfo=dt.timezone.utc).astimezone().replace(tzinfo=None)
    assert all(r["at"] == expected.isoformat(sep=" ", timespec="seconds") for r in rows)
    assert identity.find_by_identifier(conn, "instagram", "me myself") == me
    assert identity.find_by_identifier(conn, "instagram", "lurker person") is None
    assert import_instagram(conn, root)["interactions"] == 0


def test_html_since_and_outbound_only(conn, tmp_path):
    root = export(tmp_path)
    thread(root, "marcus_111", "Marcus Lee", message("Me Myself", "old", "Oct 19, 2026 3:15 pm")
           + message("Me Myself", "new", "Oct 22, 2026 3:15 pm"))
    assert import_instagram(conn, root, since=dt.date(2026, 10, 21))["interactions"] == 1
    assert conn.execute("SELECT text FROM interactions").fetchone()[0] == "new"


def test_missing_owner_does_not_write(conn, tmp_path):
    with pytest.raises(ValueError, match="no account name"):
        import_instagram(conn, tmp_path)
    assert conn.execute("SELECT count(*) FROM identifiers").fetchone()[0] == 0


def test_bad_html_fails_before_any_writes(conn, tmp_path):
    root = export(tmp_path)
    thread(root, "marcus_111", "Marcus Lee", '<div class="_a6-g"><h2>Marcus Lee</h2></div>')
    with pytest.raises(ValueError, match="Unrecognized"):
        import_instagram(conn, root)
    assert conn.execute("SELECT count(*) FROM interactions").fetchone()[0] == 0
