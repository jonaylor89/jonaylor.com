"""Recover lost dialing details from read-only source metadata, never suffix-only matches.

A Google resource ID, unique email, or exact imported message/call reference proves
which existing person a source belongs to. The old ten-digit key is ONLY a
consistency check after that link, not a way to assign people. No message bodies,
source contact writes, person creation, merges, or inferred facts are involved.
"""
from __future__ import annotations

import copy
import datetime as dt
import json
import os
import re
import sqlite3
from collections import Counter, defaultdict
from contextlib import contextmanager
from functools import lru_cache
from pathlib import Path

import phonenumbers

from . import contacts


@contextmanager
def readonly(path: Path):
    conn = sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    try:
        yield conn
    finally:
        conn.close()


@lru_cache(maxsize=8192)
def international(raw: str) -> str:
    raw = raw.strip()
    if not raw.lower().startswith(("+", "tel:+")):
        return ""  # Never infer the country of a historical matching key.
    number, extension = contacts.phone(raw)
    return number + (";ext=" + extension if extension else "") if number else ""


def legacy_key(raw: str) -> str:
    return re.sub(r"\D", "", raw)[-10:]


class Sources:
    def __init__(self, conn: sqlite3.Connection):
        self.people = {r["id"]: dict(r) for r in conn.execute("SELECT * FROM people")}
        self.ids: dict[tuple[str, str], set[int]] = defaultdict(set)
        self.phones: dict[int, set[str]] = defaultdict(set)
        self.identifier_rows: dict[int, list[list[str]]] = defaultdict(list)
        self.key_rows: dict[int, list[list[str]]] = defaultdict(list)
        for r in conn.execute("SELECT person_id,kind,value FROM contact_keys"):
            self.key_rows[r["person_id"]].append([r["kind"], r["value"]])
        for r in conn.execute("SELECT * FROM identifiers"):
            self.identifier_rows[r["person_id"]].append([r["kind"], r["value"], r["source"]])
            pid = self.canonical(r["person_id"])
            if pid is not None:
                self.ids[r["kind"], r["value"].lower().strip()].add(pid)
                if r["kind"] == "phone":
                    self.phones[pid].add(r["value"])
        self.refs = {r["source_ref"]: pid for r in conn.execute(
            "SELECT person_id,source_ref FROM interactions WHERE channel IN ('imessage','whatsapp','whatsapp-call')"
        ) if (pid := self.canonical(r["person_id"])) is not None}
        self.evidence: dict[tuple[int, str], list[dict]] = defaultdict(list)
        self.warnings: list[str] = []
        self.blocked: set[int] = set()

    def canonical(self, pid: int) -> int | None:
        seen = set()
        while pid in self.people and pid not in seen:
            seen.add(pid)
            row = self.people[pid]
            if row["merged_into"] is None:
                return None if row["is_me"] or row["trashed"] else pid
            pid = row["merged_into"]
        return None

    def owner(self, identifiers: list[tuple[str, str]]) -> int | None:
        matches = set().union(*(self.ids.get((kind, value.strip().lower()), set()) for kind, value in identifiers))
        return next(iter(matches)) if len(matches) == 1 else None

    def add(self, pid: int | None, raw: str, source: str, ref: str, *, canonical: str = "", label: str = "") -> None:
        if pid is None:
            return
        full = international(canonical) or international(raw)
        if not full:
            return
        # Canonical metadata may omit an extension present in the original value.
        if canonical:
            base, _, extension = full.partition(";ext=")
            region = phonenumbers.region_code_for_number(phonenumbers.parse(base, None))
            raw_base, raw_extension = contacts.phone(raw, region)
            if (international(raw) and raw_base != base) or (extension and raw_extension and extension != raw_extension):
                self.warnings.append(f"Contradictory {source} phone metadata for person {pid}")
                self.blocked.add(pid)
                return
            if raw_base == base and raw_extension:
                full = base + ";ext=" + raw_extension
        item = {"source": source, "ref": ref, "raw": raw, "value": full, "label": label}
        previous = self.evidence[pid, full]
        # Bound repeated message references; retain independent source corroboration.
        if sum(e["source"] == source for e in previous) < 3 and item not in previous:
            previous.append(item)

    def google(self, records: list[dict]) -> None:
        email_owners: dict[str, set[str]] = defaultdict(set)
        for record in records:
            for field in record.get("emailAddresses", []):
                email_owners[field.get("value", "").lower().strip()].add(record.get("resourceName", ""))
        for record in records:
            ids = [("google", record.get("resourceName", ""))]
            ids += [("email", f.get("value", "")) for f in record.get("emailAddresses", [])
                    if len(email_owners[f.get("value", "").lower().strip()]) == 1]
            pid = self.owner(ids)
            for field in record.get("phoneNumbers", []):
                self.add(pid, field.get("value", ""), "google", record.get("resourceName", ""),
                         canonical=field.get("canonicalForm", ""), label=field.get("type", ""))

    def imessage(self, path: Path) -> None:
        with readonly(path) as source:
            # Deliberately exclude text/attributedBody and attachment data.
            rows = source.execute("""SELECT m.guid,m.is_from_me,h.id AS handle,c.chat_identifier,c.style
                FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id
                LEFT JOIN chat_message_join j ON j.message_id=m.ROWID
                LEFT JOIN chat c ON c.ROWID=j.chat_id""")
            for row in rows:
                ref = "imessage:" + row["guid"]
                if row["style"] == 43:
                    raw = None if row["is_from_me"] else row["handle"]
                else:
                    raw = row["handle"] or row["chat_identifier"]
                if raw:
                    self.add(self.refs.get(ref), raw, "imessage", ref)

    def whatsapp(self, root: Path) -> None:
        directory = {}
        path = root / "ContactsV2.sqlite"
        if path.exists():
            with readonly(path) as source:
                for row in source.execute("SELECT ZLID,ZWHATSAPPID FROM ZWAADDRESSBOOKCONTACT"):
                    if row["ZLID"] and row["ZWHATSAPPID"]:
                        directory[row["ZLID"]] = row["ZWHATSAPPID"]

        def phone(*jids):
            for jid in jids:
                jid = directory.get(jid, jid) or ""
                match = re.fullmatch(r"([1-9]\d{6,14})(?::\d+)?@s\.whatsapp\.net", jid)
                if match:
                    return "+" + match[1]
            return ""

        path = root / "ChatStorage.sqlite"
        if path.exists():
            with readonly(path) as source:
                for row in source.execute("""SELECT m.Z_PK,m.ZSTANZAID,m.ZISFROMME,s.ZSESSIONTYPE,
                        s.ZCONTACTJID,s.ZCONTACTIDENTIFIER,g.ZMEMBERJID
                    FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK=m.ZCHATSESSION
                    LEFT JOIN ZWAGROUPMEMBER g ON g.Z_PK=m.ZGROUPMEMBER"""):
                    ref = f"whatsapp:{row['ZCONTACTJID']}:{row['ZSTANZAID'] or row['Z_PK']}"
                    raw = phone(row["ZCONTACTIDENTIFIER"], row["ZCONTACTJID"]) if row["ZSESSIONTYPE"] == 0 else (
                        phone(row["ZMEMBERJID"]) if not row["ZISFROMME"] and row["ZSESSIONTYPE"] == 1 else "")
                    self.add(self.refs.get(ref), raw, "whatsapp", ref)
        path = root / "CallHistory.sqlite"
        if path.exists():
            with readonly(path) as source:
                for row in source.execute("""SELECT e.Z_PK,e.ZCALLIDSTRING,p.ZJIDSTRING
                    FROM ZWACDCALLEVENT e JOIN ZWACDCALLEVENTPARTICIPANT p ON p.Z1PARTICIPANTS=e.Z_PK"""):
                    ref = f"whatsapp-call:{row['ZCALLIDSTRING'] or row['Z_PK']}:{row['ZJIDSTRING']}"
                    self.add(self.refs.get(ref), phone(row["ZJIDSTRING"]), "whatsapp-call", ref)

    def addressbook(self, path: Path) -> None:
        with readonly(path) as source:
            # Emails are unique identity anchors; names and suffixes never are.
            emails: dict[int, list[tuple[str, str]]] = defaultdict(list)
            for row in source.execute("SELECT ZOWNER,ZADDRESS FROM ZABCDEMAILADDRESS"):
                if row["ZADDRESS"]:
                    emails[row["ZOWNER"]].append(("email", row["ZADDRESS"]))
            shared = {row[0].strip().lower() for row in source.execute(
                "SELECT ZADDRESS FROM ZABCDEMAILADDRESS WHERE ZADDRESS IS NOT NULL GROUP BY lower(trim(ZADDRESS)) HAVING count(DISTINCT ZOWNER)>1")}
            for row in source.execute("SELECT Z_PK,ZOWNER,ZFULLNUMBER,ZLABEL FROM ZABCDPHONENUMBER"):
                self.add(self.owner([(kind, value) for kind, value in emails[row["ZOWNER"]] if value.lower().strip() not in shared]), row["ZFULLNUMBER"] or "", "mac-contacts",
                         f"{path.parent.name}:{row['Z_PK']}", label=row["ZLABEL"] or "")

    def plan(self, *, excluded_uids: set[str] | None = None) -> dict:
        changes, unresolved, ambiguous = [], [], []
        excluded_uids = excluded_uids or set()
        source_counts = Counter()
        for pid, keys in sorted(self.phones.items()):
            person = self.people[pid]
            card = contacts.card_for(person)
            if pid in self.blocked:
                unresolved.extend({"id": pid, "key": key, "reason": "Contradictory source metadata"} for key in sorted(keys))
                continue
            if (card is not None and not card.get("legacy_unverified")) or person["contact_uid"] in excluded_uids:
                continue  # Never resurrect a phone removed from a verified/manual card.
            candidates: dict[str, dict[str, list]] = defaultdict(dict)
            for (owner, full), evidence in self.evidence.items():
                if owner != pid:
                    continue
                for key in keys:
                    known = international(key)
                    consistent = (known.split(";ext=")[0] == full.split(";ext=")[0]) if known else (
                        legacy_key(key) == legacy_key(full.split(";ext=")[0]) or any(
                            legacy_key(key) == legacy_key(e["raw"]) for e in evidence))
                    if consistent:
                        candidates[key][full] = evidence
            recovered: dict[str, list] = {}
            resolved_keys = set()
            for key in sorted(keys):
                choices = candidates[key]
                # An explicit existing identifier is itself lossless evidence.
                full = international(key)
                if not choices and full:
                    choices[full] = [{"source": "identifier", "ref": str(pid), "raw": key, "value": full, "label": ""}]
                bases = {v.split(";ext=")[0] for v in choices}
                if len(bases) == 1:
                    # A bare message address corroborates an extension-bearing
                    # contact number; it does not contradict that extension.
                    extended = {v: e for v, e in choices.items() if ";ext=" in v}
                    selected = extended or choices
                    for value, evidence in selected.items():
                        recovered.setdefault(value, []).extend(evidence + [e for v, items in choices.items() if v not in selected for e in items])
                    resolved_keys.add(key)
                elif choices:
                    ambiguous.append({"id": pid, "key": key, "choices": choices})
                else:
                    unresolved.append({"id": pid, "key": key})
            if not recovered:
                continue
            # Preserve every non-phone detail and all unrepairable original hints.
            updated = copy.deepcopy(card) if card is not None else {
                "name": person["name"], "fields": [{"kind": "email", "value": value, "label": ""}
                    for (kind, value), owners in self.ids.items() if kind == "email" and pid in owners]
            }
            old_fields = updated.get("fields", [])
            retained = [f for f in old_fields if f.get("kind") != "phone" or not (
                f["value"] in recovered or (not international(f["value"]) and any(
                    legacy_key(f["value"]) == legacy_key(key) for key in resolved_keys)))]
            for value, evidence in sorted(recovered.items()):
                previous = next((f for f in old_fields if f.get("kind") == "phone" and (
                    f["value"] == value or (not international(f["value"]) and any(
                        legacy_key(f["value"]) == legacy_key(e["raw"]) or legacy_key(f["value"]) == legacy_key(value.split(";ext=")[0])
                        for e in evidence)))), {})
                field = previous | {"kind": "phone", "value": value}
                field.setdefault("label", next((e["label"] for e in evidence if e["label"]), ""))
                retained.append(field)
                source_counts.update({e["source"] for e in evidence})
            if card is None:
                retained += [{"kind": "phone", "value": key, "label": "Unverified legacy number"} for key in sorted(keys - resolved_keys)]
            if sorted(json.dumps(f, sort_keys=True) for f in retained) == sorted(json.dumps(f, sort_keys=True) for f in old_fields):
                retained = old_fields  # A repair must not reshuffle unchanged preferred details on rerun.
            updated["fields"] = retained
            updated["legacy_unverified"] = bool(keys - resolved_keys)
            proof = {"source": "phone-recovery", "version": 1, "phones": recovered}
            updated["source_records"] = list(dict.fromkeys(updated.get("source_records", []) + [json.dumps(proof, ensure_ascii=False, sort_keys=True)]))
            contacts.validate(updated)
            if card == updated:
                continue
            changes.append({"id": pid, "uid": person["contact_uid"], "before": person["contact_data"],
                            "before_name": person["name"], "identifiers": sorted(keys),
                            "before_identifiers": sorted(self.identifier_rows[pid]), "before_keys": sorted(self.key_rows[pid]),
                            "after": updated, "recovered_keys": sorted(resolved_keys)})
        return {"changes": changes, "unresolved": unresolved, "ambiguous": ambiguous,
                "source_counts": dict(source_counts), "warnings": self.warnings}


def apply(conn: sqlite3.Connection, plan: dict, directory: Path) -> dict:
    """Back up before changes; serialize and recheck every affected contact.

    Journal only this repair's before/after cards. Unrelated tables, historical
    identifiers and their source provenance stay untouched. A rerun is a no-op.
    """
    if conn.in_transaction:
        raise ValueError("Finish the current transaction before repairing contacts")
    directory.mkdir(parents=True, exist_ok=True, mode=0o700)
    stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
    backup = directory / f"before-phone-recovery-{stamp}.db"
    fd = os.open(backup, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(fd)
    with sqlite3.connect(backup) as target:
        conn.backup(target)
    report = directory / f"phone-recovery-{stamp}.json"
    journal = {"backup": str(backup), "plan": plan}
    fd = os.open(report, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    with os.fdopen(fd, "w") as out:
        json.dump(journal, out, ensure_ascii=False)
        out.flush()
        os.fsync(out.fileno())
    applied, skipped = [], []
    try:
        conn.execute("BEGIN IMMEDIATE")
        for change in plan["changes"]:
            row = conn.execute("SELECT * FROM people WHERE id=?", (change["id"],)).fetchone()
            keys = sorted(r[0] for r in conn.execute("SELECT value FROM identifiers WHERE person_id=? AND kind='phone'", (change["id"],)))
            identifiers = sorted([r["kind"], r["value"], r["source"]] for r in conn.execute(
                "SELECT kind,value,source FROM identifiers WHERE person_id=?", (change["id"],)))
            contact_keys = sorted([r["kind"], r["value"]] for r in conn.execute(
                "SELECT kind,value FROM contact_keys WHERE person_id=?", (change["id"],)))
            if row is None or row["merged_into"] is not None or row["trashed"] or row["is_me"] or (
                row["contact_uid"] != change["uid"] or row["name"] != change["before_name"] or
                row["contact_data"] != change["before"] or keys != change["identifiers"] or
                identifiers != change["before_identifiers"] or contact_keys != change["before_keys"]
            ):
                skipped.append(change["id"])
                continue
            contacts.save(conn, change["uid"], change["after"], change["id"])
            applied.append(change["id"])
        conn.commit()
    except BaseException:
        conn.rollback()
        raise
    return {"applied": len(applied), "skipped_changed": len(skipped), "backup": str(backup), "report": str(report)}
