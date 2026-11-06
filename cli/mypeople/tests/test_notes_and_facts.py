"""Notes and facts belong to the contact, and everyone can tell what you wrote from what was derived."""

import itertools

import pytest

from mypeople import cli, contacts, extract, identity, ops, photos, publish, replica, transfer
from mypeople.events import add_event, forget, reconcile, remember


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


FACT = {"type": "job", "value": "Works at Example", "date": "", "source": "imessage"}


def state(conn, pid):
    return conn.execute("SELECT generation, status FROM events WHERE person_id = ?", (pid,)).fetchall()


@pytest.mark.parametrize("order", list(itertools.permutations([1, 2, 3])))
def test_any_order_of_syncing_gives_the_same_answer(conn, order):
    # Seen by one device, forgotten by another, brought back by a third.
    pid = person(conn)
    for generation in order:
        reconcile(conn, pid, FACT, generation)
    assert [tuple(r) for r in state(conn, pid)] == [(3, "active")]


def test_a_forget_that_arrives_first_still_wins(conn):
    pid = person(conn)
    forget(conn, pid, "job", "Works at Example", None)
    assert reconcile(conn, pid, FACT, 1) is None
    assert [tuple(r) for r in state(conn, pid)] == [(2, "rejected")]


def test_the_model_cannot_bring_back_what_you_forgot_but_you_can(conn):
    pid = person(conn)
    add_event(conn, pid, "job", "Works at Example", None, 0.9, "imessage")
    forget(conn, pid, "job", "Works at Example", None)
    assert add_event(conn, pid, "job", "Works at Example", None, 0.9, "imessage") is None
    assert state(conn, pid)[0]["status"] == "rejected"
    assert remember(conn, pid, "job", "Works at Example", None)
    assert [tuple(r) for r in state(conn, pid)] == [(3, "active")]
    source = conn.execute("SELECT source FROM events WHERE person_id = ?", (pid,)).fetchone()[0]
    assert source == "manual"


def test_a_phone_can_forget_a_fact_by_what_it_says(conn):
    pid = contact(conn, "Sam Rivera")
    uid = conn.execute("SELECT contact_uid FROM people WHERE id = ?", (pid,)).fetchone()[0]
    add_event(conn, pid, "job", "Works at Example", "2024", 0.9, "imessage")
    ops.apply(conn, "event_forget", {"person_id": -7, "contact_uid": uid, "type": "job", "value": "Works at Example", "date": "2024"})
    assert state(conn, pid)[0]["status"] == "rejected"


def test_merging_contacts_keeps_a_forget_from_either_side(conn):
    keep, drop = person(conn, "Sam Rivera"), person(conn, "Sam R")
    add_event(conn, keep, "job", "Works at Example", None, 0.9, "imessage")
    add_event(conn, drop, "job", "Works at Example", None, 0.9, "imessage")
    forget(conn, drop, "job", "Works at Example", None)
    identity.merge(conn, keep, drop)
    assert [tuple(r) for r in state(conn, keep)] == [(2, "rejected")]


def test_two_macs_converge_whichever_merges_first(conn, tmp_path, key):
    import mypeople.db as db

    pid = contact(conn, "Sam Rivera")
    add_event(conn, pid, "job", "Forgotten on the other Mac", None, 0.9, "imessage")
    conn.commit()
    path, back = tmp_path / "a.sherloq", tmp_path / "b.sherloq"
    transfer.export_snapshot(conn, path, key)
    other = db.connect(tmp_path / "other.db")
    transfer.merge_snapshot(other, path, key)
    # Offline, each changes something different.
    ops.apply(conn, "note", {"person_id": pid, "text": "Written on the first Mac"})
    other_pid = other.execute("SELECT id FROM people WHERE merged_into IS NULL").fetchone()[0]
    ops.apply(other, "note", {"person_id": other_pid, "text": "Written on the second Mac"})
    row = other.execute("SELECT id FROM events WHERE type = 'job'").fetchone()
    ops.apply(other, "event_forget", {"event_id": row["id"]})
    transfer.export_snapshot(conn, path, key)
    transfer.export_snapshot(other, back, key)
    done = transfer.merge_snapshot(conn, back, key)
    assert (done["facts_added"], done["facts_forgotten"]) == (1, 1)
    transfer.merge_snapshot(other, path, key)
    assert values(conn) == values(other) == {("Written on the first Mac", "manual"), ("Written on the second Mac", "manual")}
    other.close()


def test_a_fact_brought_back_on_one_mac_comes_back_on_the_other(conn, tmp_path, key):
    import mypeople.db as db

    pid = contact(conn, "Sam Rivera")
    add_event(conn, pid, "job", "Works at Example", None, 0.9, "imessage")
    path = tmp_path / "a.sherloq"
    transfer.export_snapshot(conn, path, key)
    other = db.connect(tmp_path / "other.db")
    transfer.merge_snapshot(other, path, key)
    forget(conn, pid, "job", "Works at Example", None)
    transfer.export_snapshot(conn, path, key)
    transfer.merge_snapshot(other, path, key)
    assert other.execute("SELECT status FROM events").fetchone()[0] == "rejected"
    remember(conn, pid, "job", "Works at Example", None)
    conn.commit()
    transfer.export_snapshot(conn, path, key)
    transfer.merge_snapshot(other, path, key)
    assert tuple(other.execute("SELECT generation, status, source FROM events").fetchone()) == (3, "active", "manual")
    other.close()
