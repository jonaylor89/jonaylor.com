"""WhatsApp import, read from WhatsApp Desktop's local stores on macOS.

Chats live in ChatStorage.sqlite and calls in CallHistory.sqlite. Newer chats
identify people by a privacy "LID" instead of a phone number; WhatsApp's own
ContactsV2.sqlite maps the LIDs of address-book contacts back to numbers.
Reading the group container requires Full Disk Access, like iMessage.
"""

from __future__ import annotations

import datetime as dt
import sqlite3
from pathlib import Path

from .. import identity
from .common import add_interaction, resolve_counterpart
from .imessage import apple_time

DEFAULT_DIR = Path.home() / "Library" / "Group Containers" / "group.net.whatsapp.WhatsApp.shared"
DIRECT, GROUP = 0, 1
# System notices, call notices, and deleted messages aren't conversation.
SKIP_TYPES = (6, 10, 14)

MESSAGES = f"""
SELECT m.Z_PK, m.ZSTANZAID, m.ZMESSAGEDATE, m.ZISFROMME, m.ZTEXT, m.ZPUSHNAME,
       s.ZSESSIONTYPE, s.ZCONTACTJID, s.ZCONTACTIDENTIFIER, s.ZPARTNERNAME, g.ZMEMBERJID, g.ZCONTACTNAME
FROM ZWAMESSAGE m
JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION
LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK = m.ZGROUPMEMBER
WHERE s.ZSESSIONTYPE IN ({DIRECT}, {GROUP})
  AND m.ZMESSAGETYPE NOT IN ({", ".join(map(str, SKIP_TYPES))})
  AND m.ZMESSAGEDATE >= ?
ORDER BY m.ZMESSAGEDATE
"""

CALLS = """
SELECT e.Z_PK, e.ZCALLIDSTRING, e.ZDATE, e.ZDURATION, a.ZINCOMING, p.ZJIDSTRING
FROM ZWACDCALLEVENT e
JOIN ZWAAGGREGATECALLEVENT a ON a.Z_PK = e.Z1CALLEVENTS
JOIN ZWACDCALLEVENTPARTICIPANT p ON p.Z1PARTICIPANTS = e.Z_PK
WHERE e.ZDURATION > 0 AND e.ZDATE >= ?
ORDER BY e.ZDATE
"""


class Directory:
    """Turns WhatsApp JIDs (phone-based or LID) into phone numbers and names."""

    def __init__(self, contacts_db: Path):
        self.phones: dict[str, str] = {}
        self.names: dict[str, str] = {}
        if not contacts_db.exists():
            return
        src = sqlite3.connect(f"file:{contacts_db}?mode=ro", uri=True)
        for lid, wa_id, name in src.execute("SELECT ZLID, ZWHATSAPPID, ZFULLNAME FROM ZWAADDRESSBOOKCONTACT"):
            for jid in (lid, wa_id):
                if jid:
                    if wa_id:
                        self.phones[jid] = wa_id
                    if name:
                        self.names[jid] = name
        src.close()

    def phone(self, *jids: str | None) -> str | None:
        """'+<number>' for the first JID that resolves to a phone number."""
        for jid in jids:
            if not jid:
                continue
            phone_jid = jid if jid.endswith("@s.whatsapp.net") else self.phones.get(jid)
            if phone_jid:
                return "+" + phone_jid.split("@")[0]
        return None

    def name(self, *candidates: str | None) -> str | None:
        for c in candidates:
            if c and (c in self.names or "@" not in c):
                return self.names.get(c, c)
        return None


def _when(apple_seconds: float) -> str:
    return apple_time(int(apple_seconds)).isoformat(sep=" ", timespec="seconds")


def import_whatsapp(conn: sqlite3.Connection, root: Path = DEFAULT_DIR, since: dt.date | None = None) -> dict[str, int]:
    directory = Directory(root / "ContactsV2.sqlite")
    since_apple = (dt.datetime.combine(since or dt.date(2001, 1, 2), dt.time()).astimezone() - dt.datetime(2001, 1, 1, tzinfo=dt.timezone.utc)).total_seconds()

    chats = sqlite3.connect(f"file:{root / 'ChatStorage.sqlite'}?mode=ro", uri=True)
    chats.row_factory = sqlite3.Row
    rows = chats.execute(MESSAGES, (since_apple,)).fetchall()
    chats.close()
    calls: list[sqlite3.Row] = []
    if (root / "CallHistory.sqlite").exists():
        history = sqlite3.connect(f"file:{root / 'CallHistory.sqlite'}?mode=ro", uri=True)
        history.row_factory = sqlite3.Row
        calls = history.execute(CALLS, (since_apple,)).fetchall()
        history.close()

    # A real relationship: someone you've messaged or called directly.
    written_to = {
        identity.normalize_handle(p)
        for r in rows
        if r["ZISFROMME"] and r["ZSESSIONTYPE"] == DIRECT
        if (p := directory.phone(r["ZCONTACTIDENTIFIER"], r["ZCONTACTJID"]))
    } | {identity.normalize_handle(p) for r in calls if not r["ZINCOMING"] if (p := directory.phone(r["ZJIDSTRING"]))}

    stats = {"messages": len(rows), "calls": len(calls), "interactions": 0, "skipped": 0}
    for r in rows:
        phone = name = thread = None
        if r["ZSESSIONTYPE"] == DIRECT:
            phone = directory.phone(r["ZCONTACTIDENTIFIER"], r["ZCONTACTJID"])
            name = directory.name(r["ZCONTACTIDENTIFIER"], r["ZCONTACTJID"], r["ZPARTNERNAME"])
        elif not r["ZISFROMME"]:  # your own group messages aren't with anyone in particular
            phone = directory.phone(r["ZMEMBERJID"])
            name = directory.name(r["ZMEMBERJID"], r["ZCONTACTNAME"], r["ZPUSHNAME"])
            thread = "group chat"
        person_id = phone and resolve_counterpart(conn, phone, name, "whatsapp", written_to)
        ref = f"whatsapp:{r['ZCONTACTJID']}:{r['ZSTANZAID'] or r['Z_PK']}"
        text = (r["ZTEXT"] or "").strip() or None
        if person_id and add_interaction(
            conn, person_id, _when(r["ZMESSAGEDATE"]), "whatsapp", "out" if r["ZISFROMME"] else "in", text, thread, ref
        ):
            stats["interactions"] += 1
        else:
            stats["skipped"] += 1

    for r in calls:
        phone = directory.phone(r["ZJIDSTRING"])
        person_id = phone and resolve_counterpart(conn, phone, directory.name(r["ZJIDSTRING"]), "whatsapp", written_to)
        ref = f"whatsapp-call:{r['ZCALLIDSTRING'] or r['Z_PK']}:{r['ZJIDSTRING']}"
        if person_id and add_interaction(
            conn, person_id, _when(r["ZDATE"]), "whatsapp-call", "in" if r["ZINCOMING"] else "out", None, None, ref
        ):
            stats["interactions"] += 1
        else:
            stats["skipped"] += 1
    conn.commit()
    return stats
