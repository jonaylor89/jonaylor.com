import hashlib
from pathlib import Path
from types import SimpleNamespace

import pytest

from mypeople import cli, gravatar, identity, photos
from mypeople.public_network import UnsafeURL

JPEG = b"\xff\xd8\xff\xc0\x00\x11\x08\x00\xdc\x00\xdc" + b"\x00" * 12


def person(conn, name="Alice", email="alice@example.com"):
    pid = identity.create_person(conn, name)
    if email:
        identity.add_identifier(conn, pid, "email", email, "test")
    return pid


def args(**kwargs):
    return SimpleNamespace(source="gravatar", path=None, person=None, limit=None, dry_run=False,
                           again=False, browser=False, login=False, **kwargs)


def test_url_uses_documented_sha256_normalization_and_no_defaults():
    url = gravatar.avatar_url(" MyEmailAddress@example.com ")
    assert url == ("https://gravatar.com/avatar/84059b07d4be67b806386c0aad8070a23f18836bbaae342275dc0a83414c32ee"
                   "?s=512&d=404&r=g")
    assert gravatar.avatar_url("Alice+work@Example.com") != gravatar.avatar_url("alice@example.com")
    assert gravatar.avatar_url("alice.last@example.com") != gravatar.avatar_url("alicelast@example.com")


@pytest.mark.parametrize("email", ["", " ", "alice", "alice@", "@example.com", "a@@example.com",
                                    "Alice <a@example.com>", "a b@example.com", "a\x00@example.com"])
def test_malformed_email_skipped(email):
    assert gravatar.avatar_url(email) is None


def test_targets_known_emails_only_normalized_and_deduplicated(conn):
    pid = person(conn)
    identity.add_identifier(conn, pid, "email", " ALICE@EXAMPLE.COM ", "test")
    identity.add_identifier(conn, pid, "email", "alice+work@example.com", "test")
    identity.add_identifier(conn, pid, "email", "bad address", "test")
    identity.add_identifier(conn, pid, "instagram", "alice_handle", "manual")
    identity.add_identifier(conn, pid, "phone", "5551234567", "test")
    other = person(conn, "Bob", "bob@example.com")
    me = person(conn, "Me", "me@example.com")
    conn.execute("UPDATE people SET is_me=1 WHERE id=?", (me,))
    merged = person(conn, "Merged", "merged@example.com")
    conn.execute("UPDATE people SET merged_into=? WHERE id=?", (pid, merged))
    assert len(gravatar.targets(conn)) == 3
    selected = gravatar.targets(conn, pid)
    assert len(selected) == 2
    assert all(t["person_id"] == pid and t["source"] == "gravatar" for t in selected)
    assert all("@" not in t["url"] and "email" not in t for t in selected)
    assert len(gravatar.targets(conn, other)) == 1


def test_download_real_image_and_scoped_host_redirect():
    url = gravatar.avatar_url("alice@example.com")
    calls = []
    def get(url, timeout):
        calls.append(url)
        if len(calls) == 1:
            return 302, {"location": url.replace("gravatar.com", "www.gravatar.com")}, b""
        return 200, {"content-type": "image/jpeg"}, JPEG
    assert gravatar.download(url, get=get) == JPEG
    assert len(calls) == 2 and all("d=404" in u for u in calls)


@pytest.mark.parametrize("destination", [
    "https://localhost/image", "https://gravatar.com.evil.example/avatar/x", "http://gravatar.com/avatar/x",
    "https://gravatar.com/avatar/" + "0" * 64 + "?s=512&d=404&r=g",
    "https://gravatar.com/avatar/" + hashlib.sha256(b"alice@example.com").hexdigest() + "?s=512&d=mp&r=g",
])
def test_download_rejects_external_changed_identity_or_default_redirects(destination):
    calls = []
    def get(url, timeout):
        calls.append(url)
        return 302, {"location": destination}, b""
    with pytest.raises(UnsafeURL):
        gravatar.download(gravatar.avatar_url("alice@example.com"), get=get)
    assert len(calls) == 1


def test_missing_and_invalid_images_never_saved():
    url = gravatar.avatar_url("alice@example.com")
    for status, content_type, body in [(404, "image/jpeg", JPEG), (429, "text/plain", b"rate limited"),
                                      (200, "text/html", JPEG), (200, "image/png", b"invalid"),
                                      (200, "image/gif", b"GIF89a"),
                                      (200, "image/jpeg", JPEG + b"x" * gravatar.MAX_BYTES)]:
        with pytest.raises(ValueError):
            gravatar.download(url, get=lambda *a: (status, {"content-type": content_type}, body))
    with pytest.raises(ValueError, match="redirects"):
        gravatar.download(url, get=lambda *a: (302, {"location": url}, b""))


def test_request_rejects_arbitrary_urls_and_private_dns(monkeypatch):
    url = gravatar.avatar_url("alice@example.com")
    for invalid in (url.replace("https:", "http:"), url + "&d=mp", url + "#fragment",
                    url.replace("gravatar.com", "user@gravatar.com"),
                    url.replace("gravatar.com", "gravatar.com:443"),
                    url.replace("gravatar.com", "127.0.0.1")):
        with pytest.raises(UnsafeURL):
            gravatar.request(invalid, 1)
    monkeypatch.setattr(gravatar, "public_address", lambda host: (_ for _ in ()).throw(UnsafeURL("private")))
    with pytest.raises(UnsafeURL):
        gravatar.request(url, 1)


def test_transport_has_no_cookies_or_auth_and_closes_connection(monkeypatch):
    calls = []
    class Connection:
        def __init__(self, host, address, timeout):
            assert host == "gravatar.com" and address == "8.8.8.8"
        def request(self, method, target, headers):
            calls.append((method, target, headers))
        def getresponse(self):
            return SimpleNamespace(status=200, getheaders=lambda: [("Content-Type", "image/jpeg")], read=lambda n: JPEG)
        def close(self):
            calls.append("closed")
    monkeypatch.setattr(gravatar, "public_address", lambda host: "8.8.8.8")
    monkeypatch.setattr(gravatar.profile_evidence, "_PinnedHTTPS", Connection)
    assert gravatar.request(gravatar.avatar_url("alice@example.com"), 1)[2] == JPEG
    method, target, headers = calls[0]
    assert "alice" not in target and "@" not in target and "d=404" in target
    assert not {"authorization", "cookie"} & {h.lower() for h in headers}
    assert calls[-1] == "closed"


def test_collect_saves_separate_source_caches_and_restores_missing_file(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(photos, "photo_dir", lambda conn: tmp_path)
    pid = person(conn)
    photos.save(conn, pid, "linkedin", JPEG)
    calls = []
    def fetch(url):
        calls.append(url)
        return JPEG
    kwargs = dict(fetch=fetch, progress=lambda line: None)
    selected = gravatar.targets(conn)
    assert gravatar.collect(conn, selected, **kwargs)["saved"] == 1
    assert gravatar.collect(conn, selected, **kwargs)["cached"] == 1
    assert len(calls) == 1
    assert gravatar.collect(conn, selected, again=True, **kwargs)["unchanged"] == 1
    photo = conn.execute("SELECT * FROM photos WHERE source='gravatar'").fetchone()
    Path(photo["path"]).unlink()
    assert gravatar.collect(conn, selected, **kwargs)["saved"] == 1
    assert Path(photo["path"]).read_bytes() == JPEG
    assert conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0] == 2
    record = conn.execute("SELECT * FROM photo_fetches").fetchone()
    assert "@" not in record["url"] and record["status"] == "ok"
    assert conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 0


def test_missing_avatar_cached_without_stopping_batch(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(photos, "photo_dir", lambda conn: tmp_path)
    person(conn)
    person(conn, "Bob", "bob@example.com")
    calls = []
    def fetch(url):
        calls.append(url)
        if url == gravatar.avatar_url("alice@example.com"):
            raise ValueError("No Gravatar avatar (HTTP 404)")
        return JPEG
    selected = gravatar.targets(conn)
    kwargs = dict(fetch=fetch, progress=lambda line: None)
    stats = gravatar.collect(conn, selected, **kwargs)
    assert stats == {"emails": 2, "saved": 1, "unchanged": 0, "cached": 0, "unavailable": 1}
    assert gravatar.collect(conn, selected, **kwargs)["cached"] == 2 and len(calls) == 2
    conn.execute("UPDATE photo_fetches SET fetched_at=0")
    assert gravatar.collect(conn, selected, **kwargs)["cached"] == 0


def test_cli_dry_run_scopes_person_limit_and_sends_nothing(conn, capsys, monkeypatch):
    pid = person(conn)
    identity.add_identifier(conn, pid, "email", "other@example.com", "test")
    person(conn, "Bob", "bob@example.com")
    a = args()
    a.person, a.limit, a.dry_run = "Alice", 1, True
    monkeypatch.setattr(gravatar, "collect", lambda *a, **kw: pytest.fail("dry run fetched"))
    cli.cmd_photos(conn, a)
    out = capsys.readouterr().out
    assert "Alice (gravatar)" in out and "Bob" not in out and "@" not in out
    assert "1 email addresses; no requests made." in out
    assert conn.execute("SELECT COUNT(*) FROM photo_fetches").fetchone()[0] == 0


def test_cli_dispatch_needs_no_browser(conn, monkeypatch):
    pid = person(conn)
    calls = []
    def collect(conn, selected, **kwargs):
        calls.append((selected, kwargs))
        return {"emails": 1, "saved": 0}
    monkeypatch.setattr(gravatar, "collect", collect)
    from mypeople.photo_browser import PhotoBrowser
    monkeypatch.setattr(PhotoBrowser, "__enter__", lambda self: pytest.fail("browser started"))
    cli.cmd_photos(conn, args())
    assert calls[0][0][0]["person_id"] == pid and calls[0][1] == {"again": False}
    assert cli.build_parser().parse_args(["photos", "--source", "gravatar"]).source == "gravatar"


@pytest.mark.parametrize("flag", ["browser", "login", "path"])
def test_gravatar_rejects_browser_login_and_data_folder(conn, flag):
    a = args()
    setattr(a, flag, True if flag != "path" else "/tmp")
    with pytest.raises(SystemExit):
        cli.cmd_photos(conn, a)


def test_default_all_is_still_opt_out(conn, monkeypatch):
    from mypeople import google
    parsed = cli.build_parser().parse_args(["photos"])
    assert parsed.source == "all"
    calls = []
    for name in ("whatsapp", "contacts", "google"):
        def collect(*a, source=name):
            calls.append(source)
            return {"photos": 0, "matched": 0, "saved": 0}
        monkeypatch.setattr(photos, "collect_" + name, collect)
    monkeypatch.setattr(google, "fetch_contacts", lambda *a: [])
    monkeypatch.setattr(gravatar, "collect", lambda *a, **kw: pytest.fail("default queried Gravatar"))
    cli.cmd_photos(conn, parsed)
    assert calls == ["whatsapp", "contacts", "google"]
