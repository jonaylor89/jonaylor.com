import datetime as dt
import sqlite3

import pytest

from mypeople import db
from mypeople.importers.imessage import to_apple_time


@pytest.fixture(autouse=True)
def verify_graph_index(monkeypatch):
    """Every test checks the persistent index against a full replay after each write, and
    every scoped projection against a full one. Engines started as child processes inherit it."""
    monkeypatch.setenv("MYPEOPLE_GRAPH_VERIFY", "1")


@pytest.fixture
def conn():
    c = db.connect(":memory:")
    yield c
    c.close()


VCF = """BEGIN:VCARD
VERSION:3.0
FN:Marcus Lee
N:Lee;Marcus;;;
TEL;type=CELL:+1 (555) 123-4567
EMAIL;type=INTERNET:Marcus@Example.com
BDAY:1990-10-25
ORG:Acme Corp;
TITLE:Designer
item1.ADR;type=HOME:;;1 Main St;Austin;TX;78701;USA
END:VCARD
BEGIN:VCARD
VERSION:3.0
N:Shah;Priya;;;
TEL:555 987 6543
BDAY;X-APPLE-OMIT-YEAR=1604:1604-10-23
NOTE:Met at the conference\\, 2019
END:VCARD
BEGIN:VCARD
VERSION:3.0
FN:No Phone Person
END:VCARD
"""


@pytest.fixture
def vcf_path(tmp_path):
    p = tmp_path / "contacts.vcf"
    p.write_text(VCF)
    return p


def _attributed_body(text: str) -> bytes:
    data = text.encode()
    if len(data) < 0x80:
        length = bytes([len(data)])
    else:
        length = b"\x81" + len(data).to_bytes(2, "little")
    return b"\x04\x0bstreamtyped\x81\xe8\x03\x84\x01@\x84\x84\x84\x12NSAttributedString\x00\x84\x84\x08NSObject\x00\x85\x92\x84\x84\x84\x08NSString\x01\x94\x84\x01+" + length + data + b"\x86\x84"


def make_chat_db(path, messages):
    """messages: (guid, handle, chat_identifier, style, is_from_me, when, text, use_attributed_body)"""
    c = sqlite3.connect(path)
    c.executescript(
        """
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, guid TEXT, chat_identifier TEXT, style INTEGER);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, guid TEXT, text TEXT, attributedBody BLOB, date INTEGER,
            is_from_me INTEGER, handle_id INTEGER, associated_message_type INTEGER DEFAULT 0, item_type INTEGER DEFAULT 0);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        """
    )
    handles, chats = {}, {}
    for guid, handle, chat_id, style, from_me, when, text, attributed in messages:
        if handle and handle not in handles:
            handles[handle] = c.execute("INSERT INTO handle (id) VALUES (?)", (handle,)).lastrowid
        if chat_id not in chats:
            chats[chat_id] = c.execute(
                "INSERT INTO chat (guid, chat_identifier, style) VALUES (?, ?, ?)", (f"chat-{chat_id}", chat_id, style)
            ).lastrowid
        mid = c.execute(
            "INSERT INTO message (guid, text, attributedBody, date, is_from_me, handle_id) VALUES (?, ?, ?, ?, ?, ?)",
            (
                guid,
                None if attributed else text,
                _attributed_body(text) if attributed else None,
                to_apple_time(when),
                int(from_me),
                handles.get(handle, 0) if not from_me or style == 43 else (handles.get(handle) or 0),
            ),
        ).lastrowid
        c.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chats[chat_id], mid))
    c.commit()
    c.close()


def at(day: str, hour: int = 12) -> dt.datetime:
    return dt.datetime.fromisoformat(f"{day}T{hour:02d}:00:00").astimezone()
