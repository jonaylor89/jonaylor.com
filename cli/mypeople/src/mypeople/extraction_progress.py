"""A small, checkpoint-aware extraction dashboard; no message bodies or model IO.

The main thread sends immutable updates. Rich's refresh thread only renders
those snapshots, so SQLite connections never cross threads. Non-TTY runs get
flushed, timestamped batch logs and an occasional in-flight heartbeat instead.
"""
from __future__ import annotations

from collections import deque
import os
import re
import threading
import time
from typing import Callable

from rich.console import Console, Group
from rich.live import Live
from rich.progress_bar import ProgressBar
from rich.spinner import Spinner
from rich.table import Table
from rich.text import Text

from . import jobevents
from .extract import ExtractionPlan, ExtractionUpdate

ACCENT = "#67d5cf"
WARM = "#edbd76"
MUTED = "grey62"
_CONTROLS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


def safe(value: str) -> str:
    return _CONTROLS.sub(" ", value)


def duration(seconds: float) -> str:
    seconds = max(0, int(seconds))
    hours, rest = divmod(seconds, 3600)
    minutes, seconds = divmod(rest, 60)
    if hours:
        return f"{hours}h {minutes:02d}m"
    return f"{minutes}m {seconds:02d}s" if minutes else f"{seconds}s"


class ExtractionProgress:
    def __init__(
        self, plans: list[ExtractionPlan], backend: str, model: str, mode: str = "auto", *,
        console: Console | None = None, clock: Callable[[], float] = time.monotonic,
        refresh: bool = True, heartbeat_seconds: float = 60,
    ):
        self.console = console or Console(stderr=True)
        self.clock = clock
        self.mode = mode
        self.enabled = mode != "off"
        self.interactive = (self.enabled and mode != "plain" and self.console.is_terminal
                            and os.environ.get("TERM") != "dumb" and not os.environ.get("CI"))
        self.backend, self.model = safe(backend), safe(model)
        self.states = {p.person_id: ExtractionUpdate(p, "start") for p in plans}
        self.current: ExtractionUpdate | None = None
        self.started = clock()
        self.batch_started: float | None = None
        self.stopped_at: float | None = None
        self.status = "running"
        self.samples: deque[tuple[int, float]] = deque(maxlen=8)
        self.refresh = refresh
        self.heartbeat_seconds = heartbeat_seconds
        self.stop_event = threading.Event()
        self.thread: threading.Thread | None = None
        self.live: Live | None = None
        self.spinner = Spinner("dots", style=WARM)
        self.previous_events = 0

    def __enter__(self):
        self.started = self.clock()
        if self.interactive:
            self.live = Live(self, console=self.console, refresh_per_second=4,
                             auto_refresh=self.refresh, redirect_stdout=False, redirect_stderr=False)
            self.live.start(refresh=True)
        elif self.enabled:
            totals = self.totals()
            self._log(f"EXTRACT | {self.backend} / {self.model} | {totals['messages_total']:,} messages | "
                      f"{totals['batches_total']:,} batches | {totals['people_total']} people")
            if self.refresh:
                self.thread = threading.Thread(target=self._heartbeat, name="extraction-progress", daemon=True)
                self.thread.start()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.status = "complete" if exc_type is None else "paused" if issubclass(exc_type, KeyboardInterrupt) else "failed"
        self.stopped_at = self.clock()
        self.stop_event.set()
        if self.thread:
            self.thread.join()
        if self.live:
            self.live.refresh()
            self.live.stop()
        if self.enabled and exc_type is not None:
            self._log(f"{'Paused' if self.status == 'paused' else 'Stopped'}. Completed batches are saved; "
                      "rerun the same command to resume. The in-flight batch may need to be retried.")
        return False

    def totals(self) -> dict[str, int]:
        states = list(self.states.values())
        return {
            "messages_total": sum(s.plan.messages for s in states),
            "messages_done": sum(s.messages_done for s in states),
            "batches_total": sum(s.plan.batches for s in states),
            "batches_done": sum(s.batches_done for s in states),
            "people_total": len(states),
            "people_done": sum(s.phase == "done" for s in states),
            "events": sum(s.events for s in states),
            "skipped": sum(s.skipped for s in states),
            "work_left": sum(max(0, s.plan.work - s.work_done) for s in states),
        }

    def eta(self, *, person: bool = False) -> float | None:
        totals = self.totals()
        work_left = max(0, self.current.plan.work - self.current.work_done) if person and self.current else totals["work_left"]
        if not work_left:
            return 0.0
        if len(self.samples) < 2:
            return None
        work = sum(w for w, _ in self.samples)
        seconds = sum(s for _, s in self.samples)
        if work <= 0 or seconds <= 0:
            return None
        estimate = work_left * seconds / work
        # Don't let the ETA fall to zero while a slow call is still in flight.
        if self.batch_started is not None and self.current:
            elapsed = (self.stopped_at if self.stopped_at is not None else self.clock()) - self.batch_started
            expected = self.current.batch_work * seconds / work
            estimate += max(0, elapsed - expected)
        return estimate

    def update(self, event: ExtractionUpdate) -> None:
        if not self.enabled:
            return
        now = self.clock()
        if event.phase == "start":
            self.previous_events = 0
        elif event.phase == "batch_start":
            self.batch_started = now
        elif event.phase == "batch_done":
            if self.batch_started is not None:
                self.samples.append((event.batch_work, max(0, now - self.batch_started)))
            self.batch_started = None
        self.states[event.plan.person_id] = event  # reconcile estimates with actual unread work
        self.current = event
        jobevents.emit("extract", phase=event.phase, person=safe(event.plan.name), person_id=event.plan.person_id,
                       batch=event.batch, batches=event.plan.batches, eta=self.eta(), **self.totals())
        if event.phase == "done":
            totals = self.totals()
            text = (f"[{totals['people_done']}/{totals['people_total']}] {safe(event.plan.name)}: "
                    f"{event.events} new events | {event.messages_done:,} messages read")
            if self.interactive:
                self.console.print(Text(text, style=ACCENT))
            else:
                self._log(text)
        elif not self.interactive:
            prefix = f"{safe(event.plan.name)} | batch {event.batch}/{event.plan.batches}"
            if event.phase == "batch_start":
                self._log(f"{prefix} | model working on {event.batch_messages:,} messages | "
                          f"{event.first_at[:10]} to {event.last_at[:10]}")
            elif event.phase == "batch_done":
                totals = self.totals()
                added = event.events - self.previous_events
                self._log(f"{prefix} saved | {event.messages_done:,}/{event.plan.messages:,} messages | "
                          f"+{added} events | run {totals['messages_done']:,}/{totals['messages_total']:,} | {self._timing()}")
            elif event.phase == "skipped":
                self._log(f"{prefix} | already read by another worker")
        if event.phase == "batch_done":
            self.previous_events = event.events

    def _timing(self) -> str:
        elapsed = (self.stopped_at if self.stopped_at is not None else self.clock()) - self.started
        eta = self.eta()
        remaining = "estimating ETA (need 2 batches)" if eta is None else f"ETA ~{duration(eta)}"
        if self.status in ("paused", "failed"):
            remaining = "resume to continue"
        last = f" | last batch {duration(self.samples[-1][1])}" if self.samples else ""
        return f"elapsed {duration(elapsed)} | {remaining}{last}"

    def _log(self, text: str) -> None:
        # Text, never markup: imported names cannot inject Rich formatting or ANSI.
        self.console.print(Text(f"{time.strftime('%H:%M:%S')}  {safe(text)}"), soft_wrap=True, highlight=False)
        self.console.file.flush()

    def _heartbeat(self) -> None:
        while not self.stop_event.wait(self.heartbeat_seconds):
            event = self.current
            if event and event.phase in ("batch_start", "saving") and self.batch_started is not None:
                self._log(f"{safe(event.plan.name)} | batch {event.batch}/{event.plan.batches} | "
                          f"{'saving' if event.phase == 'saving' else 'waiting for model'} "
                          f"{duration(self.clock() - self.batch_started)} | {self._timing()}")

    def _bar(self, label: str, done: int, total: int) -> Table:
        table = Table.grid(expand=True, padding=(0, 1))
        table.add_column(width=6, style=MUTED)
        table.add_column(ratio=1)
        table.add_column(width=5, justify="right", style=ACCENT)
        fraction = min(1, done / total) if total else 1
        table.add_row(label, ProgressBar(total=max(1, total), completed=done if total else fraction,
                                        complete_style=ACCENT, finished_style=ACCENT, style="grey23"),
                      f"{fraction:.0%}")
        return table

    def __rich__(self) -> Group:
        totals = self.totals()
        heading = Text.assemble(("MYPEOPLE", f"bold {ACCENT}"), (" / EXTRACTION", "bold"),
                                (f"   {self.backend} · {self.model}", MUTED))
        summary = Text(f"{totals['messages_done']:,}/{totals['messages_total']:,} messages  ·  "
                       f"{totals['batches_done']:,}/{totals['batches_total']:,} batches  ·  "
                       f"{totals['people_done']}/{totals['people_total']} people  ·  {totals['events']} new events", style=MUTED)
        rows = [heading, self._bar("RUN", totals["messages_done"], totals["messages_total"]), summary, Text("")]
        event = self.current
        if event:
            rows.append(Text(safe(event.plan.name), style="bold"))
            rows.append(self._bar("PERSON", event.messages_done, event.plan.messages))
            person_eta = self.eta(person=True)
            remaining = f"  ·  ~{duration(person_eta)} left" if person_eta is not None and self.status == "running" else ""
            rows.append(Text(f"{event.messages_done:,}/{event.plan.messages:,} messages  ·  "
                             f"batch {event.batch}/{event.plan.batches}  ·  {event.events} new events{remaining}", style=MUTED))
            if self.status == "running" and event.phase in ("batch_start", "saving"):
                elapsed = self.clock() - self.batch_started if self.batch_started is not None else 0
                phase = "Saving checkpoint" if event.phase == "saving" else "Model working"
                self.spinner.text = Text(f"{phase} {duration(elapsed)}  ·  {event.batch_messages:,} messages  ·  "
                                         f"{event.first_at[:10]} → {event.last_at[:10]}", style=WARM)
                rows.append(self.spinner)
            else:
                phase = {"complete": "Complete", "paused": "Paused", "failed": "Stopped"}.get(self.status, "Checkpoint saved")
                rows.append(Text(phase, style=ACCENT if self.status in ("running", "complete") else WARM))
        rows.append(Text(self._timing().replace(" | ", "  ·  "), style=MUTED))
        hint = "Saved after each batch · Ctrl-C to pause safely"
        if totals["skipped"]:
            hint += f" · {totals['skipped']:,} messages read by another worker"
        rows.append(Text(hint, style="dim"))
        return Group(*rows)
