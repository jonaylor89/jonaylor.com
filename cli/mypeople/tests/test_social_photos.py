from argparse import Namespace
from pathlib import Path

import pytest

from mypeople import cli, identity, photos, social_photos as sp
from mypeople.public_network import UnsafeURL

IG = "https://instagram.com/alice"
LI = "https://linkedin.com/in/alice"
IG_IMAGE = "https://scontent-iad3-1.cdninstagram.com/v/t51/avatar.jpg?token=secret"
LI_IMAGE = "https://media.licdn.com/dms/image/v2/profile-displayphoto.jpg"
JPEG = b"\xff\xd8\xff\xc0\x00\x11\x08\x00\xdc\x00\xdc" + b"\x00" * 12


def person(conn, name="Alice"):
    return conn.execute("INSERT INTO people (name) VALUES (?) RETURNING id", (name,)).fetchone()[0]


def profile(conn, pid, url, status="confirmed"):
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, status) VALUES (?, ?, ?, 1, ?)",
                 (pid, sp.site(url), url, status))


def test_targets_only_known_platform_accounts(conn):
    pid = person(conn)
    profile(conn, pid, IG)
    profile(conn, pid, "https://instagram.com/suggestion", "suggested")
    profile(conn, pid, "https://linkedin.com/in/rejected", "rejected")
    identity.add_identifier(conn, pid, "linkedin", "rejected", "linkedin")
    identity.add_identifier(conn, pid, "linkedin", "alice", "linkedin")
    identity.add_identifier(conn, pid, "instagram", "Display.Name", "instagram")
    identity.add_identifier(conn, pid, "instagram", "@actual_handle", "manual")
    identity.add_identifier(conn, pid, "snapchat", "crossplatform", "snapchat")
    assert {t["url"] for t in sp.targets(conn, "instagram")} == {IG, "https://instagram.com/actual_handle"}
    assert [t["url"] for t in sp.targets(conn, "linkedin")] == [LI]
    assert sp.targets(conn, "instagram", pid + 1) == []


def test_targets_skip_me_merged_and_rejected_aliases(conn):
    pid = person(conn)
    profile(conn, pid, IG)
    profile(conn, pid, "https://www.instagram.com/Alice/", "rejected")
    assert sp.targets(conn, "instagram") == []
    for field in ("is_me", "merged_into"):
        p = person(conn, field)
        conn.execute(f"UPDATE people SET {field} = ? WHERE id = ?", (pid if field == "merged_into" else 1, p))
        profile(conn, p, "https://instagram.com/" + field)
    assert sp.targets(conn, "instagram") == []


@pytest.mark.parametrize("url", ["http://media.licdn.com/a", "https://media.licdn.com.evil.org/a",
    "https://user@media.licdn.com/a", "https://media.licdn.com:443/a", "https://127.0.0.1/a",
    "https://media.licdn.com/ghost-person", "https://media.licdn.com/default-avatar",
    "https://media.licdn.com/a\nheader"])
def test_cdn_scope(url):
    assert not sp.image_allowed(url, "linkedin")


def test_download_redirects_are_bounded_and_scoped():
    calls = []
    def get(url, timeout, **kw):
        calls.append(url)
        return 302, {"location": "https://localhost/private"}, b""
    with pytest.raises(UnsafeURL):
        sp.download(LI_IMAGE, "linkedin", get=get)
    assert calls == [LI_IMAGE]
    with pytest.raises(ValueError, match="redirects"):
        sp.download(LI_IMAGE, "linkedin", get=lambda *a, **kw: (302, {"location": LI_IMAGE}, b""))


def test_download_rejects_html_unsupported_images_and_oversized_data():
    for headers, body in [({"content-type": "text/html"}, JPEG),
                          ({"content-type": "image/jpeg"}, b"bad image"),
                          ({"content-type": "image/webp"}, b"RIFF"),
                          ({"content-type": "image/jpeg"}, JPEG + b"x" * sp.MAX_IMAGE)]:
        with pytest.raises(ValueError):
            sp.download(LI_IMAGE, "linkedin", get=lambda *a, **kw: (200, headers, body))
    assert sp.download(LI_IMAGE, "linkedin", get=lambda *a, **kw: (200, {"content-type": "image/jpeg"}, JPEG)) == JPEG


def test_request_rejects_private_dns_before_connect(monkeypatch):
    monkeypatch.setattr(sp, "public_address", lambda host: (_ for _ in ()).throw(UnsafeURL("private")))
    with pytest.raises(UnsafeURL):
        sp.request(LI_IMAGE, 1, source="linkedin", image=True)
    with pytest.raises(UnsafeURL):
        sp.request("https://instagram.com/alice/followers", 1, source="instagram")
    with pytest.raises(UnsafeURL):
        sp.request(sp.IG_API + "alice&other=value", 1, source="instagram")


def test_instagram_api_requires_exact_username():
    import json
    def get(url, timeout, **kw):
        assert url == sp.IG_API + "alice"
        return 200, {"content-type": "application/json"}, json.dumps({"data": {"user": {
            "username": "ALICE", "profile_pic_url_hd": IG_IMAGE}}}).encode()
    assert sp.public_image(IG, get=get) == (IG_IMAGE, "public API")
    assert sp.instagram_image({"data": {"user": {"username": "bob", "profile_pic_url_hd": IG_IMAGE}}}, "alice") is None


def html(image=LI_IMAGE, canonical=LI, title="Alice - Engineer | LinkedIn"):
    return f'<title>{title}</title><link rel="canonical" href="{canonical}"><meta property="og:image" content="{image}">'.encode()


def test_public_html_only_uses_requested_account_and_platform_cdn():
    for image, canonical, title, expected in [(LI_IMAGE, LI, "Alice | LinkedIn", LI_IMAGE),
        (LI_IMAGE, "https://linkedin.com/in/bob", "Bob | LinkedIn", None),
        ("https://evil.example/avatar", LI, "Alice | LinkedIn", None),
        (LI_IMAGE, LI, "Sign In | LinkedIn", None)]:
        assert sp.public_image(LI, get=lambda *a, **kw: (200, {"content-type": "text/html"}, html(image, canonical, title)))[0] == expected


def test_public_login_and_cross_account_redirects_not_followed():
    for destination in ("https://linkedin.com/login", "https://linkedin.com/in/bob", "http://linkedin.com/in/alice"):
        calls = []
        def get(url, *a, **kw):
            calls.append(url)
            return 302, {"location": destination}, b""
        assert sp.public_image(LI, get=get)[0] is None
        assert calls == [LI]


def test_public_www_redirect_works():
    def get(url, *a, **kw):
        if url == LI:
            return 302, {"location": "https://www.linkedin.com/in/alice/"}, b""
        return 200, {"content-type": "text/html"}, html()
    assert sp.public_image(LI, get=get)[0] == LI_IMAGE


def test_collect_saves_provenance_and_caches_without_overwriting_other_sources(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(photos, "photo_dir", lambda conn: tmp_path)
    pid = person(conn)
    profile(conn, pid, LI)
    photos.save(conn, pid, "contacts", JPEG)
    selected = sp.targets(conn, "linkedin")
    kwargs = dict(lookup=lambda url: (LI_IMAGE, "public page"), fetch=lambda *a: JPEG, progress=lambda line: None)
    assert sp.collect(conn, selected, **kwargs)["saved"] == 1
    assert conn.execute("SELECT COUNT(*) FROM photos").fetchone()[0] == 2
    row = conn.execute("SELECT * FROM photo_fetches").fetchone()
    assert row["url"] == LI and row["status"] == "ok" and "http" not in row["detail"]
    assert sp.collect(conn, selected, **kwargs)["cached"] == 1
    assert sp.collect(conn, selected, again=True, **kwargs)["unchanged"] == 1
    Path(conn.execute("SELECT path FROM photos WHERE source='linkedin'").fetchone()[0]).unlink()
    assert sp.collect(conn, selected, **kwargs)["cached"] == 0


def test_unavailable_retries_with_browser_and_continues_after_failure(conn, tmp_path, monkeypatch):
    monkeypatch.setattr(photos, "photo_dir", lambda conn: tmp_path)
    pid = person(conn)
    profile(conn, pid, IG)
    profile(conn, pid, LI)
    selected = sp.targets(conn, "instagram")
    kwargs = dict(lookup=lambda url: (None, "blocked"), progress=lambda line: None)
    assert sp.collect(conn, selected, **kwargs)["unavailable"] == 1
    assert sp.collect(conn, selected, **kwargs)["cached"] == 1
    class Browser:
        def image(self, url):
            return IG_IMAGE, "dedicated browser API"
    assert sp.collect(conn, selected, browser=Browser(), fetch=lambda *a: JPEG, **kwargs)["saved"] == 1
    kwargs = dict(lookup=lambda url: (LI_IMAGE, "public page"), fetch=lambda *a: (_ for _ in ()).throw(OSError("offline")),
                  progress=lambda line: None)
    assert sp.collect(conn, sp.targets(conn, "linkedin"), **kwargs)["unavailable"] == 1


def test_cli_dry_run_scopes_person_without_network_or_browser(conn, capsys, monkeypatch):
    pid = person(conn)
    profile(conn, pid, LI)
    profile(conn, person(conn, "Bob"), "https://linkedin.com/in/bob")
    args = Namespace(source="social", path=None, person="Alice", limit=1, login=False,
                     browser=True, dry_run=True, again=False)
    monkeypatch.setattr(sp, "collect", lambda *a, **kw: pytest.fail("dry run collected"))
    cli.cmd_photos(conn, args)
    out = capsys.readouterr().out
    assert LI in out and "Bob" not in out and "1 known accounts; no requests made." in out


@pytest.mark.parametrize("source", ["social", "linkedin", "instagram"])
@pytest.mark.parametrize("dry_run", [True, False])
@pytest.mark.parametrize("limit", [2, 10])
def test_cli_prioritizes_contacts_without_any_photo(conn, tmp_path, monkeypatch, capsys, source, dry_run, limit):
    monkeypatch.setattr(photos, "photo_dir", lambda conn: tmp_path)
    ids = {name: person(conn, name) for name in ("Alice", "Bob", "Carol", "Dave")}
    for name, pid in ids.items():
        # For social, the photo-less Instagram contacts must precede LinkedIn.
        platform = "linkedin" if source == "linkedin" or source == "social" and name == "Alice" else "instagram"
        profile(conn, pid, sp.account_url(platform, name.lower()))
    photos.save(conn, ids["Alice"], "contacts", JPEG)
    photos.save(conn, ids["Carol"], "google", JPEG)
    Path(photos.best(conn, ids["Carol"])["path"]).unlink()

    collected = []
    def collect(conn, selected, **kwargs):
        collected.extend(t["name"] for t in selected)
        return {}
    monkeypatch.setattr(sp, "collect", collect)
    args = Namespace(source=source, path=None, person=None, limit=limit, login=False,
                     browser=False, dry_run=dry_run, again=False, delay=0, max_failures=None)
    cli.cmd_photos(conn, args)
    expected = ["Bob", "Carol", "Dave", "Alice"][:limit]
    if dry_run:
        lines = capsys.readouterr().out.splitlines()
        assert [line.split(" (")[0] for line in lines[:-1]] == expected
        assert collected == []
    else:
        assert collected == expected


def test_schema_upgrade_is_idempotent(tmp_path):
    from mypeople import db
    path = tmp_path / "old.db"
    conn = db.connect(path)
    conn.execute("DROP TABLE photo_fetches")
    conn.close()
    for _ in range(2):
        conn = db.connect(path)
        assert conn.execute("SELECT * FROM photo_fetches").fetchall() == []
        conn.close()


def test_collect_paces_uncached_lookups_and_stops_on_failure_streak(conn, monkeypatch):
    from mypeople import social_photos as sp

    sleeps = []
    monkeypatch.setattr(sp.time, "sleep", sleeps.append)
    selected = [{"person_id": identity.resolve(conn, [], f"P{i}", "manual"), "name": f"P{i}", "source": "instagram",
                 "url": f"https://instagram.com/p{i}"} for i in range(5)]
    stats = sp.collect(conn, selected, lookup=lambda url: (None, "blocked"), progress=lambda _: None,
                       delay=5, max_failures=3)
    assert stats["unavailable"] == 3
    assert len(sleeps) == 2 and all(5 <= s <= 10 for s in sleeps)
