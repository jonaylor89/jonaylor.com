import datetime as dt

import pytest

from mypeople import identity, moments, relationships
from mypeople.events import add_event, current_profile, events_for, normalize_date
from mypeople.extract import ExtractedEvent, Extraction, extract_note, extract_person
from mypeople.importers.common import add_interaction

TODAY = dt.date(2026, 10, 22)


def person(conn, name, phone=None):
    ids = [("phone", identity.normalize_phone(phone))] if phone else []
    return identity.resolve(conn, ids, name, "test") if ids else identity.create_person(conn, name)


def talk(conn, pid, days_ago, direction="in", text="hi", n=[0]):
    n[0] += 1
    day = TODAY - dt.timedelta(days=days_ago)
    add_interaction(conn, pid, f"{day.isoformat()} 12:00:00", "imessage", direction, text, None, f"t:{n[0]}")


def test_normalization():
    assert identity.normalize_phone("+1 (555) 123-4567") == identity.normalize_phone("555.123.4567")
    assert identity.normalize_handle("Foo@Bar.com") == ("email", "foo@bar.com")
    assert normalize_date("2026-02-30") == ""
    assert normalize_date("2026-13") == ""
    assert normalize_date("--10-23") == "--10-23"
    assert normalize_date("next week") == ""


def test_lookup_and_merge(conn):
    a = person(conn, "Sam Rivera", "5551112222")
    b = identity.resolve(conn, [("email", "sam@r.io")], "sam@r.io", "email")
    talk(conn, b, 3)
    add_event(conn, a, "job", "Joined Stripe", "2026-09", 0.9, "test")
    add_event(conn, b, "job", "Joined Stripe", "2026-09", 0.9, "test")
    identity.merge(conn, a, b)
    assert identity.lookup(conn, "sam")["id"] == a
    assert identity.lookup(conn, str(b))["id"] == a
    assert identity.find_by_identifier(conn, "email", "sam@r.io") == a
    assert len(events_for(conn, a)) == 1
    assert relationships.infer(conn, a, TODAY).days_since == 3
    with pytest.raises(identity.PersonNotFound):
        identity.lookup(conn, "nobody")


def test_relationship_inference(conn):
    close = person(conn, "Close")
    for d in range(0, 360, 3):
        talk(conn, close, d, "in")
        talk(conn, close, d, "out")
    rel = relationships.infer(conn, close, TODAY)
    assert rel.cadence_days == 3
    assert rel.closeness > 0.6
    assert rel.trend == "steady"

    drifting = person(conn, "Drifting")
    for d in range(60, 300, 7):
        talk(conn, drifting, d, "in")
        talk(conn, drifting, d, "out")
    rel = relationships.infer(conn, drifting, TODAY)
    assert rel.cadence_days == 7 and rel.days_since == 60
    assert rel.trend == "drifting"

    relationships.set_override(conn, drifting, category="family", cadence_days=90.0)
    rel = relationships.infer(conn, drifting, TODAY)
    assert rel.category == "family" and rel.cadence_days == 90


def fake_model(events):
    calls = []

    def model(system, user):
        calls.append(user)
        return Extraction(events=[ExtractedEvent(**e) for e in events])

    model.calls = calls
    return model


def test_extraction_watermark_and_dedupe(conn):
    marcus = person(conn, "Marcus")
    talk(conn, marcus, 3, "in", "I start at Figma on Monday!")
    talk(conn, marcus, 3, "out", "congrats!!")
    model = fake_model([
        {"type": "job", "summary": "Starts at Figma", "date": "2026-10-19", "confidence": 0.9, "evidence": "I start at Figma on Monday!"},
        {"type": "other", "summary": "Said hi", "date": None, "confidence": 0.2, "evidence": "hi"},
    ])
    assert extract_person(conn, model, marcus, today=TODAY) == 1
    assert "Marcus: I start at Figma" in model.calls[0] and "Me: congrats" in model.calls[0]
    # Nothing new: no API call.
    assert extract_person(conn, model, marcus, today=TODAY) == 0
    assert len(model.calls) == 1
    # New message: earlier ones come along as context, known events are listed, duplicate isn't stored.
    talk(conn, marcus, 1, "in", "first week went great")
    assert extract_person(conn, model, marcus, today=TODAY) == 0
    assert "<earlier_messages" in model.calls[1] and "job: Starts at Figma" in model.calls[1]


def test_note(conn):
    priya = person(conn, "Priya")
    model = fake_model([{"type": "interest", "summary": "Wants to learn to make pasta", "date": None, "confidence": 0.9, "evidence": "pasta"}])
    assert extract_note(conn, model, priya, "she wants to learn to make pasta", TODAY) == 1
    assert events_for(conn, priya)[0]["source"] == "note"


def test_moments_ranking(conn):
    marcus = person(conn, "Marcus")
    for d in range(4, 200, 4):
        talk(conn, marcus, d, "in")
        talk(conn, marcus, d, "out")
    add_event(conn, marcus, "job", "Started at Figma", "2026-10-19", 0.9, "imessage")
    add_event(conn, marcus, "loss", "Lost his mom", "2025-10-22", 0.95, "imessage")

    cousin = person(conn, "Cousin")
    for d in range(10, 200, 10):
        talk(conn, cousin, d, "out")
        talk(conn, cousin, d, "in")
    add_event(conn, cousin, "achievement", "Running the Chicago marathon", "2026-10-25", 0.9, "imessage")

    old_friend = person(conn, "Old Friend")
    for d in range(70, 365, 5):
        talk(conn, old_friend, d, "out")
        talk(conn, old_friend, d, "in")

    bday = person(conn, "Bday")
    for d in (20, 50, 90):
        talk(conn, bday, d, "in")
        talk(conn, bday, d, "out")
    add_event(conn, bday, "birthday", "Birthday", "--10-24", 1.0, "vcard")

    stranger = person(conn, "Stranger")
    add_event(conn, stranger, "job", "Works at Acme", "", 0.7, "vcard")  # address book data isn't news

    chosen = moments.today_moments(conn, TODAY)
    kinds = {m.name: m.kind for m in chosen}
    assert kinds == {"Marcus": "anniversary", "Cousin": "upcoming", "Old Friend": "drifting", "Bday": "birthday"}
    assert chosen[0].name == "Marcus" and chosen[0].reason == "One year ago today: Lost his mom."
    assert "Also: Started at Figma" in chosen[0].context

    # Same day: same set. Next day: already-shown moments don't repeat; Marcus's job now gets its turn.
    assert [m.key for m in moments.today_moments(conn, TODAY)] == [m.key for m in chosen]
    tomorrow = {m.name: m.kind for m in moments.today_moments(conn, TODAY + dt.timedelta(days=1))}
    assert tomorrow.get("Marcus") == "life_event"
    assert "Old Friend" not in tomorrow  # drift cooldown
    assert "Bday" not in tomorrow  # already surfaced this year

    relationships.set_override(conn, cousin, muted=1)
    assert all(m.name != "Cousin" for m in moments.today_moments(conn, TODAY + dt.timedelta(days=2), record=False))


def test_address_book_birthday_only_on_the_day(conn):
    # Someone you never talk to: their birthday surfaces on the day, not a week ahead.
    pid = person(conn, "Distant")
    add_event(conn, pid, "birthday", "Birthday", "1985-10-24", 1.0, "vcard")
    assert moments.today_moments(conn, TODAY, record=False) == []
    assert [m.kind for m in moments.today_moments(conn, TODAY + dt.timedelta(days=2), record=False)] == ["birthday"]


def test_silence_beats_noise(conn):
    acquaintance = person(conn, "Acquaintance")
    add_event(conn, acquaintance, "promise", "You said you'd send a link", "", 0.5, "email")
    assert moments.today_moments(conn, TODAY) == []


def test_current_profile_prefers_what_people_said(conn):
    pid = person(conn, "Marcus")
    add_event(conn, pid, "job", "Works at Acme", "", 0.7, "vcard")
    add_event(conn, pid, "job", "Joined Lyft", "2024-03", 0.9, "imessage")
    add_event(conn, pid, "job", "Started at Figma", "2026-10-19", 0.9, "imessage")
    add_event(conn, pid, "move", "Lives in Austin, TX", "", 0.6, "vcard")
    profile = current_profile(events_for(conn, pid))
    assert profile["job"]["value"] == "Started at Figma"
    assert profile["move"]["value"] == "Lives in Austin, TX"


def test_merge_keeps_extraction_progress(conn):
    from mypeople.extract import pending_people

    a = person(conn, "Collette", "5551112222")
    for d in (30, 20, 10):
        talk(conn, a, d, "in", f"message {d}")
    model = fake_model([])
    extract_person(conn, model, a, today=TODAY)
    b = identity.resolve(conn, [("email", "c@icloud.com")], "Collette", "imessage")
    talk(conn, b, 5, "in", "from her apple id")

    # A watermark written by an older version is honoured too.
    conn.execute("UPDATE interactions SET extracted = 0 WHERE person_id = ?", (a,))
    conn.execute("INSERT INTO extraction_state VALUES (?, (SELECT MAX(id) FROM interactions WHERE person_id = ?))", (a, a))

    identity.merge(conn, a, b)
    assert [(p["id"], p["pending"]) for p in pending_people(conn)] == [(a, 1)]
    extract_person(conn, model, a, today=TODAY)
    assert "from her apple id" in model.calls[-1] and "message 10" not in model.calls[-1].split("<messages>")[1]
    assert pending_people(conn) == []


def test_name_duplicates(conn):
    a = person(conn, "Collette Tibbetts", "5551112222")
    talk(conn, a, 3)
    b = identity.resolve(conn, [("email", "c@icloud.com")], "collette  tibbetts", "imessage")
    person(conn, "Someone Else")
    groups = identity.name_duplicates(conn)
    assert [[p["id"] for p in g] for g in groups] == [[a, b]]
    conn.execute("UPDATE people SET name = 'Collette Tibbetts' WHERE id = ?", (b,))
    with pytest.raises(identity.PersonNotFound, match=f"mypeople merge {a} {b}"):
        identity.lookup(conn, "Collette Tibbetts")


def test_me(conn):
    from mypeople.extract import pending_people
    from mypeople.importers.common import resolve_counterpart

    john = identity.resolve(conn, [("email", "john@home.org")], "John Naylor", "email")
    johannes = identity.resolve(conn, [("email", "johannes@work.io"), ("phone", "5550001234")], "Johannes Naylor", "vcard")
    talk(conn, john, 2, "in", "note to self")
    friend = person(conn, "Friend")
    talk(conn, friend, 2, "in", "hey")
    add_event(conn, johannes, "birthday", "Birthday", "--10-23", 1.0, "vcard")

    me_id = identity.set_me(conn, [johannes, john])
    assert identity.me(conn)["id"] == me_id
    assert identity.my_addresses(conn) == {"john@home.org", "johannes@work.io"}
    # You never become a counterpart, and you're out of extraction, ranking, and duplicates.
    assert resolve_counterpart(conn, "+1 555 000 1234", None, "imessage", set()) is None
    assert [p["id"] for p in pending_people(conn)] == [friend]
    assert all(m.person_id != me_id for m in moments.today_moments(conn, TODAY, record=False))
    # You can still look yourself up.
    assert identity.lookup(conn, "Johannes")["id"] == me_id
    assert identity.lookup(conn, "me")["id"] == me_id


def test_aliases_in_lookup_and_prompt(conn):
    robert = person(conn, "Robert Lee", "5551119999")
    identity.add_alias(conn, robert, "Bobby")
    identity.add_alias(conn, robert, "bobby")  # case-insensitive duplicate
    assert identity.aliases(conn, robert) == ["Bobby"]
    assert identity.lookup(conn, "bobby")["id"] == robert
    assert identity.lookup(conn, "bob")["id"] == robert

    me_id = identity.set_me(conn, [identity.create_person(conn, "John Naylor")])
    identity.add_alias(conn, me_id, "Johannes")
    talk(conn, robert, 1, "in", "yo")
    model = fake_model([])
    extract_person(conn, model, robert, today=TODAY)
    assert 'The person is Robert Lee (also called Bobby). The user, shown as "Me", is John Naylor (also called Johannes).' in model.calls[0]

    other = person(conn, "Rob Other")
    identity.add_alias(conn, other, "Bobby")
    identity.merge(conn, robert, other)
    assert identity.aliases(conn, robert) == ["Bobby"]


def test_pending_closest_first(conn):
    from mypeople.extract import pending_people

    work = person(conn, "Colleague")
    for d in range(200, 230):
        talk(conn, work, d, "out", "long thread " * 50)
    friend = person(conn, "Best Friend")
    for d in range(0, 300, 3):
        talk(conn, friend, d, "in", "hey")
        talk(conn, friend, d, "out", "hey")
    assert [p["name"] for p in pending_people(conn)] == ["Best Friend", "Colleague"]


def test_extract_skips_batches_another_run_read(conn, monkeypatch):
    from mypeople import extract

    p = person(conn, "Shared")
    for d in range(40):
        talk(conn, p, d, "in", "news " * 200)
    monkeypatch.setattr(extract.llm, "backend", lambda: type("B", (), {"chunk_chars": 5000})())
    calls = []

    def model(system, user):
        # While the first batch is "thinking", the other run finishes everything else.
        calls.append(user)
        conn.execute("UPDATE interactions SET extracted = 1 WHERE person_id = ?", (p,))
        return extract.Extraction(events=[])

    extract.extract_person(conn, model, p)
    assert len(calls) == 1


def test_ask_selects_relevant_people_when_memory_is_too_big(conn, monkeypatch):
    from mypeople import ask as ask_mod

    roomie = person(conn, "Dana Roomie")
    add_event(conn, roomie, "move", "Was the user's roommate at VCU", "2019", 0.9, "imessage")
    for i in range(30):
        filler = person(conn, f"Filler {i}")
        add_event(conn, filler, "interest", "Likes hiking and cooking " * 5, "", 0.9, "imessage")
    conn.commit()
    prompts = []

    def complete(system, user):
        prompts.append(user)
        return "roommate, lived, apartment" if system == ask_mod.SEARCH_SYSTEM else "Dana."

    monkeypatch.setattr(ask_mod.llm, "complete", complete)
    monkeypatch.setenv("MYPEOPLE_ASK_CHARS", "800")
    assert ask_mod.ask(conn, "who have I lived with?", TODAY) == "Dana."
    memory = prompts[-1]
    assert "Dana Roomie" in memory and len(memory) < 1500 and "most relevant" in memory

    monkeypatch.setenv("MYPEOPLE_ASK_CHARS", "1000000")
    prompts.clear()
    ask_mod.ask(conn, "who have I lived with?", TODAY)
    assert len(prompts) == 1 and "Filler 29" in prompts[0]  # everything fits: no search step


def test_backfilled_facts_are_not_news(conn):
    """Bulk-reading old history mustn't make years-old undated facts look fresh."""
    from mypeople.db import evidence_time

    p = person(conn, "Old Friend")
    for d in range(0, 200, 4):
        talk(conn, p, d, "in", "hey")
        talk(conn, p, d, "out", "hey")
    add_interaction(conn, p, "2019-03-02 10:00:00", "imessage", "in", "I just graduated from VCU!!", None, "old:1")
    rows = conn.execute("SELECT * FROM interactions WHERE person_id = ? ORDER BY at", (p,)).fetchall()
    assert evidence_time(rows, "Old Friend: I just graduated from VCU!!") == "2019-03-02 10:00:00"
    add_event(conn, p, "education", "Graduated from VCU", None, 0.9, "imessage", None, "I just graduated from VCU!!",
              "2019-03-02 10:00:00")
    add_event(conn, p, "promise", "Get ramen together", None, 0.9, "imessage", None, "we should get ramen", "2019-03-01 10:00:00")
    kinds = {m.kind for m in moments.candidates(conn, TODAY)}
    assert "life_event" not in kinds and "promise" not in kinds

    add_event(conn, p, "job", "Started at Stripe", None, 0.9, "imessage", None, "first day at stripe",
              (TODAY - dt.timedelta(days=3)).isoformat() + " 09:00:00")
    assert "life_event" in {m.kind for m in moments.candidates(conn, TODAY)}


def test_dupes_review_remembers_different_people(conn):
    from mypeople import dupes

    a = identity.resolve(conn, [("phone", "5550000001")], "Sam", "test")
    b = identity.resolve(conn, [("snapchat", "sam99")], "Sam", "test")
    add_interaction(conn, a, "2020-01-01 10:00:00", "imessage", "in", "see you at the climbing gym", None, "r1")
    add_interaction(conn, b, "2023-01-01 10:00:00", "snapchat", "in", "new number who dis, it's sam", None, "r2")
    [group] = dupes.to_review(conn)
    cards = [dupes.card(conn, p) for p in group]
    assert cards[0].said and "(555) 000-0001" in cards[0].ids + cards[1].ids
    assert any("before" in c for c in dupes.shared_clues(cards))  # one chat ends before the other starts
    dupes.mark_distinct(conn, [a, b])
    assert dupes.to_review(conn) == []
    c = identity.resolve(conn, [("instagram", "sam")], "Sam", "test")  # a third Sam brings the group back
    assert [len(g) for g in dupes.to_review(conn)] == [3]


def test_dupes_first_name_next_to_full_name(conn):
    from mypeople import dupes

    short = identity.resolve(conn, [("snapchat", "sammy")], "Sam", "test")
    full = identity.resolve(conn, [("phone", "5550000002")], "Sam Kim", "test")
    add_interaction(conn, short, "2020-01-01 10:00:00", "snapchat", "in", "it's sam kim from class", None, "r1")
    add_interaction(conn, short, "2020-01-02 10:00:00", "snapchat", "out", "hey!", None, "r2")
    [group] = dupes.to_review(conn)
    assert [r["id"] for r in group] == [short, full]
    cards = [dupes.card(conn, p) for p in group]
    assert any("mention “Kim”" in c for c in dupes.shared_clues(cards, conn))
    keep = dupes.merge(conn, group)
    assert keep == short  # the one with the history keeps its records...
    assert identity.lookup(conn, "Sam Kim")["id"] == short  # ...and takes the full name
    assert identity.lookup(conn, "Sam")["id"] == short  # the first name stays a nickname


def test_dupes_married_name_and_email_named_record(conn):
    from mypeople import dupes

    maiden = identity.resolve(conn, [("snapchat", "cconnolly7")], "Colleen Connolly", "test")
    married = identity.resolve(conn, [("instagram", "colleen connolly forte")], "Colleen Connolly Forte", "test")
    address = identity.resolve(conn, [("email", "connollyce@vcu.edu")], "connollyce@vcu.edu", "test")
    identity.resolve(conn, [("phone", "5550000003")], "Colleen Foley", "test")  # a different Colleen
    add_interaction(conn, maiden, "2020-01-01 10:00:00", "snapchat", "in", "hi", None, "r1")
    add_interaction(conn, maiden, "2020-01-02 10:00:00", "snapchat", "in", "hey", None, "r2")
    groups = [sorted(r["id"] for r in g) for g in dupes.to_review(conn, first_names=False)]
    assert sorted([maiden, married]) in groups and sorted([address, maiden]) in groups
    assert not any(len(g) > 2 for g in groups)  # Colleen Foley isn't pulled in
    [g] = [g for g in dupes.to_review(conn, first_names=False) if {r["id"] for r in g} == {maiden, married}]
    assert dupes.merge(conn, g) == maiden  # the record with history keeps its data...
    assert identity.lookup(conn, "Colleen Connolly Forte")["id"] == maiden  # ...and takes the married name
    assert identity.lookup(conn, "Colleen Connolly")["id"] == maiden  # the maiden name stays a nickname
    # After the wedding name takes over, the old address still finds her through the maiden name.
    assert any({r["id"] for r in g} == {address, maiden} for g in dupes.to_review(conn, first_names=False))
    stale = [identity.lookup(conn, "connollyce@vcu.edu"), conn.execute("SELECT *, 0 AS n FROM people WHERE id = ?", (married,)).fetchone()]
    assert dupes.merge(conn, stale) == maiden  # a group from before the merge still lands on the survivor
