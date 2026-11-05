import asyncio
from types import SimpleNamespace

import pytest

from mypeople import cli, identity, osint, socials, profile_evidence
from mypeople.events import add_event
from mypeople.socials import Verdict


def confirm(conn, person_id, url, site="github"):
    conn.execute(
        "INSERT INTO profiles (person_id, site, url, title, snippet, confidence, reason, status) "
        "VALUES (?, ?, ?, ?, '', 0.95, 'test', 'confirmed')",
        (person_id, site, url, ""),
    )
    conn.commit()


SHERLOCK = [
    "https://github.com/cwren", "https://instagram.com/cwren",
    "https://linkedin.com/in/Chris-Wren", "https://unknown.example/cwren",
]
MAIGRET = ["https://www.instagram.com/cwren"]


def fake_runner(backend, username, timeout=30):
    fake_runner.calls.append((backend, username, timeout))
    return SHERLOCK if backend == "sherlock" else MAIGRET


def judge(ctx, found):
    judge.seen = [c["url"] for c in found]
    return [Verdict(url=c["url"], assessment="supported", reason="same handle") for c in found]


def test_username_for():
    u = osint.username_for
    assert u("https://github.com/cwren") == "cwren"
    assert u("https://twitter.com/jonaylor89/status/123") == "jonaylor89"
    assert u("https://instagram.com/p/abc/") is None
    assert u("https://medium.com/@jonaylor89") == "jonaylor89"
    assert u("https://jonaylor89.medium.com") == "jonaylor89"
    assert u("https://bsky.app/profile/jonaylor89.bsky.social") == "jonaylor89.bsky.social"
    assert u("https://www.youtube.com/@jonaylor89") == "jonaylor89"
    assert u("https://linkedin.com/in/Chris-Wren") is None


def test_profile_handles_require_confirmation_and_dedupe(conn):
    pid = identity.create_person(conn, "Chris Wren")
    assert osint.handles_for(conn, pid) == []
    confirm(conn, pid, "https://github.com/cwren")
    confirm(conn, pid, "https://instagram.com/cwren", site="instagram")
    assert osint.handles_for(conn, pid) == ["cwren"]


def test_osint_candidates_normalize_and_dedupe(conn):
    pid = identity.create_person(conn, "Chris Wren")
    confirm(conn, pid, "https://github.com/cwren")
    fake_runner.calls = []
    found = osint.candidates(conn, pid, runner=fake_runner, timeout=17)
    assert fake_runner.calls == [("sherlock", "cwren", 17), ("maigret", "cwren", 17)]
    assert [c["url"] for c in found] == ["https://github.com/cwren", "https://instagram.com/cwren"]
    assert found[1]["snippet"] == ""  # A synthetic handle is not profile evidence.
    assert {s["source"] for s in found[1]["sources"]} == {"sherlock", "maigret"}


def test_find_merges_osint_into_verify_pool(conn, monkeypatch):
    monkeypatch.setattr(profile_evidence, "fetch", lambda url, timeout: {
        "access": "ok", "title": "Chris Wren", "description": "", "identity_links": []})
    pid = identity.create_person(conn, "Chris Wren")
    add_event(conn, pid, "job", "Works as a recruiter at Capital One.", "2025-01", 0.9, "imessage")
    confirm(conn, pid, "https://github.com/cwren")
    fake_runner.calls = []

    def no_search(query, **options):
        return [], 0.0

    suggested, cost = socials.find(conn, pid, search=no_search, judge=judge,
                                   osint=lambda c, pid: osint.candidates(c, pid, runner=fake_runner))
    assert suggested == 1 and cost == 0.0
    assert [s["url"] for s in socials.suggestions(conn)] == ["https://instagram.com/cwren"]
    assert judge.seen == ["https://instagram.com/cwren"]  # Confirmed seeds are not re-judged.
    assert socials.suggestions(conn)[0]["assessment"] == "possible"  # Reject the judge\'s unsupported promotion.


def test_available_checks_python_modules_not_path(monkeypatch):
    seen = []

    def find_spec(name):
        seen.append(name)
        return SimpleNamespace() if name == "maigret" else None

    monkeypatch.setattr(osint.importlib.util, "find_spec", find_spec)
    monkeypatch.setenv("PATH", "")
    assert osint.available() == ["maigret"]
    assert seen == ["sherlock_project", "maigret"]


@pytest.mark.parametrize("backend", osint.LIBRARIES)
def test_run_backend_calls_python_adapter(monkeypatch, backend):
    seen = []

    def sherlock(username, timeout):
        seen.append(("sherlock", username, timeout))
        return SHERLOCK

    async def maigret(username, timeout):
        seen.append(("maigret", username, timeout))
        return MAIGRET

    monkeypatch.setattr(osint, "_sherlock", sherlock)
    monkeypatch.setattr(osint, "_maigret", maigret)
    assert osint.run_backend(backend, "cwren", 17) == (SHERLOCK if backend == "sherlock" else MAIGRET)
    assert seen == [(backend, "cwren", 17)]


@pytest.mark.parametrize("backend", osint.LIBRARIES)
@pytest.mark.parametrize("error", [ImportError, TimeoutError, RuntimeError, OSError])
def test_backend_failures_are_isolated(monkeypatch, caplog, backend, error):
    def sherlock(*args):
        raise error("unavailable")

    async def maigret(*args):
        raise error("unavailable")

    monkeypatch.setattr(osint, "_sherlock", sherlock)
    monkeypatch.setattr(osint, "_maigret", maigret)
    assert osint.run_backend(backend, "cwren") == []
    if error is not ImportError:
        assert f"OSINT {backend} failed" in caplog.text


def test_failed_backend_does_not_block_other_candidates(monkeypatch, conn):
    pid = identity.create_person(conn, "Chris Wren")
    confirm(conn, pid, "https://github.com/cwren")

    def sherlock(*args):
        raise OSError("offline")

    async def maigret(*args):
        return MAIGRET

    monkeypatch.setattr(osint, "_sherlock", sherlock)
    monkeypatch.setattr(osint, "_maigret", maigret)
    assert [c["url"] for c in osint.candidates(conn, pid)] == ["https://instagram.com/cwren"]


def test_interrupts_are_not_swallowed(monkeypatch):
    def sherlock(*args):
        raise KeyboardInterrupt

    async def maigret(*args):
        raise asyncio.CancelledError

    monkeypatch.setattr(osint, "_sherlock", sherlock)
    monkeypatch.setattr(osint, "_maigret", maigret)
    with pytest.raises(KeyboardInterrupt):
        osint.run_backend("sherlock", "cwren")
    with pytest.raises(asyncio.CancelledError):
        osint.run_backend("maigret", "cwren")


def test_private_identifiers_and_unreviewed_profiles_never_run_libraries(conn):
    pid = identity.create_person(conn, "Chris Wren")
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, reason) "
                 "VALUES (?, 'github', 'https://github.com/cwren', 0.9, 'test')", (pid,))
    identity.add_identifier(conn, pid, "email", "cwren@example.com", "test")
    assert osint.candidates(conn, pid, runner=lambda *a: pytest.fail("must not enumerate")) == []


def test_cli_explains_optional_dependency_install(conn, monkeypatch, capsys):
    identity.create_person(conn, "Chris Wren")
    monkeypatch.setattr(osint, "available", lambda: [])
    monkeypatch.setattr(socials, "find", lambda *a, **kw: pytest.fail("must not search"))
    args = cli.build_parser().parse_args(["socials", "find", "Chris Wren", "--osint"])
    cli.cmd_socials(conn, args)
    assert "uv sync --extra osint" in capsys.readouterr().out


@pytest.mark.parametrize("enabled", [False, True])
def test_cli_keeps_osint_opt_in(conn, monkeypatch, enabled):
    identity.create_person(conn, "Chris Wren")
    calls = []

    def available():
        assert enabled, "default flow must not inspect OSINT dependencies"
        return ["sherlock"]

    def find(conn, person_id, *, osint, exa):
        assert exa
        calls.append(osint)
        return 0, 0.0

    monkeypatch.setattr(osint, "available", available)
    monkeypatch.setattr(socials, "find", find)
    argv = ["socials", "find", "Chris Wren"] + (["--osint"] if enabled else [])
    cli.cmd_socials(conn, cli.build_parser().parse_args(argv))
    assert calls == [osint.candidates if enabled else None]


def test_osint_only_targets_handles_despite_exa_history_without_paying_again(conn, monkeypatch, capsys):
    pid = identity.create_person(conn, 'Chris Wren')
    identity.create_person(conn, 'New Person Without Handles')
    confirm(conn, pid, 'https://youtube.com/user/FrankieBiggz', site='youtube')
    channel_only = identity.create_person(conn, 'Opaque Channel Owner')
    confirm(conn, channel_only, 'https://youtube.com/channel/UCAbCdE', site='youtube')
    conn.execute("INSERT INTO profile_searches VALUES (?, '2026-01-01', 0.014)", (pid,))
    before = tuple(conn.execute('SELECT * FROM profile_searches').fetchone())
    assert [r['id'] for r in osint.to_search(conn, 10)] == [pid]
    scanned = []
    def source(conn, person_id, timeout=30):
        scanned.append((person_id, osint.handles_for(conn, person_id), timeout))
        return [{'url': 'https://github.com/frankiebiggz', 'sources': []}]
    monkeypatch.setattr(osint, 'available', lambda: ['sherlock'])
    monkeypatch.setattr(osint, 'candidates', source)
    monkeypatch.setattr(socials, 'candidates', lambda *a: pytest.fail('must not call Exa'))
    monkeypatch.setattr(profile_evidence, 'fetch', lambda url, timeout: {
        'access': 'ok', 'title': 'Frankie', 'description': '', 'identity_links': []})
    args = cli.build_parser().parse_args(['socials', 'find', '--osint-only', '--closest', '1', '--osint-timeout', '17'])
    cli.cmd_socials(conn, args)
    assert scanned == [(pid, ['frankiebiggz'], 17)]
    assert tuple(conn.execute('SELECT * FROM profile_searches').fetchone()) == before
    assert 'Exa cost $0.000' in capsys.readouterr().out


@pytest.mark.parametrize('value', ['0', '-1'])
def test_scan_timeouts_must_be_positive(value):
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(['socials', 'find', '--osint-only', '--osint-timeout', value])


def test_offline_exclusions_and_supported_scope_are_applied_before_sherlock(monkeypatch, tmp_path):
    import json
    roots = {name: tmp_path / name for name in ('mypeople', 'sherlock_project')}
    for root in roots.values():
        (root / 'resources').mkdir(parents=True)
        (root / 'data').mkdir()
    (roots['sherlock_project'] / 'resources/data.json').write_text(json.dumps({
        'GitHub': {'url': 'https://github.com/{}'},
        'KnownFalsePositive': {'url': 'https://instagram.com/{}'},
        'Unsupported': {'url': 'https://random.example/{}'},
        'Adult': {'url': 'https://dribbble.com/{}', 'isNSFW': True},
    }))
    (roots['mypeople'] / 'data/sherlock-exclusions.txt').write_text('# source metadata\nKnownFalsePositive\n')
    monkeypatch.setattr(osint.resources, 'files', lambda name: roots[name])
    osint._sherlock_sites.cache_clear()
    try:
        assert set(osint._sherlock_sites()) == {'GitHub'}
    finally:
        osint._sherlock_sites.cache_clear()


def test_cli_finds_one_person_with_person_flag(conn, monkeypatch):
    chris = identity.create_person(conn, "Chris Wren")
    identity.create_person(conn, "Someone Else")
    searched = []
    monkeypatch.setattr(socials, "to_search", lambda *a, **kw: pytest.fail("must not pick closest people"))
    monkeypatch.setattr(socials, "find", lambda conn, person_id, **kw: (searched.append(person_id), (0, 0.0))[1])
    cli.cmd_socials(conn, cli.build_parser().parse_args(["socials", "find", "--person", "Chris Wren"]))
    assert searched == [chris]


def test_cli_rejects_two_different_people(conn):
    with pytest.raises(SystemExit):
        cli.cmd_socials(conn, cli.build_parser().parse_args(["socials", "find", "Chris Wren", "--person", "Someone Else"]))
