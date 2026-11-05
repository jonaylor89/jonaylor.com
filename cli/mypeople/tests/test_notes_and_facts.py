"""Notes and facts belong to the contact, and everyone can tell what you wrote from what was derived."""

import pytest

from mypeople import cli, contacts, extract, identity, ops, photos, publish, replica, transfer
from mypeople.events import add_event


def person(conn, name="Sam Rivera"):
    pid = identity.create_person(conn, name)
    conn.commit()
    return pid


def notes(conn, pid):
    return conn.execute("SELECT value, source, source_ref, status FROM events WHERE person_id = ? AND type = 'note'", (pid,)).fetchall()


def fake_model(*facts):
    def model(system, prompt, **kwargs):
        model.prompts.append(prompt)
        return extract.Extraction(events=[extract.ExtractedEvent(type="family", summary=f, date=None, confidence=0.9, evidence=f) for f in facts])
    model.prompts = []
    return model


def test_an_edit_note_is_kept_verbatim_with_no_model(conn, monkeypatch):
    monkeypatch.setattr(extract, "default_model", lambda: pytest.fail("a note must not call a model"))
    pid = person(conn)
    assert ops.apply(conn, "note", {"person_id": pid, "text": "  Daughter starts school in May  "}) == "Noted."
    assert ops.apply(conn, "note", {"person_id": pid, "text": "Daughter starts school in May"}) == "Already noted."
    assert [tuple(n)[:2] for n in notes(conn, pid)] == [("Daughter starts school in May", "manual")]


def test_note_is_a_plain_edit_and_only_old_requests_are_enrichment():
    assert "note" in ops.EDITS and "note" not in ops.ENRICHMENT
    assert set(ops.ENRICHMENT) == {"extract", "find_profiles", "photos"}  # bundles from older phones still apply


def test_a_note_is_not_a_type_the_model_can_invent(conn):
    assert "note" not in extract.EVENT_TYPES


def test_notes_and_their_provenance_reach_the_published_view(conn):
    pid = person(conn)
    ops.apply(conn, "note", {"person_id": pid, "text": "Allergic to peanuts"})
    add_event(conn, pid, "job", "Works at Example", None, 0.9, "imessage", None, "started at Example")
    conn.commit()
    events = [r for (kind, _), r in publish.records(conn)[0].items() if kind == "event"]
    assert {(e["type"], e["source"]) for e in events} == {("note", "manual"), ("job", "imessage")}


def test_notes_and_facts_survive_a_merge(conn):
    keep, drop = person(conn, "Sam Rivera"), person(conn, "Sam R")
    ops.apply(conn, "note", {"person_id": drop, "text": "Allergic to peanuts"})
    identity.merge(conn, keep, drop)
    assert [n["value"] for n in notes(conn, keep)] == ["Allergic to peanuts"]


def test_a_failed_model_call_does_not_lose_the_note(conn):
    pid = person(conn)

    def broken(system, prompt, **kwargs):
        raise RuntimeError("no model")

    with pytest.raises(RuntimeError):
        extract.extract_note(conn, broken, pid, "Moving to Lisbon")
    conn.rollback()
    assert [n["value"] for n in notes(conn, pid)] == ["Moving to Lisbon"]
    assert [n["value"] for n in extract.pending_notes(conn)] == ["Moving to Lisbon"]


def test_extract_reads_each_saved_note_once_and_keeps_it(conn):
    pid = person(conn)
    ops.apply(conn, "note", {"person_id": pid, "text": "Sister is called Ana"})
    model = fake_model("Has a sister called Ana")
    pending = extract.pending_notes(conn)
    extract.extract_note(conn, model, pending[0]["person_id"], pending[0]["value"])
    assert "note: Sister" not in model.prompts[0]  # not offered to the model as already known
    assert extract.pending_notes(conn) == []
    assert [tuple(n) for n in notes(conn, pid)] == [("Sister is called Ana", "manual", "read", "active")]
    derived = conn.execute("SELECT value, source FROM events WHERE person_id = ? AND type = 'family'", (pid,)).fetchall()
    assert [tuple(d) for d in derived] == [("Has a sister called Ana", "note")]


def test_a_forgotten_note_is_not_read(conn):
    pid = person(conn)
    ops.apply(conn, "note", {"person_id": pid, "text": "Wrong person"})
    row = conn.execute("SELECT id FROM events WHERE person_id = ?", (pid,)).fetchone()
    ops.apply(conn, "event_forget", {"event_id": row["id"]})
    assert extract.pending_notes(conn) == []


def test_the_extract_command_reads_notes_when_there_are_no_messages(conn, monkeypatch, capsys):
    pid = person(conn)
    ops.apply(conn, "note", {"person_id": pid, "text": "Sister is called Ana"})
    monkeypatch.setattr(cli, "_model", lambda: fake_model("Has a sister called Ana"))
    args = cli.build_parser().parse_args(["extract", "--progress", "off"])
    cli.cmd_extract(conn, args)
    assert "1 new events" in capsys.readouterr().out
    assert extract.pending_notes(conn) == []


def test_ops_validate_their_payloads(conn):
    pid = person(conn)
    with pytest.raises(ops.OpError, match="closeness"):
        ops.apply(conn, "relationship", {"person_id": pid, "closeness": 3})
    with pytest.raises(ops.OpError, match="No person"):
        ops.apply(conn, "rename", {"person_id": 999, "name": "X"})
    with pytest.raises(ops.OpError, match="text is missing"):
        ops.apply(conn, "note", {"person_id": pid, "text": " "})
    with pytest.raises(ops.OpError, match="Unknown operation"):
        ops.apply(conn, "drop_tables", {})


def test_photo_collection_reports_one_line(conn, monkeypatch):
    monkeypatch.setattr(photos, "collect_contacts", lambda conn, root: {"photos": 3, "matched": 2, "saved": 1})
    assert photos.collect(conn, "contacts") == "contacts: 3 photos, 2 of people you know; 1 new or larger."


def test_a_surfaced_moment_does_not_block_undoing_a_merge_but_acting_on_one_does(conn):
    keep, drop = person(conn, "Sam Rivera"), person(conn, "Sam R")
    kept = contacts.reversible_merge(conn, [keep, drop], lambda: identity.merge(conn, keep, drop) or keep)
    conn.commit()
    insert = "INSERT INTO moments (key, person_id, kind, reason, score, surfaced_on, status) VALUES ('m', ?, 'fresh', 'r', 1.0, '2026-01-01', 'new')"
    conn.execute(insert, (kept,))
    assert contacts.merge_can_be_undone(conn, kept)
    conn.execute("UPDATE moments SET status = 'done' WHERE key = 'm'")
    assert not contacts.merge_can_be_undone(conn, kept)
    with pytest.raises(ValueError, match="changed after merging"):
        contacts.undo_merge(conn, kept)


# --- between Macs -------------------------------------------------------------------------

@pytest.fixture
def key(tmp_path):
    return "a shared passphrase that is long enough"


def contact(conn, name):
    change = replica.capture(conn).edit("11111111-1111-4111-8111-111111111111", {"name": name, "region": "US"})
    replica.receive(conn, [change])
    conn.commit()
    return conn.execute("SELECT id FROM people WHERE contact_uid = ?", (change["contact_uid"],)).fetchone()["id"]


def values(conn):
    return {(e["value"], e["source"]) for e in conn.execute("SELECT value, source FROM events WHERE status = 'active'")}


def test_a_clone_gets_notes_and_facts_with_their_provenance(conn, tmp_path, key):
    import mypeople.db as db

    pid = contact(conn, "Sam Rivera")
    ops.apply(conn, "note", {"person_id": pid, "text": "Allergic to peanuts"})
    add_event(conn, pid, "job", "Works at Example", None, 0.9, "imessage")
    conn.commit()
    path = tmp_path / "memory.sherloq"
    transfer.export_snapshot(conn, path, key)

    clone = db.connect(tmp_path / "clone.db")
    transfer.merge_snapshot(clone, path, key)
    assert values(clone) == {("Allergic to peanuts", "manual"), ("Works at Example", "imessage")}
    assert extract.pending_notes(clone) == []  # read on the Mac that has them, not again here

    # Merging again changes nothing, and what this Mac forgot stays forgotten.
    row = clone.execute("SELECT id FROM events WHERE type = 'job'").fetchone()
    ops.apply(clone, "event_forget", {"event_id": row["id"]})
    transfer.merge_snapshot(clone, path, key)
    assert values(clone) == {("Allergic to peanuts", "manual")}
    clone.close()
