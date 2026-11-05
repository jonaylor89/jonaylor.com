"""Exercise the export SQL with both legacy JSON and modern extracted columns."""
import json
import sqlite3

import pytest

from mypeople import identity
from mypeople.importers import signal_export
from mypeople.importers.signal import import_signal
from mypeople.importers.vcard import Card, import_card
from .test_signal import ME, ADA, GRACE, conversation, message, snapshot


@pytest.mark.parametrize("normalized", [False, True])
def test_export_sql_whitelists_and_excludes_ephemeral_content(normalized):
    db = sqlite3.connect(":memory:")
    schema = {"messages": {"id", "json", "sent_at"}, "conversations": {"id", "json"}}
    if normalized:
        schema["messages"].update(set(signal_export.MESSAGE_FIELDS) - {"sourceUuid", "deletedForEveryone"})
        schema["messages"].add("hasAttachments")
        schema["conversations"].update(signal_export.CONVERSATION_FIELDS)
    db.execute("CREATE TABLE items(id TEXT, json TEXT)")
    for table, columns in schema.items():
        declarations = ', '.join('"' + c + '"' for c in sorted(columns))
        db.execute(f"CREATE TABLE {table}({declarations})")
    db.execute("INSERT INTO items VALUES (?,?)", ("uuid_id", json.dumps({"value": ME + ".2"})))
    db.execute("INSERT INTO items VALUES (?,?)", ("protocol-secret", json.dumps({"value": "NEVER_EXPORT_PROTOCOL_SECRET"})))
    def insert(table, value):
        extracted = {k: v for k, v in value.items() if k in schema[table]}
        data = {k: v for k, v in value.items() if not normalized or k not in schema[table]}
        extracted["json"] = json.dumps(data)
        names = ', '.join('"' + k + '"' for k in extracted)
        db.execute(f"INSERT INTO {table}({names}) VALUES ({','.join('?' for _ in extracted)})", tuple(extracted.values()))
    insert("conversations", conversation(profileKey="NEVER_EXPORT_PROFILE_KEY"))
    variants = [{}, {"expireTimer": 60}, {"isViewOnce": True}, {"isErased": True}, {"deletedForEveryone": True}, {"type": "call-history"}]
    for index, extra in enumerate(variants):
        insert("messages", message(str(index), body="hello" if index == 0 else "NEVER_EXPORT_EPHEMERAL", attachments=[{"path": "NEVER_EXPORT_ATTACHMENT"}], hasAttachments=1, **extra))
    db.commit()
    discovered = json.loads(db.execute(signal_export.SCHEMA_QUERY).fetchone()[0])
    assert {table: set(columns) for table, columns in discovered.items()} == schema
    # Dot commands are CLI-only; SQLite ignores the key pragma in this SQL test.
    query = '\n'.join(line for line in signal_export.snapshot_sql("ab" * 32, schema).splitlines() if not line.startswith('.'))
    records = []
    for statement in query.split(';'):
        if statement.strip():
            records.extend(json.loads(row[0]) for row in db.execute(statement))
    assert [r["kind"] for r in records] == ["header", "conversation", "message", "end"]
    assert records[-1] == {"kind": "end", "conversations": 1, "messages": 1}
    assert records[2]["data"]["sent_at"] == 1790856000000
    assert records[2]["data"]["hasAttachments"] == 1
    assert records[2]["data"]["body"] == "hello"
    assert records[1]["data"]["serviceId"] == ADA
    assert "NEVER_EXPORT" not in json.dumps(records)
    db.close()


def test_shared_signal_phones_do_not_merge_accounts(conn, tmp_path):
    existing, _ = import_card(conn, Card(name="Household", phones=["+447700900123"]), "vcard", "test")
    path = snapshot(tmp_path, conversations=[conversation(), conversation("grace", GRACE)], messages=[message(), message("m2", "grace")])
    assert import_signal(conn, path)["interactions"] == 2
    a, b = (identity.find_by_identifier(conn, "signal", service) for service in (ADA, GRACE))
    assert a != b and existing not in (a, b)


def test_existing_signal_identity_prevents_recycled_phone_link(conn, tmp_path):
    existing, _ = import_card(conn, Card(name="Ada", phones=["+447700900123"]), "vcard", "test")
    identity.add_identifier(conn, existing, "signal", ADA, "signal")
    path = snapshot(tmp_path, conversations=[conversation("grace", GRACE, profileName="Grace")], messages=[message(cid="grace")])
    assert import_signal(conn, path)["interactions"] == 1
    assert identity.find_by_identifier(conn, "signal", GRACE) != existing
