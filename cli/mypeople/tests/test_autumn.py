import io
import json
import urllib.error
import urllib.parse

import pytest

from mypeople import autumn, cli, identity, llm, osint, profile_evidence, socials
from .test_socials import make_person, page


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    monkeypatch.setattr(profile_evidence, "fetch", page)
    monkeypatch.setattr(autumn.time, "sleep", lambda _: None)
    monkeypatch.setattr(autumn, "_request", lambda *a, **kw: pytest.fail("unexpected Autumn request"))
    monkeypatch.setattr(socials, "exa_search", lambda *a, **kw: pytest.fail("unexpected Exa request"))


def backend(monkeypatch, rows=None, states=None):
    calls = []
    pending = list(states or [{"state": "completed", "done": True, "credits_used": 12}])

    def request(path, body=None, **kwargs):
        calls.append((path, body))
        if path == "/task":
            return {"task_id": "task-123"}
        if "/output?" in path:
            return {"rows": rows if rows is not None else [{
                "url": "https://github.com/cwren", "title": "Chris Wren",
                "summary": "Autumn claims ownership", "source_url": "https://example.org/source"}]}
        return pending.pop(0) if len(pending) > 1 else pending[0]

    monkeypatch.setattr(autumn, "_request", request)
    return calls


def test_cli_routes_autumn_without_exa_and_reports_credits(conn, monkeypatch, capsys):
    pid = make_person(conn)
    calls = []

    def find(conn, person_id, **kwargs):
        calls.append((person_id, kwargs))
        return 2, 0.0

    monkeypatch.setattr(socials, "find", find)
    args = cli.build_parser().parse_args(["socials", "find", "--person", "Chris Wren", "--autumn",
                                          "--autumn-timeout", "17", "--again"])
    cli.cmd_socials(conn, args)
    assert calls == [(pid, {"osint": None, "exa": False, "autumn": True, "again": True, "autumn_timeout": 17})]
    out = capsys.readouterr().out
    assert "Autumn credits" in out and "Exa cost $" not in out


def test_cli_combines_autumn_and_osint(conn, monkeypatch):
    make_person(conn)
    monkeypatch.setattr(osint, "available", lambda: ["sherlock"])
    calls = []
    monkeypatch.setattr(socials, "find", lambda *a, **kw: (calls.append(kw) or 0, 0.0))
    cli.cmd_socials(conn, cli.build_parser().parse_args(["socials", "find", "Chris Wren", "--autumn", "--osint"]))
    assert calls[0]["osint"] is osint.candidates and calls[0]["autumn"] and not calls[0]["exa"]


@pytest.mark.parametrize("argv", [
    ["socials", "review", "--autumn"],
    ["socials", "find", "--autumn", "--osint-only"],
])
def test_invalid_combinations_fail_before_any_work(conn, argv):
    with pytest.raises(SystemExit, match="--autumn"):
        cli.cmd_socials(conn, cli.build_parser().parse_args(argv))


@pytest.mark.parametrize("value", ["0", "-1"])
def test_timeout_must_be_positive(value):
    with pytest.raises(SystemExit):
        cli.build_parser().parse_args(["socials", "find", "--autumn-timeout", value])


def test_leads_use_existing_evidence_and_human_review_pipeline(conn, monkeypatch):
    pid = make_person(conn)
    calls = backend(monkeypatch)
    judged = []

    def judge(ctx, found):
        judged.extend(found)
        return []

    assert socials.find(conn, pid, autumn=True, judge=judge) == (1, 0.0)
    [row] = socials.suggestions(conn)
    assert row["status"] == "suggested" and row["assessment"] == "possible"
    assert json.loads(row["sources"])[0]["task_id"] == "task-123"
    assert judged[0]["evidence"]["index"] == ""  # Generated summaries aren't evidence.
    assert json.loads(row["evidence"])["page"]["access"] == "ok"
    assert not conn.execute("SELECT * FROM profile_searches").fetchall()
    assert conn.execute("SELECT completed FROM autumn_searches").fetchone()[0] == 1
    socials.set_status(conn, row["id"], "rejected")
    socials.find(conn, pid, autumn=True, judge=lambda *a: pytest.fail("don't assess a rejected profile"))
    assert not socials.suggestions(conn)
    assert sum(path == "/task" for path, _ in calls) == 1


def test_brief_whitelists_minimal_context(conn, monkeypatch):
    pid = make_person(conn)
    ctx = socials.context(conn, pid)
    ctx.update(messages="private conversation", phone="+15551234567", email="private@example.org")
    calls = backend(monkeypatch)
    autumn.candidates(conn, pid, ctx)
    brief = calls[0][1]
    text = json.dumps(brief)
    assert all(secret not in text for secret in ["private conversation", "+15551234567", "private@example.org", "chris@"])
    assert "Chris Wren" in text and "Capital One" in text and "capitalone.com" in text
    assert brief["count"] == 20 and brief["version"] == "ranger" and brief["clarify"] is False


def test_history_is_separate_and_pending_work_stays_eligible(conn):
    pid = make_person(conn)
    conn.execute("INSERT INTO profile_searches VALUES (?, '2026-01-01', 0.014)", (pid,))
    assert not socials.to_search(conn, 10)
    assert [p["id"] for p in socials.to_search(conn, 10, autumn=True)] == [pid]
    conn.execute("INSERT INTO autumn_searches VALUES (?, 'task-123', 0)", (pid,))
    assert [p["id"] for p in socials.to_search(conn, 10, autumn=True)] == [pid]
    conn.execute("UPDATE autumn_searches SET completed=1")
    assert not socials.to_search(conn, 10, autumn=True)
    assert [p["id"] for p in socials.to_search(conn, 10, again=True, autumn=True)] == [pid]


def test_interrupt_saves_task_and_again_resumes_instead_of_paying_twice(conn, monkeypatch):
    pid = make_person(conn)
    calls = []

    def interrupt(path, body=None, **kwargs):
        calls.append(path)
        if path == "/task":
            return {"task_id": "task-123"}
        raise KeyboardInterrupt

    monkeypatch.setattr(autumn, "_request", interrupt)
    with pytest.raises(KeyboardInterrupt):
        autumn.candidates(conn, pid, socials.context(conn, pid))
    assert conn.execute("SELECT task_id FROM autumn_searches").fetchone()[0] == "task-123"
    calls = backend(monkeypatch)
    autumn.candidates(conn, pid, socials.context(conn, pid), again=True)
    assert not any(path == "/task" for path, _ in calls)


def test_again_starts_new_task_only_for_completed_import(conn, monkeypatch):
    pid = make_person(conn)
    conn.execute("INSERT INTO autumn_searches VALUES (?, 'old-task', 1)", (pid,))
    calls = backend(monkeypatch)
    autumn.candidates(conn, pid, socials.context(conn, pid), again=True)
    assert calls[0][0] == "/task"
    assert conn.execute("SELECT completed FROM autumn_searches").fetchone()[0] == 0


def test_long_poll_and_partial_results(conn, monkeypatch, capsys):
    pid = make_person(conn)
    calls = backend(monkeypatch, states=[
        {"state": "working", "done": False, "progress": {"rows": 1}},
        {"state": "completed", "done": True, "outcome": "partial", "credits_used": 9}])
    assert len(autumn.candidates(conn, pid, socials.context(conn, pid))) == 1
    assert sum("?wait=" in path for path, _ in calls) == 2
    out = capsys.readouterr().out
    assert "working" in out and "partial" in out and "9 credits" in out


@pytest.mark.parametrize("state", ["failed", "input-required", "canceled"])
def test_terminal_errors_do_not_mark_import_complete(conn, monkeypatch, state):
    pid = make_person(conn)
    backend(monkeypatch, states=[{"state": state, "done": True, "message": "Please open the task"}])
    with pytest.raises(autumn.AutumnError, match=state):
        socials.find(conn, pid, autumn=True)
    assert conn.execute("SELECT completed FROM autumn_searches").fetchone()[0] == 0
    assert not conn.execute("SELECT * FROM profile_searches").fetchall()


def test_timeout_retains_task(conn, monkeypatch):
    pid = make_person(conn)
    backend(monkeypatch)
    clock = iter([0, 601])
    monkeypatch.setattr(autumn.time, "monotonic", lambda: next(clock))
    with pytest.raises(autumn.AutumnError, match="resume"):
        autumn.candidates(conn, pid, socials.context(conn, pid), timeout=600)
    assert conn.execute("SELECT task_id FROM autumn_searches").fetchone()[0] == "task-123"


def test_normalizes_filters_and_deduplicates_rows(conn, monkeypatch):
    pid = make_person(conn)
    backend(monkeypatch, rows=[
        {"url": "https://www.twitter.com/CWren?utm_source=test", "summary": "Lead"},
        {"url": "https://x.com/cwren", "summary": "Duplicate"},
        {"url": "https://example.org/random"}, {"url": "http://127.0.0.1/private"},
        {"url": "https://instagram.com/p/post"}, {"url": None}, {}, "invalid"])
    rows = autumn.candidates(conn, pid, socials.context(conn, pid))
    assert [r["url"] for r in rows] == ["https://x.com/cwren"]


def test_pages_output_up_to_bounded_candidate_limit(conn, monkeypatch):
    pid = make_person(conn)
    calls = []

    def request(path, body=None, **kwargs):
        calls.append(path)
        if path == "/task":
            return {"task_id": "task-123"}
        if "/output?" not in path:
            return {"state": "completed", "done": True}
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(path).query)
        if "cursor" not in query:
            return {"rows": [{"url": "https://github.com/first"}], "_next_cursor": "next+page"}
        assert query["cursor"] == ["next+page"]
        return {"rows": [{"url": f"https://github.com/lead{i}"} for i in range(30)], "_next_cursor": "more"}

    monkeypatch.setattr(autumn, "_request", request)
    assert len(autumn.candidates(conn, pid, socials.context(conn, pid))) == 20
    assert sum("/output?" in p for p in calls) == 2


# Exercise the actual HTTP adapter without network access.
REQUEST = autumn._request


def test_http_auth_body_and_env_file(monkeypatch):
    monkeypatch.delenv("AUTUMN_API_KEY", raising=False)
    monkeypatch.setattr(llm, "load_env_file", lambda: monkeypatch.setenv("AUTUMN_API_KEY", "test-key"))
    calls = []

    def urlopen(request, **kwargs):
        calls.append(request)
        return io.BytesIO(b'{"task_id":"test"}')

    monkeypatch.setattr(autumn.urllib.request, "urlopen", urlopen)
    assert REQUEST("/task", {"prompt": "brief"}) == {"task_id": "test"}
    assert calls[0].get_header("X-api-key") == "test-key"
    assert calls[0].method == "POST" and json.loads(calls[0].data) == {"prompt": "brief"}


def test_missing_key_fails_before_network(monkeypatch):
    monkeypatch.delenv("AUTUMN_API_KEY", raising=False)
    monkeypatch.setattr(llm, "load_env_file", lambda: None)
    monkeypatch.setattr(autumn.urllib.request, "urlopen", lambda *a, **kw: pytest.fail("no network"))
    with pytest.raises(autumn.AutumnError, match="AUTUMN_API_KEY"):
        REQUEST("/task", {})


@pytest.mark.parametrize("status", [401, 402, 429, 500])
def test_http_errors_are_actionable_and_never_echo_keys(monkeypatch, status):
    monkeypatch.setenv("AUTUMN_API_KEY", "secret-test-key")
    calls = []

    def fail(request, **kwargs):
        calls.append(request)
        raise urllib.error.HTTPError(request.full_url, status, "error", {}, io.BytesIO(b"secret-test-key"))

    monkeypatch.setattr(autumn.urllib.request, "urlopen", fail)
    with pytest.raises(autumn.AutumnError) as error:
        REQUEST("/task", {})
    assert str(status) in str(error.value) and "secret-test-key" not in str(error.value)
    assert len(calls) == 1  # No blind retries of task creation.
