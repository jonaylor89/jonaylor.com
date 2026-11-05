from dataclasses import replace
import io
import sqlite3
import time

import pytest
from rich.console import Console

from mypeople import cli, db, extract, identity, llm
from mypeople.extraction_progress import ExtractionProgress, duration
from mypeople.importers.common import add_interaction


class Clock:
    now = 0.0

    def __call__(self):
        return self.now

    def tick(self, seconds=60):
        self.now += seconds


def setup_messages(conn, monkeypatch, n=4, name="Ada Lovelace"):
    monkeypatch.setattr(llm, "backend", lambda: llm.Backend("test", "fake", "", 500, True))
    pid = identity.create_person(conn, name)
    for i in range(n):
        add_interaction(conn, pid, f"2026-01-{i + 1:02d} 12:00:00", "test", "in", "PRIVATE_BODY " + "x" * 350, None, f"test:{pid}:{i}")
    conn.commit()
    return pid


def empty_model(system, user):
    return extract.Extraction(events=[])


def test_plan_and_updates_match_committed_batches(conn, monkeypatch):
    pid = setup_messages(conn, monkeypatch)
    plan = extract.plan_person(conn, pid)
    assert plan.messages == plan.batches == 4
    updates = []

    def record(event):
        assert "PRIVATE_BODY" not in repr(event)
        if event.phase == "batch_done":
            assert not conn.in_transaction
            assert conn.execute("SELECT count(*) FROM interactions WHERE extracted=1").fetchone()[0] == event.messages_done
        updates.append(event)

    assert extract.extract_person(conn, empty_model, pid, progress=record) == 0
    assert updates[0].phase == "start" and updates[0].plan == plan
    assert [u.phase for u in updates] == ["start", *(["batch_start", "saving", "batch_done"] * 4), "done"]
    last = updates[-1]
    assert (last.messages_done, last.batches_done, last.work_done) == (4, 4, plan.work)
    assert last.events == last.skipped == 0
    assert extract.plan_person(conn, pid).messages == 0


def test_cutoff_and_long_message_truncation_plan(conn, monkeypatch):
    import datetime as dt
    pid = setup_messages(conn, monkeypatch)
    conn.execute("UPDATE interactions SET text=?", ("x" * 10_000,))
    plan = extract.plan_person(conn, pid, dt.date(2026, 1, 3))
    assert plan.messages == plan.batches == 2
    assert plan.work < 4000  # work matches the truncated prompt, not raw email bytes
    updates = []
    extract.extract_person(conn, empty_model, pid, dt.date(2026, 1, 3), progress=updates.append)
    assert updates[-1].plan == plan
    assert updates[-1].messages_done == 2


def test_progress_on_empty_person_does_not_call_model(conn):
    pid = identity.create_person(conn, "No unread messages")
    updates = []
    def never(*args):
        raise AssertionError("No model call for empty history")
    assert extract.extract_person(conn, never, pid, progress=updates.append) == 0
    assert [u.phase for u in updates] == ["start", "done"]
    assert updates[-1].plan.messages == updates[-1].plan.batches == 0


def test_failure_keeps_only_completed_checkpoints_and_resume(conn, monkeypatch):
    pid = setup_messages(conn, monkeypatch)
    updates = []
    calls = []
    def model(system, user):
        calls.append(user)
        if len(calls) == 2:
            raise llm.LLMError("offline")
        return empty_model(system, user)
    with pytest.raises(llm.LLMError):
        extract.extract_person(conn, model, pid, progress=updates.append)
    assert updates[-1].phase == "batch_start" and updates[-1].batch == 2
    assert conn.execute("SELECT sum(extracted) FROM interactions").fetchone()[0] == 1
    resumed = []
    extract.extract_person(conn, empty_model, pid, progress=resumed.append)
    assert resumed[-1].plan.messages == resumed[-1].messages_done == 3


def test_other_worker_skips_advance_progress_without_model_calls(conn, monkeypatch):
    pid = setup_messages(conn, monkeypatch)
    calls = []
    updates = []
    def model(system, user):
        calls.append(user)
        conn.execute("UPDATE interactions SET extracted=1 WHERE person_id=?", (pid,))
        return empty_model(system, user)
    extract.extract_person(conn, model, pid, progress=updates.append)
    assert len(calls) == 1
    assert len([u for u in updates if u.phase == "skipped"]) == 3
    assert updates[-1].messages_done == 4 and updates[-1].skipped == 3
    assert updates[-1].work_done == updates[-1].plan.work


def test_partial_batch_read_by_other_worker_preserves_work_totals(conn, monkeypatch):
    pid = setup_messages(conn, monkeypatch, n=8)
    monkeypatch.setattr(llm, "backend", lambda: llm.Backend("test", "fake", "", 900, True))
    updates = []
    calls = []
    ids = [r[0] for r in conn.execute("SELECT id FROM interactions ORDER BY at")]
    def model(system, user):
        calls.append(user)
        if len(calls) == 1:
            conn.execute("UPDATE interactions SET extracted=1 WHERE id=?", (ids[2],))
        return empty_model(system, user)
    extract.extract_person(conn, model, pid, progress=updates.append)
    assert [u.batch_messages for u in updates if u.phase == "batch_start"] == [2, 1, 2, 2]
    assert updates[-1].skipped == 1 and updates[-1].messages_done == 8
    assert updates[-1].work_done == updates[-1].plan.work
    assert len(calls) == updates[-1].batches_done == 4


def reporter(*, terminal=False, mode="auto", plans=None, width=100, refresh=False, heartbeat=60):
    stream = io.StringIO()
    console = Console(file=stream, force_terminal=terminal, width=width, color_system="standard")
    clock = Clock()
    plan = extract.ExtractionPlan(1, "Ada Lovelace", 30, 3, 120_000)
    progress = ExtractionProgress(plans or [plan], "ds4", "deepseek-v4-flash", mode,
                                  console=console, clock=clock, refresh=refresh, heartbeat_seconds=heartbeat)
    return progress, stream, clock, plan


def cycle(progress, plan, clock, batch, seconds=60):
    base = extract.ExtractionUpdate(plan, "batch_start", batch=batch, messages_done=(batch - 1) * 10,
                                    batches_done=batch - 1, work_done=(batch - 1) * 40_000,
                                    events=batch - 1, batch_messages=10, batch_work=40_000,
                                    first_at="2026-01-01", last_at="2026-01-02")
    progress.update(base)
    clock.tick(seconds)
    done = replace(base, phase="batch_done", messages_done=batch * 10,
                   batches_done=batch, work_done=batch * 40_000, events=batch)
    progress.update(done)
    return done


def test_eta_warms_up_uses_work_and_excludes_skipped_batches():
    p, stream, clock, plan = reporter()
    with p:
        cycle(p, plan, clock, 1)
        assert p.eta() is None
        cycle(p, plan, clock, 2, seconds=120)
        assert p.eta() == pytest.approx(90)
        assert p.eta(person=True) == pytest.approx(90)
        p.update(extract.ExtractionUpdate(plan, "skipped", batch=3, messages_done=30, batches_done=3,
                                         work_done=plan.work, skipped=10))
        assert p.eta() == 0 and len(p.samples) == 2
    assert "ETA ~1m 30s" in stream.getvalue()


def test_live_timer_does_not_fake_inflight_completion(monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("TERM", "xterm-256color")
    p, stream, clock, plan = reporter(terminal=True)
    with p:
        p.update(extract.ExtractionUpdate(plan, "batch_start", batch=1, batch_messages=10, batch_work=40_000))
        clock.tick(3601)
        frame = io.StringIO()
        Console(file=frame, width=100, color_system=None).print(p)
        text = frame.getvalue()
        assert "Model working 1h 00m" in text
        assert "0/30 messages" in text
        assert "need 2 batches" in text
        assert p.totals()["messages_done"] == 0
        assert p.totals()["batches_done"] == 0


@pytest.mark.parametrize("width", [32, 60, 100])
def test_dashboard_narrow_terminals_long_and_untrusted_names(width, monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("TERM", "xterm")
    p, stream, clock, plan = reporter(terminal=True, width=width)
    plan = replace(plan, name="[red]Not markup[/red]\x1b[2J\n" + "Very long name " * 8)
    with p:
        p.update(extract.ExtractionUpdate(plan, "start"))
        cycle(p, plan, clock, 1)
    output = stream.getvalue()
    assert "\x1b[2J" not in output
    assert "PRIVATE_BODY" not in output
    assert "\x1b[?25l" in output and "\x1b[?25h" in output  # cursor restored
    plain = io.StringIO()
    Console(file=plain, width=width).print(p)
    assert max(map(len, plain.getvalue().splitlines())) <= width


@pytest.mark.parametrize("env", [{"TERM": "dumb"}, {"CI": "1"}])
def test_dumb_terminals_and_ci_get_plain_logs(monkeypatch, env):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("TERM", "xterm")
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    p, stream, clock, plan = reporter(terminal=True)
    assert not p.interactive
    with p:
        cycle(p, plan, clock, 1)
    assert "batch 1/3 saved" in stream.getvalue()
    assert "\x1b" not in stream.getvalue()


def test_plain_logs_are_flushable_without_ansi_or_body_text():
    p, stream, clock, plan = reporter()
    with p:
        done = cycle(p, plan, clock, 1)
        p.update(replace(done, phase="done"))
    output = stream.getvalue()
    assert "EXTRACT | ds4" in output
    assert "batch 1/3 saved" in output
    assert "[1/1] Ada Lovelace" in output
    assert "\x1b" not in output


def test_actual_plan_reconciles_work_another_worker_finished():
    p, stream, clock, plan = reporter()
    with p:
        actual = replace(plan, messages=0, batches=0, work=0)
        p.update(extract.ExtractionUpdate(actual, "done"))
        assert p.totals()["messages_total"] == 0
        assert p.totals()["people_done"] == 1
        assert p.eta() == 0


@pytest.mark.parametrize("error,status", [(KeyboardInterrupt, "Paused"), (llm.LLMError, "Stopped")])
def test_interrupted_display_preserves_true_counts_and_stops_thread(error, status, monkeypatch):
    monkeypatch.delenv("CI", raising=False)
    monkeypatch.setenv("TERM", "xterm")
    p, stream, clock, plan = reporter(terminal=True)
    with pytest.raises(error):
        with p:
            cycle(p, plan, clock, 1)
            p.update(extract.ExtractionUpdate(plan, "batch_start", batch=2, messages_done=10,
                                             batches_done=1, work_done=40_000, batch_messages=10))
            raise error()
    assert p.totals()["messages_done"] == 10
    assert status in stream.getvalue() and "rerun the same command" in stream.getvalue()
    assert p.stop_event.is_set()
    assert "\x1b[?25h" in stream.getvalue()


def test_plain_heartbeat_runs_during_model_and_thread_is_joined():
    p, stream, clock, plan = reporter(refresh=True, heartbeat=0.01)
    with p:
        p.update(extract.ExtractionUpdate(plan, "batch_start", batch=1, batch_messages=10))
        clock.tick(120)
        deadline = time.monotonic() + 2
        while "waiting for model 2m 00s" not in stream.getvalue() and time.monotonic() < deadline:
            time.sleep(0.01)
    assert "waiting for model 2m 00s" in stream.getvalue()
    assert p.thread and not p.thread.is_alive()


def test_off_mode_is_silent():
    p, stream, clock, plan = reporter(mode="off")
    with p:
        cycle(p, plan, clock, 1)
    assert stream.getvalue() == ""


def test_cli_plain_and_off_mode(tmp_path, monkeypatch, capsys):
    path = tmp_path / "test.db"
    c = db.connect(path)
    setup_messages(c, monkeypatch, n=2)
    c.close()
    monkeypatch.setattr(cli, "_model", lambda: empty_model)
    cli.main(["--db", str(path), "extract", "--all", "--progress", "plain"])
    out = capsys.readouterr()
    assert "Done. 0 new events." in out.out
    assert "batch 1/2 saved" in out.err and "batch 2/2 saved" in out.err
    assert "\x1b" not in out.err
    c = db.connect(path)
    c.execute("UPDATE interactions SET extracted=0")
    c.commit(); c.close()
    cli.main(["--db", str(path), "extract", "--all", "--progress", "off"])
    out = capsys.readouterr()
    assert "[1/1] Ada Lovelace" in out.out
    assert out.err == ""


def test_cli_interruption_is_130_and_resumable(tmp_path, monkeypatch, capsys):
    path = tmp_path / "test.db"
    c = db.connect(path)
    setup_messages(c, monkeypatch, n=2)
    c.close()
    calls = []
    def model(system, user):
        calls.append(user)
        if len(calls) == 2:
            raise KeyboardInterrupt()
        return empty_model(system, user)
    monkeypatch.setattr(cli, "_model", lambda: model)
    with pytest.raises(SystemExit) as exc:
        cli.main(["--db", str(path), "extract", "--all"])
    assert exc.value.code == 130
    out = capsys.readouterr()
    assert "Paused" in out.err and "Done." not in out.out
    with sqlite3.connect(path) as c:
        assert c.execute("SELECT sum(extracted) FROM interactions").fetchone()[0] == 1


def test_cli_dry_run_and_empty_do_not_start_dashboard_or_call_model(tmp_path, monkeypatch, capsys):
    path = tmp_path / "test.db"
    c = db.connect(path)
    setup_messages(c, monkeypatch, n=1)
    c.close()
    def never():
        raise AssertionError("No model for dry run")
    monkeypatch.setattr(cli, "_model", never)
    cli.main(["--db", str(path), "extract", "--all", "--dry-run"])
    out = capsys.readouterr()
    assert "Ada Lovelace" in out.out and out.err == ""
    with sqlite3.connect(path) as c:
        c.execute("UPDATE interactions SET extracted=1")
    cli.main(["--db", str(path), "extract", "--all"])
    out = capsys.readouterr()
    assert "Nothing new to read" in out.out and out.err == ""


def test_cli_person_and_since_plan_only_selected_history(tmp_path, monkeypatch, capsys):
    path = tmp_path / "test.db"
    c = db.connect(path)
    setup_messages(c, monkeypatch, n=2)
    setup_messages(c, monkeypatch, n=1, name="Grace Hopper")
    c.close()
    monkeypatch.setattr(cli, "_model", lambda: empty_model)
    cli.main(["--db", str(path), "extract", "--person", "Ada Lovelace", "--since", "2026-01-02", "--progress", "plain"])
    out = capsys.readouterr()
    assert "1 messages | 1 batches | 1 people" in out.err
    assert "Grace Hopper" not in out.err
    with sqlite3.connect(path) as c:
        assert c.execute("SELECT sum(extracted) FROM interactions").fetchone()[0] == 1


@pytest.mark.parametrize("error", [KeyboardInterrupt, llm.LLMError])
def test_cli_preparation_failure_is_clean(tmp_path, monkeypatch, capsys, error):
    path = tmp_path / "test.db"
    c = db.connect(path)
    setup_messages(c, monkeypatch, n=1)
    c.close()
    monkeypatch.setattr(cli, "_model", lambda: empty_model)
    def fail(*args, **kwargs):
        raise error("preparation stopped")
    monkeypatch.setattr(extract, "plan_person", fail)
    with pytest.raises(SystemExit) as exc:
        cli.main(["--db", str(path), "extract", "--all"])
    if error is KeyboardInterrupt:
        assert exc.value.code == 130
        assert "rerun" in capsys.readouterr().err.lower()
    else:
        assert "batch preparation" in str(exc.value)
    with sqlite3.connect(path) as c:
        assert c.execute("SELECT sum(extracted) FROM interactions").fetchone()[0] == 0


@pytest.mark.parametrize("seconds,expected", [(0, "0s"), (59, "59s"), (60, "1m 00s"), (3600, "1h 00m"), (90061, "25h 01m")])
def test_long_durations(seconds, expected):
    assert duration(seconds) == expected
