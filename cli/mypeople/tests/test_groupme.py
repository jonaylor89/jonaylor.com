import datetime as dt
import json
from pathlib import Path

import pytest

from mypeople import cli, identity
from mypeople.importers.groupme import GroupMeError, import_groupme


STAMP = 1790856000


def message(mid, sender="1", recipient="2", **extra):
    return {"id": str(mid), "sender_id": sender, "user_id": sender, "recipient_id": recipient,
            "sender_type": "user", "created_at": STAMP, "text": " Hello 🎉 ", **extra}


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")


def export(root, messages=(), uid="2", name="Ada Lovelace", folder="z-direct"):
    write_json(root / "profile/profile.json", {"id": "1", "name": "Me"})
    write_json(root / folder / "conversation.json", {"chat": {"other_user": {"id": uid, "name": name}}})
    write_json(root / folder / "message.json", list(messages))
    return root


def group(root, messages, folder="a-group"):
    write_json(root / folder / "conversation.json", {"id": "50", "group_id": "50", "name": "Friends",
               "members": [{"user_id": "3", "nickname": "Unknown Person"}]})
    write_json(root / folder / "message.json", messages)


def test_direct_media_groups_self_and_reimport(conn, tmp_path):
    me = identity.create_person(conn, "Me")
    identity.set_me(conn, [me])
    root = export(tmp_path, [message(1), message(2, "2", "1"),
                             message(3, "2", "1", text=None, attachments=[{"type": "image"}])])
    group(root, [message(1, "2"), message(2), message(3, "3"),
                 message(4, "2", system=True), message(5, "2", sender_type="bot"),
                 message(6, "2", hidden=True)])
    stats = import_groupme(conn, root)
    assert stats["interactions"] == 4
    assert stats["people"] == 1
    assert identity.find_by_identifier(conn, "groupme", "1") == me
    assert identity.find_by_identifier(conn, "groupme", "3") is None
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 2
    rows = conn.execute("SELECT * FROM interactions ORDER BY id").fetchall()
    assert [r["direction"] for r in rows] == ["in", "out", "in", "in"]
    assert rows[0]["thread"] == "group chat"
    assert rows[1]["text"] == "Hello 🎉"
    assert rows[-1]["text"] is None
    assert rows[1]["at"] == dt.datetime.fromtimestamp(STAMP).isoformat(sep=" ")
    assert import_groupme(conn, root)["interactions"] == 0
    # Folder names and display names do not define message identity.
    (root / "z-direct").rename(root / "renamed")
    assert import_groupme(conn, root)["interactions"] == 0


def test_no_name_matching_or_people_from_incoming_groups_and_system_messages(conn, tmp_path):
    existing = identity.create_person(conn, "Ada Lovelace")
    export(tmp_path, [message(1, "2", "1")])
    group(tmp_path, [message(1, "3"), message(2)])
    assert import_groupme(conn, tmp_path)["interactions"] == 0
    assert identity.find_by_identifier(conn, "groupme", "2") is None
    export(tmp_path, [message(1, "2", "1"), message(2, system=True), message(3, hidden=True)])
    assert import_groupme(conn, tmp_path)["interactions"] == 0
    export(tmp_path, [message(1, "2", "1"), message(4)])
    assert import_groupme(conn, tmp_path)["interactions"] == 2
    assert identity.find_by_identifier(conn, "groupme", "2") != existing


def test_merge_is_followed_without_renaming_contact(conn, tmp_path):
    original = identity.create_person(conn, "User Maintained Name")
    export(tmp_path, [message(1)])
    import_groupme(conn, tmp_path)
    imported = identity.find_by_identifier(conn, "groupme", "2")
    identity.merge(conn, original, imported)
    export(tmp_path, [message(1), message(2, "2", "1")], name="Old Nickname")
    assert import_groupme(conn, tmp_path)["interactions"] == 1
    assert identity.find_by_identifier(conn, "groupme", "2") == original
    assert conn.execute("SELECT name FROM people WHERE id=?", (original,)).fetchone()[0] == "User Maintained Name"
    assert conn.execute("SELECT COUNT(*) FROM interactions WHERE person_id=?", (original,)).fetchone()[0] == 2


def test_since_uses_full_history_for_relationship_and_skips_invalid_messages(conn, tmp_path):
    export(tmp_path, [message(1), message(2, "2", "1", created_at=STAMP + 86400),
                      message(3, "2", "1", created_at="bad"), message(4, "2", "1", created_at=True),
                      message(5, "2", "1", created_at=1e100), message(6, "2", "1", id=""),
                      message(7, "99", "1"), message(8, "1", "99")])
    cutoff = dt.datetime.fromtimestamp(STAMP + 86400).date()
    stats = import_groupme(conn, tmp_path, cutoff)
    assert stats["interactions"] == 1
    assert identity.find_by_identifier(conn, "groupme", "2")


@pytest.mark.parametrize("flag", ["is_me", "trashed"])
def test_no_import_into_self_or_trashed_person(conn, tmp_path, flag):
    person = identity.create_person(conn, "Ada")
    identity.add_identifier(conn, person, "groupme", "2", "groupme")
    conn.execute(f"UPDATE people SET {flag}=1 WHERE id=?", (person,))
    export(tmp_path, [message(1), message(2, "2", "1")])
    assert import_groupme(conn, tmp_path)["interactions"] == 0
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 1


def test_existing_id_links_incoming_only_and_group_only(conn, tmp_path):
    person = identity.create_person(conn, "Ada")
    identity.add_identifier(conn, person, "groupme", "2", "groupme")
    export(tmp_path, [message(1, "2", "1")])
    group(tmp_path, [message(1, "2")])
    assert import_groupme(conn, tmp_path)["interactions"] == 2


@pytest.mark.parametrize("broken", [None, [], {"id": "bad"}, {"id": True}])
def test_invalid_profile(conn, tmp_path, broken):
    write_json(tmp_path / "profile/profile.json", broken)
    with pytest.raises(GroupMeError):
        import_groupme(conn, tmp_path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 0


@pytest.mark.parametrize("broken", ["missing", "invalid-json", "not-list", "invalid-entry", "bad-conversation"])
def test_invalid_conversation_fails_before_any_writes(conn, tmp_path, broken):
    export(tmp_path, [message(1)], folder="a-valid")
    export(tmp_path, [message(2)], uid="3", folder="z-invalid")
    path = tmp_path / "z-invalid/message.json"
    if broken == "missing":
        path.unlink()
    elif broken == "invalid-json":
        path.write_text("{")
    elif broken == "not-list":
        write_json(path, {})
    elif broken == "invalid-entry":
        write_json(path, [None])
    else:
        write_json(path.with_name("conversation.json"), {"chat": None})
    with pytest.raises(GroupMeError):
        import_groupme(conn, tmp_path)
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM interactions").fetchone()[0] == 0


def test_cli(conn, tmp_path):
    args = cli.build_parser().parse_args(["import", "groupme", str(export(tmp_path, [message(1)])), "--since", "2020-01-01"])
    args.func(conn, args)
    assert conn.execute("SELECT COUNT(*) FROM interactions").fetchone()[0] == 1
    args.path = None
    with pytest.raises(SystemExit, match="unzipped GroupMe"):
        args.func(conn, args)
    args.path = str(tmp_path / "missing")
    with pytest.raises(SystemExit, match="Couldn't read GroupMe"):
        args.func(conn, args)


PHOTO = b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + (128).to_bytes(4, "big") + b"\x00" * 12


def avatars(root, direct="https://i.groupme.com/direct", members=()):
    path = root / "z-direct/conversation.json"
    data = json.loads(path.read_text())
    data["chat"]["other_user"]["avatar_url"] = direct
    write_json(path, data)
    group(root, [])
    path = root / "a-group/conversation.json"
    data = json.loads(path.read_text())
    data["members"] = list(members)
    write_json(path, data)


def test_photo_backfill_preserves_extraction_facts_and_other_source_photos(conn, tmp_path, monkeypatch):
    from mypeople import events, photos

    monkeypatch.setattr(photos, "photo_dir", lambda c: tmp_path / "saved-photos")
    export(tmp_path, [message(1), message(2, "2", "1")])
    import_groupme(conn, tmp_path)
    person = identity.find_by_identifier(conn, "groupme", "2")
    keeper = identity.create_person(conn, "My Existing Contact")
    identity.merge(conn, keeper, person)
    conn.execute("UPDATE interactions SET extracted=1 WHERE person_id=?", (keeper,))
    conn.execute("INSERT INTO extraction_state VALUES (?, 2)", (keeper,))
    events.remember(conn, keeper, "job", "Engineer", "2026-10-01")
    photos.save(conn, keeper, "contacts", PHOTO)
    conn.commit()
    before = {table: [tuple(r) for r in conn.execute(f"SELECT * FROM {table}")]
              for table in ("interactions", "events", "extraction_state", "people")}
    avatars(tmp_path, members=[{"user_id": "2", "image_url": "https://i.groupme.com/group"},
                               {"user_id": "3", "image_url": "https://i.groupme.com/unknown"}])
    fetched = []

    def fetch(url):
        fetched.append(url)
        return PHOTO

    # Downloads are opt-in, even when metadata includes photo URLs.
    import_groupme(conn, tmp_path, fetch=fetch)
    assert fetched == []
    stats = import_groupme(conn, tmp_path, with_photos=True, fetch=fetch)
    assert stats["interactions"] == 0
    assert stats["photos_saved"] == 1 and stats["photos_failed"] == 0
    assert fetched == ["https://i.groupme.com/direct"]
    rows = conn.execute("SELECT * FROM photos WHERE person_id=? ORDER BY source", (keeper,)).fetchall()
    assert [r["source"] for r in rows] == ["contacts", "groupme"]
    assert all(Path(r["path"]).read_bytes() == PHOTO for r in rows)
    for table, snapshot in before.items():
        assert [tuple(r) for r in conn.execute(f"SELECT * FROM {table}")] == snapshot
    assert import_groupme(conn, tmp_path, with_photos=True, fetch=fetch)["photos_saved"] == 0


def test_photo_failures_retry_and_fall_back_to_member_avatar(conn, tmp_path, monkeypatch):
    from mypeople import photos

    monkeypatch.setattr(photos, "photo_dir", lambda c: tmp_path / "saved-photos")
    export(tmp_path, [message(1)])
    avatars(tmp_path, members=[{"user_id": "2", "image_url": "https://i.groupme.com/member"}])
    fetched = []

    def failing(url):
        fetched.append(url)
        raise OSError("expired")

    stats = import_groupme(conn, tmp_path, with_photos=True, fetch=failing)
    assert stats["interactions"] == 1 and stats["photos_failed"] == 1
    assert len(fetched) == 2

    def fallback(url):
        return PHOTO if url.endswith("/member") else b"not an image"

    stats = import_groupme(conn, tmp_path, with_photos=True, fetch=fallback)
    assert stats["interactions"] == 0 and stats["photos_saved"] == 1


@pytest.mark.parametrize("url", ["file:///etc/passwd", "http://i.groupme.com/a", "https://localhost/a",
                                 "https://i.groupme.com.evil.test/a", "https://i.groupme.com:123/a",
                                 "https://user:pass@i.groupme.com/a", "https://[bad"])
def test_photo_urls_are_restricted(conn, tmp_path, url):
    export(tmp_path, [message(1)])
    avatars(tmp_path, direct=url)

    def unexpected(url):
        pytest.fail("untrusted URL must not be fetched")

    assert import_groupme(conn, tmp_path, with_photos=True, fetch=unexpected)["photos_saved"] == 0


def test_groupme_photo_cli_and_app_job(conn, tmp_path, monkeypatch):
    from mypeople import appjobs
    from mypeople.importers import groupme

    export(tmp_path, [message(1)])
    calls = []
    monkeypatch.setattr(groupme, "_collect_photos", lambda c, root, account, fetch: calls.append(account) or {"photos_saved": 0})
    argv = appjobs.build_argv("import", {"source": "groupme", "path": str(tmp_path), "photos": True},
                              db_path=tmp_path / "test.db")
    assert "--photos" in argv
    args = cli.build_parser().parse_args(["import", "groupme", str(tmp_path), "--photos"])
    args.func(conn, args)
    assert calls == ["1"]


@pytest.mark.parametrize("flag", ["is_me", "trashed"])
def test_photo_downloads_skip_self_and_trashed(conn, tmp_path, flag):
    export(tmp_path, [message(1)])
    import_groupme(conn, tmp_path)
    person = identity.find_by_identifier(conn, "groupme", "2")
    conn.execute(f"UPDATE people SET {flag}=1 WHERE id=?", (person,))
    avatars(tmp_path)

    def unexpected(url):
        pytest.fail("must not fetch photos for self or trashed contacts")

    assert import_groupme(conn, tmp_path, with_photos=True, fetch=unexpected)["photos_saved"] == 0


def test_photo_downloader_limits_size_and_blocks_redirects(monkeypatch):
    from mypeople.importers import groupme

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def read(self, size):
            assert size == groupme._MAX_PHOTO_BYTES + 1
            return b"x" * size

    class Opener:
        def open(self, url, timeout):
            assert url == "https://i.groupme.com/photo" and timeout == 15
            return Response()

    monkeypatch.setattr(groupme.urllib.request, "build_opener", lambda handler: Opener())
    with pytest.raises(ValueError, match="size limit"):
        groupme._fetch_photo("https://i.groupme.com/photo")
    with pytest.raises(ValueError, match="Unsupported"):
        groupme._fetch_photo("file:///etc/passwd")
    assert groupme._NoRedirect().redirect_request(None, None, 302, "", {}, "http://localhost") is None
