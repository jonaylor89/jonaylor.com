"""Structured progress for a parent process: the macOS app's engine.

Silent unless the parent asks for it, so normal CLI output never changes. Events carry
counts and display names only, never message text or credentials.
"""

from __future__ import annotations

import json
import os
import sys

PREFIX = "@@mypeople-job "
ENV = "MYPEOPLE_JOB_EVENTS"


def emit(kind: str, **fields) -> None:
    if os.environ.get(ENV):
        print(PREFIX + json.dumps({"kind": kind, **fields}, ensure_ascii=False), file=sys.stdout, flush=True)


def parse(line: str) -> dict | None:
    """The event a line of job output carries, or None for ordinary text."""
    if not line.startswith(PREFIX):
        return None
    try:
        event = json.loads(line[len(PREFIX):])
    except ValueError:
        return None
    return event if isinstance(event, dict) else None
