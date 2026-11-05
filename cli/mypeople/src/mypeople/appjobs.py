"""Long-running work for the macOS app: every job is one `mypeople …` child process.

Python can't interrupt a thread, and the Bluetooth listener has to own its main thread, so
imports, extraction, model calls and transfers run as ordinary CLI invocations. Cancelling is
Ctrl-C, so the CLI's own checkpoints and resume behaviour apply unchanged. A crash in a native
extension costs one job, not the app.

`JOBS` is the only way in: the app names a kind and typed parameters, never a command line.
"""

from __future__ import annotations

import os
import re
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Callable

from . import jobevents

GRACE_SECONDS = 8  # after Ctrl-C, before SIGTERM
KILL_SECONDS = 5  # after SIGTERM, before SIGKILL
MAX_LINE = 2000
_ESCAPES = re.compile(r"\x1b\[[0-9;?]*[ -/]*[@-~]|[\x00-\x08\x0b-\x1f\x7f-\x9f]")
IMPORT_SOURCES = ("vcf", "google", "imessage", "whatsapp", "instagram", "mino", "mbox", "gvoice", "snapchat", "linkedin", "twitter", "telegram", "signal")


class JobError(ValueError):
    """The job can't be started as asked. The message is shown to the user."""


def _flags(p: dict, *names: str) -> list[str]:
    return [f"--{n.replace('_', '-')}" for n in names if p.get(n) is True]


def _values(p: dict, *names: str) -> list[str]:
    out: list[str] = []
    for n in names:
        if p.get(n) not in (None, ""):
            out += [f"--{n.replace('_', '-')}", str(p[n])]
    return out


def _repeated(p: dict, name: str, flag: str) -> list[str]:
    values = p.get(name) or []
    if not isinstance(values, list):
        raise JobError(f"{name} must be a list")
    return [part for value in values for part in (flag, str(value))]


def _required(p: dict, name: str) -> str:
    value = p.get(name)
    if not isinstance(value, str) or not value.strip():
        raise JobError(f"{name} is missing")
    return value


def _missing(name: str) -> list[str]:
    raise JobError(f"{name} is missing")


def _person(p: dict, name: str = "person_id") -> list[str]:
    """People are always named by id here, never by a name that could be ambiguous."""
    if p.get(name) is None:
        return []
    if not isinstance(p[name], int):
        raise JobError(f"{name} must be a number")
    return [str(p[name])]


def _person_flag(p: dict) -> list[str]:
    return ["--person", *_person(p)] if p.get("person_id") is not None else []


def _import(p: dict) -> list[str]:
    source = p.get("source")
    if source not in IMPORT_SOURCES:
        raise JobError(f"Unknown import source {source!r}")
    return ["import", source, *([p["path"]] if p.get("path") else []), *_values(p, "since", "names"), *_repeated(p, "me", "--me")]


def _extract(p: dict) -> list[str]:
    return ["extract", "--progress", "plain", *_person_flag(p), *_values(p, "limit", "since"), *_flags(p, "all", "reverse", "dry_run")]


def _socials_find(p: dict) -> list[str]:
    return ["socials", "find", *_person(p), *_values(p, "closest", "autumn_timeout", "osint_timeout", "flaresolverr_timeout"),
            *_flags(p, "again", "autumn", "osint", "osint_only", "flaresolverr"), *_repeated(p, "usernames", "--username")]


def _photos(p: dict) -> list[str]:
    return ["photos", *_values(p, "source"), *([p["path"]] if p.get("path") else []), *_person_flag(p),
            *_values(p, "limit", "delay", "max_failures"), *_flags(p, "dry_run", "again", "browser", "login")]


def _google_sync(p: dict) -> list[str]:
    return ["google", "sync", *_flags(p, "apply", "photos", "no_notes", "create", "show_notes", "show_fields"),
            *_repeated(p, "person_ids", "--person"), *_values(p, "min_messages", "show")]


JOBS: dict[str, Callable[[dict], list[str]]] = {
    "import": _import,
    "extract": _extract,
    # `--` so that text starting with a dash stays text.
    "note": lambda p: ["note", *(_person(p) or _missing("person_id")), "--", _required(p, "text")],
    "ask": lambda p: ["ask", "--", _required(p, "question")],
    "socials_find": _socials_find,
    "photos": _photos,
    "instagram_links": lambda p: ["instagram-links", *_person_flag(p), *_values(p, "limit", "delay"), *_flags(p, "dry_run", "again")],
    "google_login": lambda p: ["google", "login"],
    "google_sync": _google_sync,
    "sync": lambda p: ["sync", *_values(p, "watch"), *_flags(p, "no_enrich", "full")],
    "transfer_qr": lambda p: ["transfer", "qr", "--no-open", *_values(p, "minutes"), *_flags(p, "no_photos", "no_enrich")],
    "transfer_export": lambda p: ["transfer", "export", _required(p, "path"), *_flags(p, "no_photos", "send")],
    "transfer_import": lambda p: ["transfer", "import", _required(p, "path"), *_flags(p, "no_enrich")],
    "transfer_merge": lambda p: ["transfer", "merge", _required(p, "path")],
    "recover_phones": lambda p: ["recover-phones", *_flags(p, "google", "apply")],
    "server_run": lambda p: ["server", "run", *_values(p, "host", "port", "data")],
}
# Not a `mypeople` subcommand: this one must see the Signal Desktop key on the Mac that holds it.
MODULE_JOBS: dict[str, tuple[str, Callable[[dict], list[str]]]] = {
    "signal_export": ("mypeople.importers.signal_export", lambda p: [_required(p, "output")]),
}
# Only one of these can usefully run at a time.
SINGLETONS = {"transfer_qr", "server_run", "google_login"}


def build_argv(kind: str, params: dict, *, db_path: Path, llm: str | None = None) -> list[str]:
    """The full command line for a job, checked against the CLI's real parser."""
    if not isinstance(params, dict):
        raise JobError("Job parameters must be an object")
    if kind in MODULE_JOBS:
        module, build = MODULE_JOBS[kind]
        return [sys.executable, "-m", module, *build(params)]
    if kind not in JOBS:
        raise JobError(f"Unknown job {kind!r}")
    args = JOBS[kind](params)
    prefix = ["--db", str(db_path), *(["--llm", llm] if llm else [])]
    from .cli import build_parser

    try:
        build_parser().parse_args([*prefix, *args])
    except SystemExit:
        raise JobError(f"Those options aren't valid for {kind}.") from None
    return [sys.executable, "-m", "mypeople", *prefix, *args]


def clean(raw: bytes) -> str:
    return _ESCAPES.sub("", raw.decode("utf-8", "replace")).rstrip()[:MAX_LINE]


class _Job:
    def __init__(self, id: int, kind: str, process: subprocess.Popen):
        self.id, self.kind, self.process = id, kind, process
        self.cancelled = False
        self.last_line = ""


class JobRunner:
    def __init__(self, send: Callable[[str, dict], None], db_path: Path, on_finished: Callable[[], None] = lambda: None):
        self.send, self.db_path, self.on_finished = send, db_path, on_finished
        self.jobs: dict[int, _Job] = {}
        self.lock = threading.Lock()
        self.next_id = 1

    def start(self, kind: str, params: dict) -> dict:
        argv = build_argv(kind, params, db_path=self.db_path, llm=os.environ.get("MYPEOPLE_LLM"))
        env = {**os.environ, jobevents.ENV: "1", "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1", "TERM": "dumb", "NO_COLOR": "1"}
        with self.lock:
            if kind in SINGLETONS and any(j.kind == kind for j in self.jobs.values()):
                raise JobError("That's already running.")
            id = self.next_id
            self.next_id += 1
            # A session of its own, so Ctrl-C reaches the job and whatever it started, and not us.
            process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                       env=env, start_new_session=True)
            job = self.jobs[id] = _Job(id, kind, process)
        self.send("job.started", {"id": id, "kind": kind, "params": _public(params)})
        threading.Thread(target=self._pump, args=(job,), name=f"job-{id}", daemon=True).start()
        return {"id": id}

    def _pump(self, job: _Job) -> None:
        for raw in iter(job.process.stdout.readline, b""):
            for part in raw.split(b"\r"):
                line = clean(part)
                if not line:
                    continue
                if (event := jobevents.parse(line)) is not None:
                    self.send("job.progress", {"id": job.id, "event": event})
                else:
                    job.last_line = line
                    self.send("job.output", {"id": job.id, "line": line})
        code = job.process.wait()
        with self.lock:
            self.jobs.pop(job.id, None)
        status = "cancelled" if job.cancelled else "succeeded" if code == 0 else "failed"
        self.send("job.finished", {"id": job.id, "kind": job.kind, "code": code, "status": status, "message": job.last_line})
        self.on_finished()

    def cancel(self, id: int) -> None:
        with self.lock:
            job = self.jobs.get(id)
        if job is None:
            return  # already finished; cancelling twice is harmless
        job.cancelled = True
        self._signal(job, signal.SIGINT)
        threading.Thread(target=self._escalate, args=(job,), daemon=True).start()

    def _escalate(self, job: _Job) -> None:
        for sig, wait in ((signal.SIGTERM, GRACE_SECONDS), (signal.SIGKILL, KILL_SECONDS)):
            try:
                job.process.wait(wait)
                return
            except subprocess.TimeoutExpired:
                self._signal(job, sig)

    @staticmethod
    def _signal(job: _Job, sig: int) -> None:
        try:
            os.killpg(job.process.pid, sig)
        except (ProcessLookupError, PermissionError):
            pass

    def write(self, id: int, text: str) -> None:
        """Answer a job waiting on input, such as a browser sign-in waiting for Enter."""
        with self.lock:
            job = self.jobs.get(id)
        if job is None:
            raise JobError("That job has finished.")
        try:
            job.process.stdin.write(text.encode() + b"\n")
            job.process.stdin.flush()
        except OSError:
            raise JobError("That job has stopped reading input.") from None

    def shutdown(self, timeout: float = GRACE_SECONDS) -> None:
        """The app is going away: ask everything to stop, and don't leave anything behind."""
        with self.lock:
            jobs = list(self.jobs.values())
        for job in jobs:
            job.cancelled = True
            self._signal(job, signal.SIGINT)
        deadline = time.monotonic() + timeout
        for job in jobs:
            try:
                job.process.wait(max(0, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                self._signal(job, signal.SIGKILL)


def _public(params: dict) -> dict:
    """What the Activity list shows. Free text stays out; the screen that asked already has it."""
    return {k: v for k, v in params.items() if k not in ("text", "question")}
