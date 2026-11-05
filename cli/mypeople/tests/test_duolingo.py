"""Duolingo discovery remains a public lead, never an ownership confirmation."""

import json
from types import SimpleNamespace

import pytest

from mypeople import cli, identity, llm, osint, profile_evidence as evidence, socials
from mypeople.events import add_event
from mypeople.profile_urls import enumeration_site, profile_url, username_for


PROFILE = "https://duolingo.com/profile/chriswren"
API = evidence.DUOLINGO_API + "?username=chriswren"


def response(users):
    return 200, {"content-type": "application/json"}, json.dumps({"users": users}).encode()


@pytest.mark.parametrize("url", [PROFILE, "https://www.duolingo.com/profile/ChrisWren/?ref=friend"])
def test_duolingo_profile_normalization_and_handle(url):
    assert profile_url(url) == PROFILE
    assert username_for(url) == "chriswren"
    assert enumeration_site("https://www.duolingo.com/profile/{username}")
    assert enumeration_site("https://www.duolingo.com/profile/{}")


@pytest.mark.parametrize("url", [
    "https://duolingo.com/learn", "https://duolingo.com/profile", API,
    "https://duolingo.com/profile/chriswren/friends",
    "https://evil.duolingo.com/profile/chriswren",
    "https://duolingo.com.evil.example/profile/chriswren",
])
def test_only_duolingo_account_routes_are_profiles(url):
    assert profile_url(url) is None


def test_public_api_metadata_keeps_only_identity_fields():
    calls = []
    def get(url, timeout):
        calls.append(url)
        assert 0 < timeout <= 8
        return response([{"username": "ChrisWren", "name": "Chris", "bio": "Hello!",
                          "id": "SECRET_ID", "email": "SECRET_EMAIL", "courses": ["SECRET_ACTIVITY"],
                          "friends": ["SECRET_GRAPH"], "token": "SECRET_TOKEN"}])
    page = evidence.fetch(PROFILE, get=get)
    assert calls == [API]
    assert page["access"] == "ok" and page["title"] == "Chris (@ChrisWren) | Duolingo"
    assert page["description"] == "Hello!" and page["transport"] == "duolingo_api"
    assert page["identity_links"] == [] and page["links"] == []
    assert "SECRET" not in json.dumps(page)


@pytest.mark.parametrize("users,access", [
    ([], "not_found"), ([{"username": "someoneelse", "name": "Chris Wren"}], "error"),
    ([{"username": "chriswren"}, {"username": "ChrisWren"}], "error"),
    ([{"username": None}], "error"), (["not a user"], "error"),
])
def test_public_api_requires_exact_unique_account(users, access):
    page = evidence.fetch(PROFILE, get=lambda *a: response(users))
    assert page["access"] == access and not page["title"]


@pytest.mark.parametrize("body", [b"invalid", b"[]", b'{"users":null}', b'{"users":{}}', b"{}"])
def test_malformed_api_is_not_profile_evidence(body):
    page = evidence.fetch(PROFILE, get=lambda *a: (200, {"content-type": "application/json"}, body))
    assert page["access"] == "error" and not page["title"]


@pytest.mark.parametrize("destination", [
    "https://github.com/chriswren", evidence.DUOLINGO_API + "?username=someoneelse",
    "https://127.0.0.1/private", "/2017-06-30/users?username=someoneelse",
])
def test_api_redirects_cannot_change_user_or_scope(destination):
    calls = []
    def get(url, timeout):
        calls.append(url)
        return 302, {"location": destination}, b""
    assert evidence.fetch(PROFILE, get=get)["access"] == "blocked"
    assert calls == [API]


@pytest.mark.parametrize("url", [
    evidence.DUOLINGO_API, API + "&fields=email", API + "&username=someoneelse",
    API + "#fragment", API.replace("https:", "http:"), API.replace("www.", ""),
    API.replace("www.duolingo.com", "www.duolingo.com.evil.example"),
    API.replace("www.duolingo.com", "user:pass@www.duolingo.com"),
    API.replace("www.duolingo.com", "www.duolingo.com:443"),
    evidence.DUOLINGO_API + "?username=chris%40example.com",
    evidence.DUOLINGO_API + "?username=chris%0Awren",
])
def test_api_transport_does_not_allow_arbitrary_endpoints(url, monkeypatch):
    monkeypatch.setattr(evidence, "public_address", lambda *a: pytest.fail("must reject before DNS"))
    assert evidence._duolingo_api_username(url) is None
    with pytest.raises(evidence.UnsafeURL):
        evidence.request(url, 2)


def test_api_requests_use_existing_public_ip_pinning_and_bounded_reads(monkeypatch):
    calls = []
    class Connection:
        def __init__(self, host, address, timeout):
            calls.append((host, address, timeout))
        def request(self, method, target, headers):
            assert method == "GET" and target == "/2017-06-30/users?username=chriswren"
            assert headers["Accept"] == "application/json" and "Cookie" not in headers
        def getresponse(self):
            return SimpleNamespace(status=200, getheaders=lambda: [("Content-Type", "application/json")],
                                   read=lambda size: calls.append(size) or b'{"users":[]}')
        def close(self):
            calls.append("closed")
    monkeypatch.setattr(evidence, "public_address", lambda host: "8.8.8.8")
    monkeypatch.setattr(evidence, "_PinnedHTTPS", Connection)
    assert evidence.request(API, 2)[0] == 200
    assert calls == [("www.duolingo.com", "8.8.8.8", 2), evidence.MAX_BYTES, "closed"]


def test_api_non_json_and_browser_generic_shells_are_empty():
    html = b"<title>Duolingo</title><meta name=description content=\"Learn a language\">"
    get = lambda *a: (200, {"content-type": "text/html"}, html)
    assert evidence.fetch(PROFILE, get=get)["access"] == "empty"
    assert evidence.fetch(PROFILE, get=get, prefer_api=False)["access"] == "empty"


def test_explicit_seed_survives_discovery_without_becoming_confirmation(conn, monkeypatch):
    pid = identity.create_person(conn, "Chris Wren")
    calls = []
    def runner(backend, username, timeout):
        calls.append((backend, username))
        return ["https://www.duolingo.com/profile/ChrisWren"]
    def source(conn, person_id):
        return osint.candidates(conn, person_id, runner=runner, usernames=["@ChrisWren", "chriswren"])
    original = evidence.fetch
    monkeypatch.setattr(evidence, "fetch", lambda url, timeout: original(
        url, get=lambda *a: response([{"username": "ChrisWren", "name": "Chris"}])))
    monkeypatch.setattr(llm, "complete", lambda *a, **kw: pytest.fail("no facts; must not call model"))
    n, cost = socials.find(conn, pid, exa=False, osint=source,
                          search=lambda *a, **kw: pytest.fail("no Exa"))
    assert n == 1 and cost == 0 and len(calls) == 2
    assert calls == [("sherlock", "chriswren"), ("maigret", "chriswren")]
    suggestion = socials.suggestions(conn)[0]
    assert suggestion["url"] == PROFILE and suggestion["assessment"] == "possible"
    assert not socials.confirmed(conn, pid) and not osint.handles_for(conn, pid)
    assert conn.execute("SELECT COUNT(*) FROM identifiers").fetchone()[0] == 0
    assert conn.execute("SELECT COUNT(*) FROM profile_searches").fetchone()[0] == 0


@pytest.mark.parametrize("value", ["chris@example.com", "+15551234567", "15551234567", "123-456-7890",
                                  "https://github.com/chris", "Chris Wren", "@@chris", ""])
def test_explicit_seed_rejects_private_identifier_shapes(value):
    with pytest.raises(ValueError):
        osint.public_username(value)
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["socials", "find", "Chris Wren", "--osint-only", "--username", value])


@pytest.mark.parametrize("argv", [
    ["socials", "find", "--osint-only", "--username", "chriswren"],
    ["socials", "find", "Chris Wren", "--username", "chriswren"],
    ["socials", "review", "Chris Wren", "--osint-only", "--username", "chriswren"],
])
def test_seed_requires_explicit_opt_in_and_one_person(conn, argv):
    with pytest.raises(SystemExit, match="requires one PERSON"):
        cli.cmd_socials(conn, cli.build_parser().parse_args(argv))


def test_cli_explicit_seed_works_without_confirmed_handles_or_exa(conn, monkeypatch, capsys):
    pid = identity.create_person(conn, "Chris Wren")
    monkeypatch.setattr(osint, "available", lambda: ["sherlock"])
    calls = []
    def source(conn, person_id, *, usernames):
        calls.append((person_id, usernames))
        return [{"url": PROFILE, "sources": [{"source": "sherlock", "url": PROFILE}]}]
    monkeypatch.setattr(osint, "candidates", source)
    monkeypatch.setattr(evidence, "fetch", lambda url, timeout: {
        "url": url, "access": "ok", "title": "Chris", "description": "", "identity_links": []})
    monkeypatch.setattr(socials, "candidates", lambda *a: pytest.fail("no Exa"))
    args = cli.build_parser().parse_args(["socials", "find", "Chris Wren", "--osint-only", "--username", "@ChrisWren"])
    cli.cmd_socials(conn, args)
    assert calls == [(pid, ["chriswren"])]
    assert "Exa cost $0.000" in capsys.readouterr().out
    assert socials.suggestions(conn)[0]["assessment"] == "possible"
    assert not socials.confirmed(conn, pid)


def test_known_linkedin_reallocates_both_searches_to_other_domains(conn):
    pid = identity.create_person(conn, "Chris Wren")
    add_event(conn, pid, "job", "Works at ExampleCorp", "2025", 0.9, "test")
    add_event(conn, pid, "move", "Lives in Richmond and loves living there", "2025", 0.9, "test")
    conn.execute("INSERT INTO profiles (person_id,site,url,title,confidence,reason,status) "
                 "VALUES (?, 'linkedin', 'https://linkedin.com/in/chris-wren', 'Chrís Wren (李) | LinkedIn', 1, '', 'confirmed')", (pid,))
    calls = []
    def search(query, **options):
        calls.append((query, options))
        return [{"url": "https://linkedin.com/in/wrong-person"}, {"url": PROFILE}], 0.007
    found, cost = socials.candidates(socials.context(conn, pid), search=search)
    assert len(calls) == 2 and round(cost, 3) == 0.014
    assert all(q == '"Chrís Wren"' and "category" not in opts for q, opts in calls)
    domains = [set(opts["includeDomains"]) for _, opts in calls]
    assert not domains[0] & domains[1] and domains[0] | domains[1] == set(socials.SOCIAL_DOMAINS)
    assert "linkedin.com" not in domains[0] | domains[1]
    assert "duolingo.com" in domains[0] | domains[1]
    assert [c["url"] for c in found] == [PROFILE]


def test_new_person_still_gets_people_search_but_personal_query_has_no_career_context(conn):
    pid = identity.create_person(conn, "Chris Wren")
    add_event(conn, pid, "job", "Works at ExampleCorp", "2025", 0.9, "test")
    calls = []
    def search(query, **options):
        calls.append((query, options))
        return [], 0.007
    socials.candidates(socials.context(conn, pid), search=search)
    assert calls[0][1] == {"category": "people"} and "ExampleCorp" in calls[0][0]
    assert calls[1][0] == '"Chris Wren"' and "linkedin.com" not in calls[1][1]["includeDomains"]


def test_accented_full_name_matches_but_name_alone_does_not_support():
    ctx = {"name": "Chris Wren", "aliases": [], "facts": [], "email_domains": []}
    candidate = {"url": PROFILE, "evidence": {"page": {
        "access": "ok", "title": "Chrís Wren (@chriswren) | Duolingo", "description": ""}, "index": ""}}
    assert socials.owner_name_matches(ctx, candidate)
    assert socials.ground(ctx, candidate).assessment == "possible"
