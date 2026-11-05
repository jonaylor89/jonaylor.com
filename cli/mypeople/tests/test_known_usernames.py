"""Known account identifiers are reusable seeds, not confirmed new identities."""

import json

import pytest

from mypeople import cli, identity, llm, osint, profile_evidence, socials


def profile(conn, pid, url, status="confirmed"):
    conn.execute("INSERT INTO profiles (person_id,site,url,confidence,reason,status) VALUES (?, ?, ?, 1, ?, ?)",
                 (pid, socials.site(url), url, "test", status))


def test_known_username_set_combines_real_account_identifiers_and_profiles(conn):
    pid = identity.create_person(conn, "Chris Wren")
    identity.add_identifier(conn, pid, "snapchat", "cwren", "snapchat")
    identity.add_identifier(conn, pid, "linkedin", "chris-wren", "linkedin")
    identity.add_identifier(conn, pid, "instagram", "chris", "instagram")  # A DM display name, NOT a username.
    identity.add_identifier(conn, pid, "email", "private@example.com", "manual")
    identity.add_identifier(conn, pid, "phone", "15551234567", "manual")
    identity.add_identifier(conn, pid, "google", "people/c12345", "google")
    profile(conn, pid, "https://github.com/cwren")
    profile(conn, pid, "https://linkedin.com/in/chris-wren")
    profile(conn, pid, "https://instagram.com/unreviewed", status="suggested")
    before = conn.total_changes
    known = osint.known_usernames(conn, pid)
    assert set(known) == {"cwren", "chris-wren"}
    assert {o["type"] for o in known["cwren"]} == {"confirmed_profile", "contact_identifier"}
    assert len(known["chris-wren"]) == 2
    assert set(osint.handles_for(conn, pid)) == set(known)
    assert conn.total_changes == before


@pytest.mark.parametrize("value", ["Chris", "chris.wren", "actual-looking-username", "Chris Wren"])
def test_instagram_dm_display_names_never_become_scanner_seeds(conn, value):
    pid = identity.create_person(conn, "Chris Wren")
    identity.add_identifier(conn, pid, "instagram", value, "instagram")
    identity.add_alias(conn, pid, "cwren")
    assert not osint.handles_for(conn, pid)
    assert not osint.candidates(conn, pid, runner=lambda *a: pytest.fail("no actual username"))


@pytest.mark.parametrize("kind,value,source", [
    ("linkedin", "chris@example.com", "linkedin"), ("linkedin", "https://example.com/in/chris", "linkedin"),
    ("linkedin", "+15551234567", "linkedin"), ("linkedin", "15551234567", "linkedin"),
    ("linkedin", "Chris Wren", "linkedin"), ("linkedin", "cwren", "unrecognized"),
    ("snapchat", "01234567-abcd-abcd-abcd-0123456789ab", "snapchat"),
    ("snapchat", "friend@example.com", "snapchat"), ("snapchat", "1234567890", "snapchat"),
])
def test_identifier_provenance_and_shapes_are_validated(conn, kind, value, source):
    pid = identity.create_person(conn, "Chris Wren")
    identity.add_identifier(conn, pid, kind, value, source)
    assert not osint.handles_for(conn, pid)


@pytest.mark.parametrize("kind,value", [("snapchat", "cwren"), ("linkedin", "chris-wren")])
def test_manual_account_identifiers_are_known_without_a_profile_row(conn, kind, value):
    pid = identity.create_person(conn, "Chris Wren")
    identity.add_identifier(conn, pid, kind, value, "manual")
    assert osint.handles_for(conn, pid) == [value]


@pytest.mark.parametrize("url,expected", [
    ("https://linkedin.com/in/chris-wren", ["chris-wren", "chriswren"]),
    ("https://linkedin.com/in/chris-wren-a012345", ["chris-wren-a012345", "chriswrena012345"]),
    ("https://instagram.com/chris.wren", ["chris.wren", "chriswren"]),
    ("https://github.com/cwren", ["cwren"]),
    ("https://bsky.app/profile/cwren.bsky.social", ["cwren.bsky.social", "cwren"]),
    ("https://bsky.app/profile/chris.example.com", ["chris.example.com"]),
    ("https://bsky.app/profile/example.com", ["example.com"]),
    ("https://bsky.app/profile/" + ".".join(["a" * 60] * 4) + ".com", [".".join(["a" * 60] * 4) + ".com"]),
    ("https://youtube.com/channel/UCabcdefghijklmnopqrstuv", []),
    ("https://instagram.com/1234567890", ["1234567890"]),
    ("https://github.com/a-b", ["a-b"]),
])
def test_variants_are_bounded_and_namespace_aware(conn, url, expected):
    pid = identity.create_person(conn, "Unrelated Contact Name")
    profile(conn, pid, url)
    assert list(osint._scan_seeds(conn, pid)) == expected
    # A variant is not quietly persisted or presented as an exact known username.
    assert len(osint.handles_for(conn, pid)) == (1 if expected else 0)


def test_variants_dedupe_against_exact_known_handles_and_keep_provenance(conn):
    pid = identity.create_person(conn, "Chris Wren")
    profile(conn, pid, "https://linkedin.com/in/chris-wren")
    profile(conn, pid, "https://github.com/chriswren")
    seeds = osint._scan_seeds(conn, pid)
    assert list(seeds) == ["chris-wren", "chriswren"]
    assert {(o["known_username"], o["transformation"]) for o in seeds["chriswren"]} == {
        ("chris-wren", "separatorless"), ("chriswren", "exact")}


@pytest.mark.parametrize("value,source", [("chris-wren", "linkedin"), ("@Chris-Wren", "manual")])
def test_imported_identifier_cannot_bypass_rejected_profile(conn, value, source):
    pid = identity.create_person(conn, "Chris Wren")
    identity.add_identifier(conn, pid, "linkedin", value, source)
    profile(conn, pid, "https://www.linkedin.com/in/Chris-Wren", status="rejected")
    assert not osint.handles_for(conn, pid)
    assert not osint.candidates(conn, pid, runner=lambda *a: pytest.fail("must respect rejection"))


def test_rejecting_a_namesake_on_another_platform_does_not_erase_known_account(conn):
    pid = identity.create_person(conn, "Chris Wren")
    identity.add_identifier(conn, pid, "snapchat", "cwren", "snapchat")
    profile(conn, pid, "https://github.com/cwren", status="rejected")
    assert osint.handles_for(conn, pid) == ["cwren"]


def test_known_usernames_follow_contact_merges(conn):
    target = identity.create_person(conn, "Chris Wren")
    old = identity.create_person(conn, "Chris")
    identity.add_identifier(conn, old, "snapchat", "cwren", "snapchat")
    identity.merge(conn, target, old)
    assert osint.handles_for(conn, old) == osint.handles_for(conn, target) == ["cwren"]


def test_cli_uses_imported_known_username_and_variant_without_username_flag_or_exa(conn, monkeypatch, capsys):
    pid = identity.create_person(conn, "Chris Wren")
    identity.add_identifier(conn, pid, "linkedin", "chris-wren", "linkedin")
    identity.add_identifier(conn, pid, "instagram", "Chris", "instagram")
    conn.execute("INSERT INTO profile_searches VALUES (?, '2026-01-01', 0.014)", (pid,))
    history = tuple(conn.execute("SELECT * FROM profile_searches").fetchone())
    identifiers = [tuple(r) for r in conn.execute("SELECT * FROM identifiers")]
    calls = []
    def runner(backend, username, timeout):
        calls.append((backend, username))
        return ["https://duolingo.com/profile/ChrisWren"] if username == "chriswren" else []
    original = osint.candidates
    monkeypatch.setattr(osint, "candidates", lambda c, p: original(c, p, runner=runner))
    monkeypatch.setattr(osint, "available", lambda: ["sherlock", "maigret"])
    monkeypatch.setattr(socials, "candidates", lambda *a: pytest.fail("no Exa"))
    monkeypatch.setattr(llm, "complete", lambda *a, **kw: pytest.fail("no facts: no model"))
    monkeypatch.setattr(profile_evidence, "fetch", lambda url, timeout: {
        "url": url, "access": "ok", "title": "Chris (@ChrisWren) | Duolingo", "description": "", "identity_links": []})
    # Default batch eligibility must also find imported usernames despite prior Exa history.
    assert [r["id"] for r in osint.to_search(conn, 10)] == [pid]
    args = cli.build_parser().parse_args(["socials", "find", "--osint-only", "--closest", "1"])
    cli.cmd_socials(conn, args)
    assert calls == [("sherlock", "chris-wren"), ("maigret", "chris-wren"),
                     ("sherlock", "chriswren"), ("maigret", "chriswren")]
    suggestion = socials.suggestions(conn)[0]
    assert suggestion["url"] == "https://duolingo.com/profile/chriswren"
    assert suggestion["assessment"] == "possible" and suggestion["status"] == "suggested"
    assert not socials.confirmed(conn, pid)
    for source in json.loads(suggestion["sources"]):
        assert source["handle"] == "chriswren"
        assert source["seed_sources"] == [{"type": "contact_identifier", "site": "linkedin", "source": "linkedin",
                                          "known_username": "chris-wren", "transformation": "separatorless"}]
    assert tuple(conn.execute("SELECT * FROM profile_searches").fetchone()) == history
    assert [tuple(r) for r in conn.execute("SELECT * FROM identifiers")] == identifiers
    assert "Exa cost $0.000" in capsys.readouterr().out
