"""Google Voice import from a Google Takeout export (Takeout/Voice).

Texts and voicemails are HTML files marked up with microformats: each text is
a div.message with a timestamp, the sender's number, and the text; voicemails
carry a transcript. Phones.vcf lists the user's own numbers, which is how sent
messages are told apart from received ones. Missed calls and the Spam folder
are skipped.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import re
import sqlite3
from html.parser import HTMLParser
from pathlib import Path

from .. import identity
from .common import add_interaction, resolve_counterpart


class _VoiceParser(HTMLParser):
    """Collects (timestamp, tel, name, text) records from a Voice HTML file."""

    def __init__(self) -> None:
        super().__init__()
        self.records: list[dict[str, str]] = []
        self._record: dict[str, str] | None = None
        self._capture: str | None = None
        self._stack: list[str] = []

    def _start_record(self) -> None:
        self._record = {"at": "", "tel": "", "name": "", "text": ""}
        self.records.append(self._record)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        classes = set((a.get("class") or "").split())
        if tag == "div" and classes & {"message", "haudio"}:
            self._start_record()
        r = self._record
        if r is None:
            self._stack.append("")
            return
        if tag == "abbr" and classes & {"dt", "published"}:
            r["at"] = a.get("title", "")
        elif tag == "a" and "tel" in classes and not r["tel"]:
            r["tel"] = (a.get("href") or "").removeprefix("tel:")
        elif tag == "br" and self._capture == "text":
            r["text"] += "\n"
        if tag == "q" or (tag == "span" and "full-text" in classes):
            self._capture = "text"
        elif tag == "span" and "fn" in classes and not r["name"]:
            self._capture = "name"
        if tag != "br":
            self._stack.append(self._capture or "")

    def handle_endtag(self, tag):
        if tag == "br" or not self._stack:
            return
        self._stack.pop()
        self._capture = self._stack[-1] if self._stack and self._stack[-1] else None

    def handle_data(self, data):
        if self._record is not None and self._capture:
            self._record[self._capture] += data


def parse_file(path: Path) -> list[dict[str, str]]:
    parser = _VoiceParser()
    parser.feed(path.read_text(encoding="utf-8", errors="replace"))
    return [r for r in parser.records if r["at"] and r["tel"]]


def own_numbers(voice_dir: Path) -> set[str]:
    vcf = voice_dir / "Phones.vcf"
    if not vcf.exists():
        return set()
    lines = vcf.read_text(encoding="utf-8", errors="replace").splitlines()
    return {p for line in lines if re.match(r"^(item\d+\.)?TEL", line) if (p := identity.normalize_phone(line.split(":", 1)[1]))}


def _local(timestamp: str) -> str:
    when = dt.datetime.fromisoformat(timestamp)
    if when.tzinfo:
        when = when.astimezone().replace(tzinfo=None)
    return when.isoformat(sep=" ", timespec="seconds")


def import_gvoice(conn: sqlite3.Connection, voice_dir: Path, since: dt.date | None = None) -> dict[str, int]:
    calls_dir = voice_dir / "Calls" if (voice_dir / "Calls").is_dir() else voice_dir
    mine = own_numbers(voice_dir)
    files = sorted(p for p in calls_dir.glob("*.html") if " - Text - " in p.name or " - Voicemail - " in p.name)

    threads = {p: parse_file(p) for p in files}
    stats = {"files": len(files), "interactions": 0, "skipped": 0}

    def counterpart(path: Path, records: list[dict[str, str]]) -> str | None:
        """The other number in a one-to-one thread; None for group threads or short codes."""
        others = {phone for r in records if (phone := identity.normalize_phone(r["tel"])) and phone not in mine}
        if len(others) > 1:
            return None
        if others:
            return next(r["tel"] for r in records if identity.normalize_phone(r["tel"]) in others)
        # Only your own messages: the file is named after the number (or the contact's name).
        named = path.name.split(" - ")[0]
        return named if identity.normalize_phone(named) else None

    partners = {p: counterpart(p, records) for p, records in threads.items()}
    # Someone you've texted is a real relationship; one-way inbound texts are mostly spam.
    written_to = {
        ("phone", identity.normalize_phone(partners[p]))
        for p, records in threads.items()
        if partners[p] and any(identity.normalize_phone(r["tel"]) in mine for r in records)
    }

    for path, records in threads.items():
        voicemail = " - Voicemail - " in path.name
        for r in records:
            at = _local(r["at"])
            sent = identity.normalize_phone(r["tel"]) in mine
            tel = partners[path] if sent else r["tel"]
            if not tel or not identity.normalize_phone(tel) or (since and at[:10] < since.isoformat()):
                stats["skipped"] += 1
                continue
            name = None if sent else r["name"].strip() or None
            text = " ".join(r["text"].split()) if voicemail else r["text"].strip()
            text = (f"(voicemail) {text}" if voicemail and text else text) or None
            person_id = resolve_counterpart(conn, tel, name, "gvoice", written_to)
            digest = hashlib.sha1(f"{r['at']}|{r['tel']}|{r['text']}".encode()).hexdigest()[:12]
            if person_id and add_interaction(
                conn, person_id, at, "voicemail" if voicemail else "gvoice", "out" if sent else "in", text, None, f"gvoice:{digest}"
            ):
                stats["interactions"] += 1
            else:
                stats["skipped"] += 1
    conn.commit()
    return stats
