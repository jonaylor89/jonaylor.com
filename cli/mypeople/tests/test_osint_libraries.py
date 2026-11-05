"""Offline contract tests for the pinned optional libraries: run with --extra osint."""

import asyncio
import inspect
import subprocess

import pytest

from mypeople import osint


@pytest.fixture
def no_network_or_processes(monkeypatch, tmp_path):
    requests = pytest.importorskip("requests")

    def fail(*args, **kwargs):
        pytest.fail("library adapters must not invoke CLIs or fetch remote site databases")

    monkeypatch.setattr(requests.sessions.Session, "request", fail)
    monkeypatch.setattr(subprocess, "run", fail)
    monkeypatch.chdir(tmp_path)
    return tmp_path


def test_sherlock_python_api_contract(monkeypatch, no_network_or_processes):
    engine = pytest.importorskip("sherlock_project.sherlock")
    from sherlock_project.notify import QueryNotify
    from sherlock_project.result import QueryResult, QueryStatus

    signature = inspect.signature(engine.sherlock)
    calls = []

    def search(username, site_data, query_notify, **kwargs):
        signature.bind(username, site_data, query_notify, **kwargs)
        assert username == "cwren" and kwargs == {"timeout": 17}
        assert type(query_notify) is QueryNotify
        assert "GitHub" in site_data and "Duolingo" in site_data
        assert 0 < len(site_data) <= 12
        assert all(osint.enumeration_site(s["url"]) for s in site_data.values())
        assert "LinkedIn" not in site_data and "Reddit" not in site_data
        site_data["GitHub"]["mutated_by_engine"] = True
        calls.append(site_data)
        return {
            status.name: {
                "url_user": f"https://github.com/{status.name.lower()}",
                "status": QueryResult(username, "GitHub", "", status),
            } for status in QueryStatus
        }

    monkeypatch.setattr(engine, "sherlock", search)
    assert osint.run_backend("sherlock", "cwren", 17) == ["https://github.com/claimed"]
    assert len(calls) == 1
    assert "mutated_by_engine" not in osint._sherlock_sites()["GitHub"]
    assert list(no_network_or_processes.iterdir()) == []


def test_maigret_python_api_contract(monkeypatch, no_network_or_processes):
    engine = pytest.importorskip("maigret")
    from maigret.result import MaigretCheckResult, MaigretCheckStatus

    signature = inspect.signature(engine.search)
    calls = []

    async def search(**kwargs):
        signature.bind(**kwargs)
        assert kwargs["username"] == "cwren"
        assert kwargs["timeout"] == 17
        assert kwargs["id_type"] == "username"
        assert kwargs["is_parsing_enabled"] is False
        assert kwargs["is_enrich_enabled"] is False
        assert kwargs["no_progressbar"] is True
        assert kwargs["site_dict"] and all(not s.disabled for s in kwargs["site_dict"].values())
        assert len(kwargs["site_dict"]) <= 12
        assert all(osint.enumeration_site(s.url) for s in kwargs["site_dict"].values())
        assert "Duolingo" in kwargs["site_dict"]
        assert "GitHubGist" not in kwargs["site_dict"]
        kwargs["site_dict"]["GitHub"].url = "https://mutated.invalid/{username}"
        calls.append(kwargs)
        return {
            status.name: {
                "url_user": f"https://instagram.com/{status.name.lower()}",
                "status": MaigretCheckResult("cwren", "Instagram", "", status,
                                             ids_data={"other_username": "must-not-search"}),
            } for status in MaigretCheckStatus
        }

    monkeypatch.setattr(engine, "search", search)
    assert osint.run_backend("maigret", "cwren", 17) == ["https://instagram.com/claimed"]
    assert len(calls) == 1  # No recursive searches of extracted IDs.
    assert list(no_network_or_processes.iterdir()) == []


def test_maigret_total_timeout_cancels_search(monkeypatch, no_network_or_processes, caplog):
    engine = pytest.importorskip("maigret")
    cancelled = []
    wait_for = asyncio.wait_for

    async def search(**kwargs):
        try:
            await asyncio.Future()
        finally:
            cancelled.append(True)

    async def quick_timeout(awaitable, *, timeout):
        assert timeout == 17
        return await wait_for(awaitable, timeout=0.001)

    monkeypatch.setattr(engine, "search", search)
    monkeypatch.setattr(osint.asyncio, "wait_for", quick_timeout)
    assert osint.run_backend("maigret", "cwren", timeout=17) == []
    assert cancelled == [True]
    assert "OSINT maigret failed" in caplog.text
