"""An existing confirmed LinkedIn raises the bar for reviewing another one."""

import json

import pytest

from mypeople import cli, identity, llm, profile_evidence, socials


PRIMARY = "https://linkedin.com/in/chris-wren"
EXTRA = "https://linkedin.com/in/chris-wren-new"
GITHUB = "https://github.com/cwren"


def add(conn, pid, url, *, status="suggested", assessment="possible", evidence=None):
    raw = evidence if isinstance(evidence, str) else json.dumps(evidence or {})
    return conn.execute(
        "INSERT INTO profiles (person_id,site,url,title,confidence,status,assessment,evidence) "
        "VALUES (?, ?, ?, 'Chris Wren', 0.999, ?, ?, ?)",
        (pid, socials.site(url), url, status, assessment, raw)).lastrowid


def known(conn):
    pid = identity.create_person(conn, "Chris Wren")
    add(conn, pid, PRIMARY, status="confirmed")
    return pid


def linked(source=GITHUB, target=EXTRA):
    return {"page": {"access": "ok", "title": "Chris Wren", "description": "Recruiter at ExampleCorp"},
            "trusted_links": [{"source_url": source, "target_url": target, "observed_at": "2026-01-01"}]}


def urls(conn, **kwargs):
    return [r["url"] for r in socials.suggestions(conn, **kwargs)]


@pytest.mark.parametrize("assessment", ["possible", "supported"])
def test_old_extra_linkedins_hidden_without_deleting_or_rejecting_them(conn, assessment):
    pid = known(conn)
    add(conn, pid, EXTRA, assessment=assessment, evidence={
        "page": {"access": "ok", "title": "Chris Wren", "description": "ExampleCorp and Example University"},
        "matches": [{"quote": "ExampleCorp"}, {"quote": "Example University"}]})
    add(conn, pid, GITHUB)
    before = [tuple(r) for r in conn.execute("SELECT * FROM profiles ORDER BY id")]
    assert urls(conn) == [GITHUB]  # Even 0.999 confidence / supported is not the strict exception.
    assert set(urls(conn, include_diagnostics=True)) == {EXTRA, GITHUB}
    assert [tuple(r) for r in conn.execute("SELECT * FROM profiles ORDER BY id")] == before


@pytest.mark.parametrize("status", ["suggested", "rejected"])
def test_no_confirmed_linkedin_leaves_first_account_discovery_reviewable(conn, status):
    pid = identity.create_person(conn, "Chris Wren")
    add(conn, pid, PRIMARY, status=status)
    add(conn, pid, EXTRA)
    assert EXTRA in urls(conn)


def test_explicit_identity_link_is_exception_only_while_source_is_confirmed(conn):
    pid = known(conn)
    anchor_id = add(conn, pid, GITHUB, status="confirmed")
    extra_id = add(conn, pid, EXTRA, assessment="supported", evidence=linked())
    assert urls(conn) == [EXTRA]
    socials.set_status(conn, anchor_id, "rejected")
    assert urls(conn) == []
    assert urls(conn, include_diagnostics=True) == [EXTRA]
    socials.set_status(conn, anchor_id, "confirmed")
    assert urls(conn) == [EXTRA]
    assert conn.execute("SELECT status FROM profiles WHERE id=?", (extra_id,)).fetchone()[0] == "suggested"


@pytest.mark.parametrize("source", [PRIMARY, GITHUB])
def test_current_confirmed_linkedin_or_other_platform_can_supply_identity_link(conn, source):
    pid = known(conn)
    if source == GITHUB:
        add(conn, pid, GITHUB, status="confirmed")
    add(conn, pid, EXTRA, assessment="supported", evidence=linked(source=source))
    assert urls(conn) == [EXTRA]


@pytest.mark.parametrize("case", [
    "unconfirmed_source", "other_person_source", "wrong_target", "missing_target", "index_only",
    "inaccessible_page", "possible_assessment", "plain_links", "numeric_source", "numeric_target",
])
def test_weaker_or_invalid_link_evidence_cannot_unlock_extra_linkedin(conn, case):
    pid = known(conn)
    other = identity.create_person(conn, "Different Person")
    add(conn, other if case == "other_person_source" else pid, GITHUB,
        status="suggested" if case == "unconfirmed_source" else "confirmed")
    evidence = linked()
    if case == "wrong_target":
        evidence["trusted_links"][0]["target_url"] = "https://linkedin.com/in/someone-else"
    elif case == "missing_target":
        del evidence["trusted_links"][0]["target_url"]
    elif case == "index_only":
        evidence = {"page": {"access": "blocked"}, "index": "Chris Wren, ExampleCorp, Example University"}
    elif case == "inaccessible_page":
        evidence["page"]["access"] = "blocked"
    elif case == "plain_links":
        evidence["page"]["links"] = [EXTRA]
        evidence["trusted_links"] = []
    elif case == "numeric_source":
        evidence["trusted_links"][0]["source_url"] = 123
    elif case == "numeric_target":
        evidence["trusted_links"][0]["target_url"] = 123
    add(conn, pid, EXTRA, assessment="possible" if case == "possible_assessment" else "supported", evidence=evidence)
    assert EXTRA not in urls(conn)


@pytest.mark.parametrize("raw", [
    "not json", "null", "[]", "{}", '{"page":[]}',
    '{"page":{"access":"ok"},"trusted_links":null}',
    '{"page":{"access":"ok"},"trusted_links":{}}',
    '{"page":{"access":"ok"},"trusted_links":["not a link",null]}'
])
def test_missing_or_malformed_legacy_evidence_does_not_crash_or_unlock_review(conn, raw):
    pid = known(conn)
    add(conn, pid, EXTRA, assessment="supported", evidence=raw)
    assert urls(conn) == []
    assert urls(conn, include_diagnostics=True) == [EXTRA]


@pytest.mark.parametrize("alias", [True, False])
def test_known_profile_alias_or_redirect_is_never_a_second_account(conn, alias):
    pid = known(conn)
    add(conn, pid, GITHUB, status="confirmed")
    candidate = "https://www.linkedin.com/in/CHRIS-WREN/" if alias else EXTRA
    evidence = linked(target=candidate)
    if not alias:
        evidence["page"]["final_url"] = PRIMARY
    add(conn, pid, candidate, assessment="supported", evidence=evidence)
    assert not urls(conn)


def test_exa_does_not_request_or_fetch_additional_linkedins(conn, monkeypatch):
    pid = known(conn)
    calls = []
    def search(query, **options):
        calls.append(options)
        # Guard even against provider results that violate their domain filter.
        return [{"url": EXTRA, "title": "Chris Wren"}], 0.007
    monkeypatch.setattr(profile_evidence, "fetch", lambda *a, **kw: pytest.fail("must drop before fetching"))
    monkeypatch.setattr(llm, "complete", lambda *a, **kw: pytest.fail("must not assess extras"))
    assert socials.find(conn, pid, search=search) == (0, 0.014)
    assert len(calls) == 2
    assert all("category" not in c and "linkedin.com" not in c["includeDomains"] for c in calls)
    assert conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 1


@pytest.mark.parametrize("already_stored", [False, True])
def test_hidden_extra_is_not_counted_as_new_reviewable_profile(conn, already_stored):
    pid = known(conn)
    if already_stored:
        add(conn, pid, EXTRA)
    monkey_page = lambda url, timeout: {"url": url, "access": "ok", "title": "Chris Wren", "identity_links": []}
    assert socials.find(conn, pid, exa=False, osint=lambda *a: [{"url": EXTRA}],
                        fetcher=monkey_page, judge=lambda *a: []) == (0, 0)
    assert not urls(conn)
    assert urls(conn, include_diagnostics=True) == [EXTRA]
    assert conn.execute("SELECT status FROM profiles WHERE url=?", (EXTRA,)).fetchone()[0] == "suggested"


def test_new_strong_identity_link_counts_even_if_old_supported_lead_was_hidden(conn):
    pid = known(conn)
    add(conn, pid, GITHUB, status="confirmed")
    add(conn, pid, EXTRA, assessment="supported")
    assert not urls(conn)
    def fetch(url, timeout):
        return {"url": url, "access": "ok", "title": "Chris Wren",
                "identity_links": [EXTRA] if url == GITHUB else []}
    assert socials.find(conn, pid, exa=False, osint=lambda *a: [{"url": EXTRA}],
                        fetcher=fetch, judge=lambda *a: []) == (1, 0)
    assert urls(conn) == [EXTRA]
    assert conn.execute("SELECT status FROM profiles WHERE url=?", (EXTRA,)).fetchone()[0] == "suggested"


def test_confirming_during_review_skips_remaining_weak_linkedins_only_for_that_person(conn, monkeypatch, capsys):
    pid = identity.create_person(conn, "Chris Wren")
    primary_id = add(conn, pid, PRIMARY)
    extra_id = add(conn, pid, EXTRA)
    add(conn, pid, GITHUB)
    other = identity.create_person(conn, "Zara Example")
    other_url = "https://linkedin.com/in/zara-example"
    add(conn, other, other_url)
    answers, prompts = iter(["y", "s", "s"]), []
    def answer(prompt):
        prompts.append(prompt)
        return next(answers)  # Any fourth prompt is a regression.
    monkeypatch.setattr("builtins.input", answer)
    cli.cmd_socials(conn, cli.build_parser().parse_args(["socials", "review"]))
    output = capsys.readouterr().out
    assert len(prompts) == 3 and PRIMARY in output and GITHUB in output and other_url in output
    assert EXTRA not in output
    assert conn.execute("SELECT status FROM profiles WHERE id=?", (primary_id,)).fetchone()[0] == "confirmed"
    assert conn.execute("SELECT status FROM profiles WHERE id=?", (extra_id,)).fetchone()[0] == "suggested"


def test_rejecting_one_linkedin_during_review_does_not_hide_the_next(conn, monkeypatch):
    pid = identity.create_person(conn, "Chris Wren")
    primary_id, extra_id = add(conn, pid, PRIMARY), add(conn, pid, EXTRA)
    answers = iter(["n", "y"])
    monkeypatch.setattr("builtins.input", lambda *a: next(answers))
    cli.cmd_socials(conn, cli.build_parser().parse_args(["socials", "review"]))
    assert conn.execute("SELECT status FROM profiles WHERE id=?", (primary_id,)).fetchone()[0] == "rejected"
    assert conn.execute("SELECT status FROM profiles WHERE id=?", (extra_id,)).fetchone()[0] == "confirmed"


def test_review_all_is_an_explicit_escape_hatch_without_changing_decisions(conn, monkeypatch, capsys):
    pid = known(conn)
    add(conn, pid, EXTRA)
    prompts = []
    monkeypatch.setattr("builtins.input", lambda prompt: prompts.append(prompt) or "s")
    cli.cmd_socials(conn, cli.build_parser().parse_args(["socials", "review"]))
    assert not prompts and "--all" in capsys.readouterr().out
    cli.cmd_socials(conn, cli.build_parser().parse_args(["socials", "review", "--all"]))
    assert len(prompts) == 1 and EXTRA in capsys.readouterr().out
    assert conn.execute("SELECT status FROM profiles WHERE url=?", (EXTRA,)).fetchone()[0] == "suggested"
