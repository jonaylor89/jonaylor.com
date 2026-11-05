import datetime as dt

from mypeople import google, identity, photos
from mypeople.events import add_event
from mypeople.importers.common import add_interaction

TODAY = dt.date(2026, 10, 22)
# A minimal JPEG header: SOI, then a SOF0 frame of 120x96.
JPEG_96 = b"\xff\xd8\xff\xc0\x00\x11\x08\x00\x78\x00\x60" + b"\x00" * 12
JPEG_220 = b"\xff\xd8\xff\xc0\x00\x11\x08\x00\xdc\x00\xdc" + b"\x00" * 12


def setup_people(conn):
    marcus = identity.resolve(conn, [("phone", "5551234567")], "Marcus Lee", "test")
    add_event(conn, marcus, "birthday", "Birthday", "1990-10-25", 0.9, "imessage")
    add_event(conn, marcus, "job", "Works as a nurse at VCU Health.", "2026-03", 0.9, "imessage")
    identity.add_alias(conn, marcus, "Marky")
    for i in range(25):
        add_interaction(conn, marcus, f"2026-10-{1 + i % 20:02d} 12:00:00", "imessage", "out" if i % 2 else "in", "hi", None, f"m{i}")
    snap = identity.resolve(conn, [("snapchat", "brave5")], "Brave", "snapchat")
    for i in range(25):
        add_interaction(conn, snap, f"2019-05-{1 + i % 20:02d} 12:00:00", "snapchat", "out" if i % 2 else "in", "yo", None, f"s{i}")
    conn.commit()
    return marcus, snap


def test_merge_notes_keeps_user_text():
    block = f"{google.BEGIN}\nNow: nurse\n{google.END}"
    assert google.merge_notes("", block) == block
    assert google.merge_notes("Met at Dana's party", block) == f"Met at Dana's party\n\n{block}"
    old = f"Met at Dana's party\n\n{google.BEGIN}\nNow: student\n{google.END}"
    assert google.merge_notes(old, block) == f"Met at Dana's party\n\n{block}"


def test_plan_fills_blanks_only(conn):
    marcus, snap = setup_people(conn)
    contacts = [
        {"resourceName": "people/c1", "etag": "e1", "phoneNumbers": [{"value": "(555) 123-4567"}],
         "biographies": [{"value": "Met at Dana's party"}], "nicknames": [{"value": "marky"}]},
        {"resourceName": "people/c2", "etag": "e2", "emailAddresses": [{"value": "someone@else.com"}],
         "birthdays": [{"date": {"month": 1, "day": 2}}]},
    ]
    changes = google.plan(conn, contacts, today=TODAY)
    assert [c.resource for c in changes] == ["people/c1"]
    ch = changes[0]
    assert ch.fields["birthdays"] == [{"date": {"month": 10, "day": 25, "year": 1990}}]
    assert "nicknames" not in ch.fields  # already listed, case-insensitively
    notes = ch.fields["biographies"][0]["value"]
    assert notes.startswith("Met at Dana's party\n\n── Sherloq ──\nNow: Works as a nurse at VCU Health\n")
    assert "Last in touch: Oct 2026 (imessage)" in notes

    # Once applied, the same plan has nothing left to do for the notes or birthday.
    contacts[0]["biographies"] = [{"value": notes}]
    contacts[0]["birthdays"] = ch.fields["birthdays"]
    assert google.plan(conn, contacts, today=TODAY) == []


def test_plan_creates_only_when_asked(conn):
    marcus, snap = setup_people(conn)
    assert google.plan(conn, [], today=TODAY) == []
    created = [c for c in google.plan(conn, [], create=True, today=TODAY) if c.resource is None]
    by_name = {c.name: c for c in created}
    assert set(by_name) == {"Marcus Lee", "Brave"}
    assert by_name["Brave"].fields["urls"] == [{"value": "https://www.snapchat.com/add/brave5", "type": "Snapchat"}]
    assert "phoneNumbers" not in by_name["Marcus Lee"].fields  # matching identifier only; no current contact card


def test_apply_remembers_created_contacts(conn, monkeypatch):
    marcus, snap = setup_people(conn)
    calls = []

    def api(method, path, body=None, params=None):
        calls.append((method, path))
        if path == "contactGroups" and method == "GET":
            return {"contactGroups": []}
        if path == "contactGroups":
            return {"resourceName": "contactGroups/mypeople"}
        if path == "people:createContact":
            assert body["memberships"][0]["contactGroupMembership"]["contactGroupResourceName"] == "contactGroups/mypeople"
            return {"resourceName": f"people/new{len(calls)}"}
        return {}

    monkeypatch.setattr(google, "api", api)
    monkeypatch.setattr(google, "WRITE_PAUSE", 0)
    changes = google.plan(conn, [], create=True, today=TODAY)
    google.apply(conn, changes, progress=lambda line: None)
    resource = conn.execute("SELECT value FROM identifiers WHERE kind = 'google' AND person_id = ?", (snap,)).fetchone()
    assert resource is not None
    # A later sync finds Brave through the stored link instead of creating them again.
    again = google.plan(conn, [{"resourceName": resource["value"], "biographies": changes[1].fields.get("biographies", [])}],
                        create=True, today=TODAY)
    assert all(c.person_id != snap or c.resource for c in again)


def test_photos_keep_largest_and_follow_merges(conn):
    assert photos.jpeg_width(JPEG_96) == 96 and photos.jpeg_width(JPEG_220) == 220
    assert photos.jpeg_width(b"not a jpeg") == 0
    marcus, snap = setup_people(conn)
    assert photos.save(conn, snap, "whatsapp", JPEG_220)
    assert not photos.save(conn, snap, "whatsapp", JPEG_96)
    assert photos.best(conn, snap)["width"] == 220
    identity.merge(conn, marcus, snap)
    assert photos.best(conn, marcus)["width"] == 220

    contact = {"resourceName": "people/c1", "phoneNumbers": [{"value": "5551234567"}],
               "photos": [{"url": "x", "default": True}]}
    ch = google.plan(conn, [contact], with_photos=True, today=TODAY)[0]
    assert ch.photo and ch.photo.endswith(f"{snap}-whatsapp.jpg")
    contact["photos"] = [{"url": "y"}]  # the user's own photo is never replaced
    assert all(c.photo is None for c in google.plan(conn, [contact], with_photos=True, today=TODAY))


def test_no_notes_writes_structured_fields_only(conn):
    marcus, snap = setup_people(conn)
    contact = {"resourceName": "people/c1", "phoneNumbers": [{"value": "5551234567"}]}
    [ch] = google.plan(conn, [contact], with_notes=False, today=TODAY)
    assert set(ch.fields) == {"birthdays", "nicknames"}


def test_recent_birthday_year_is_not_a_birth_year(conn):
    pid = identity.resolve(conn, [("phone", "5550001111")], "Armaan", "test")
    add_event(conn, pid, "birthday", "Celebrated his birthday", "2025-06-06", 0.9, "imessage")
    [ch] = google.plan(conn, [{"resourceName": "people/a", "phoneNumbers": [{"value": "5550001111"}]}],
                       with_notes=False, today=TODAY)
    assert ch.fields["birthdays"] == [{"date": {"month": 6, "day": 6}}]


def test_photos_from_contacts_app_and_google(conn, tmp_path):
    import sqlite3

    marcus, snap = setup_people(conn)
    source = tmp_path / "AddressBook" / "Sources" / "ABC"
    (source / ".AddressBook-v22_SUPPORT" / "_EXTERNAL_DATA").mkdir(parents=True)
    (source / ".AddressBook-v22_SUPPORT" / "_EXTERNAL_DATA" / "UUID-1").write_bytes(JPEG_220)
    book = sqlite3.connect(source / "AddressBook-v22.abcddb")
    book.executescript(
        "CREATE TABLE ZABCDRECORD (Z_PK INTEGER, ZIMAGEDATA BLOB, ZTHUMBNAILIMAGEDATA BLOB, ZCROPRECT TEXT);"
        "CREATE TABLE ZABCDPHONENUMBER (ZOWNER INTEGER, ZFULLNUMBER TEXT);"
        "CREATE TABLE ZABCDEMAILADDRESS (ZOWNER INTEGER, ZADDRESS TEXT);"
    )
    book.executemany("INSERT INTO ZABCDRECORD VALUES (?, ?, ?, ?)", [
        (1, b"\x02UUID-1\x00", b"\x01" + JPEG_96, "{{0, 0}, {220, 220}}"),  # full image, uncropped: the bigger one wins
        (2, b"\x02UUID-1\x00", b"\x01" + JPEG_96, "{{40, 10}, {100, 100}}"),  # cropped: only the thumbnail is safe
        (3, None, b"\x01" + JPEG_96, None),  # nobody MyPeople knows
    ])
    book.execute("INSERT INTO ZABCDPHONENUMBER VALUES (1, '+1 (555) 123-4567')")
    book.execute("INSERT INTO ZABCDEMAILADDRESS VALUES (2, 'brave@example.com')")
    book.execute("INSERT INTO ZABCDPHONENUMBER VALUES (3, '555 000 0000')")
    book.commit()
    identity.add_identifier(conn, snap, "email", "brave@example.com", "test")
    stats = photos.collect_contacts(conn, tmp_path / "AddressBook")
    assert stats == {"photos": 3, "matched": 2, "saved": 2}
    widths = dict(conn.execute("SELECT person_id, width FROM photos WHERE source = 'contacts'").fetchall())
    assert widths == {marcus: 220, snap: 96}

    identity.add_identifier(conn, marcus, "google", "people/c1", "google")
    asked = []
    contacts = [
        {"resourceName": "people/c1", "photos": [{"url": "https://lh3.example/abc=s100", "default": False}]},
        {"resourceName": "people/c2", "photos": [{"url": "https://lh3.example/def=s100", "default": True}]},
    ]
    stats = photos.collect_google(conn, contacts, fetch=lambda url: asked.append(url) or JPEG_220)
    assert asked == ["https://lh3.example/abc=s720"] and stats["saved"] == 1  # default avatars are skipped


def test_plan_adds_last_names_and_profile_links(conn):
    marcus, snap = setup_people(conn)
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, status) VALUES (?, 'linkedin', 'https://linkedin.com/in/marcuslee', 1, 'confirmed')", (marcus,))
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, status) VALUES (?, 'github', 'https://github.com/mlee', 1, 'confirmed')", (marcus,))
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, status) VALUES (?, 'x', 'https://x.com/notmarcus', 0.4, 'suggested')", (marcus,))
    names = [{"metadata": {"primary": True}, "givenName": "Marcus", "displayName": "Marcus"}]
    contact = {"resourceName": "people/c1", "etag": "e1", "phoneNumbers": [{"value": "5551234567"}], "names": names,
               "urls": [{"value": "http://www.github.com/mlee/", "type": "profile"}], "birthdays": [{"date": {"month": 10, "day": 25}}]}
    ch = google.plan(conn, [contact], today=TODAY, with_notes=False)[0]
    assert ch.fields["names"] == [{"givenName": "Marcus", "familyName": "Lee"}]
    # GitHub is already there (in another form); the unconfirmed X suggestion is never written.
    assert ch.fields["urls"] == contact["urls"] + [{"value": "https://linkedin.com/in/marcuslee", "type": "LinkedIn"}]

    # A contact with its own name for them, or one that already has a last name, keeps it.
    for other in ([{"givenName": "Mom"}], [{"givenName": "Marcus", "familyName": "Li"}]):
        contact = {**contact, "names": other, "urls": ch.fields["urls"]}
        assert "names" not in (google.plan(conn, [contact], today=TODAY, with_notes=False) or [google.Change(0, "", "")])[0].fields


def test_split_name():
    assert google.split_name("Andrea Göschel") == ("Andrea", "Göschel")
    assert google.split_name("Mary Ann van der Berg") == ("Mary", "Ann van der Berg")
    assert google.split_name("Andrea") is None
    assert google.split_name("andrea.graham@icsfederal.com") is None
    assert google.split_name("Alex Muresan | Work Archetypes") is None
