import base64
import copy
import uuid

import pytest

from mypeople import cli, contacts, google, google_cards, identity, replica
from mypeople.events import add_event
from mypeople.importers import gcontacts, vcard
from mypeople.importers.common import add_interaction


def save(conn, name="Ada Lovelace", **values):
    return contacts.save(conn, str(uuid.uuid4()), {"name": name, "user_edited": True, **values})


def args(*extra):
    return cli.build_parser().parse_args(["google", "sync", *extra])


def test_selected_card_creates_without_any_messages_and_preserves_rich_fields(conn):
    pid = save(conn, given="Ada", middle="Augusta", family="Lovelace", prefix="Countess",
               birthday="1815-12-10", organization="Analytical Engines", title="Programmer",
               notes="Met in London", region="GB", fields=[
                   {"kind": "phone", "value": "020 7946 0018 ext 0042", "label": "WORK"},
                   {"kind": "phone", "value": "03-1234-5678", "region": "JP", "label": "mobile"},
                   {"kind": "phone", "value": "+39 06 6982", "label": "Home"},
                   {"kind": "email", "value": "Ada@Example.test", "label": "Work"},
                   {"kind": "website", "value": "https://example.test/ada", "label": "Portfolio"},
                   {"kind": "address", "value": "1 Main St\nLondon", "label": "Home"},
                   {"kind": "im", "value": "matrix:@ada:example.test"},
                   {"kind": "anniversary", "value": "--02-29"},
               ])
    identity.add_identifier(conn, pid, "phone", "2079460018", "legacy")
    identity.add_identifier(conn, pid, "email", "removed@example.test", "legacy")
    assert google.plan(conn, [], create=True) == []  # bulk creation remains gated
    [ch] = google.plan(conn, [], create=True, person_ids={pid})
    assert ch.resource is None
    assert ch.fields["names"] == [{"givenName": "Ada", "middleName": "Augusta", "familyName": "Lovelace", "honorificPrefix": "Countess"}]
    assert ch.fields["phoneNumbers"] == [
        {"value": "+442079460018;ext=0042", "type": "work"},
        {"value": "+81312345678", "type": "mobile"},
        {"value": "+39066982", "type": "home"},
    ]
    assert ch.fields["emailAddresses"] == [{"value": "Ada@Example.test", "type": "work"}]
    assert ch.fields["birthdays"] == [{"date": {"year": 1815, "month": 12, "day": 10}}]
    assert ch.fields["organizations"] == [{"name": "Analytical Engines", "title": "Programmer"}]
    assert ch.fields["biographies"] == [{"value": "Met in London", "contentType": "TEXT_PLAIN"}]
    assert ch.fields["urls"] == [{"value": "https://example.test/ada", "type": "Portfolio"}]
    assert ch.fields["addresses"] == [{"formattedValue": "1 Main St\nLondon", "type": "home"}]
    assert ch.fields["imClients"] == [{"protocol": "matrix", "username": "@ada:example.test"}]
    assert ch.fields["events"] == [{"date": {"month": 2, "day": 29}, "type": "anniversary"}]
    assert "removed@example.test" not in str(ch.fields)


def test_append_verified_fields_preserves_google_data_and_is_idempotent(conn):
    pid = save(conn, fields=[
        {"kind": "phone", "value": "+442079460018", "label": "work"},
        {"kind": "phone", "value": "+81312345678;ext=0042", "label": "mobile"},
        {"kind": "email", "value": "Ada@Example.test", "label": "work"},
        {"kind": "email", "value": "new@example.test"},
        {"kind": "website", "value": "https://example.test/ada"},
    ], birthday="--02-29", notes="My own notes", organization="My organization")
    identity.add_identifier(conn, pid, "google", "people/ada", "google")
    remote = {"resourceName": "people/ada", "etag": "etag-1", "names": [{"givenName": "My friend"}],
              "phoneNumbers": [{"value": "020 7946 0018", "canonicalForm": "+442079460018", "type": "home"},
                               {"value": "+14155550123", "type": "work"}],
              "emailAddresses": [{"value": "ada@example.test", "type": "home"}],
              "organizations": [{"name": "Google organization"}],
              "biographies": [{"value": "Google notes"}],
              "birthdays": [{"date": {"month": 1, "day": 1}}],
              "urls": [{"value": "http://www.example.test/ada/", "type": "profile"}]}
    original = copy.deepcopy(remote)
    [ch] = google.plan(conn, [remote], person_ids={pid})
    assert ch.etag == "etag-1"
    assert set(ch.fields) == {"phoneNumbers", "emailAddresses"}
    assert ch.fields["phoneNumbers"] == remote["phoneNumbers"] + [{"value": "+81312345678;ext=0042", "type": "mobile"}]
    assert ch.fields["emailAddresses"] == remote["emailAddresses"] + [{"value": "new@example.test"}]
    assert remote == original  # preview never mutates the input
    remote.update(ch.fields)
    assert google.plan(conn, [remote], person_ids={pid}) == []


def test_selected_contact_still_requires_create_flag_and_selection_limits_updates(conn):
    ada = save(conn, fields=[{"kind": "email", "value": "ada@example.test"}])
    other = save(conn, "Other", fields=[{"kind": "email", "value": "other@example.test"}], birthday="--01-02")
    assert google.plan(conn, [], person_ids={ada}) == []
    remote = [{"resourceName": "people/other", "emailAddresses": [{"value": "other@example.test"}]}]
    [ch] = google.plan(conn, remote, create=True, person_ids={ada})
    assert ch.person_id == ada and ch.resource is None
    assert google.plan(conn, remote, create=True, person_ids=set()) == []
    assert other != ada


def test_bulk_creation_retains_outgoing_interaction_gate(conn):
    ada = save(conn)
    for i in range(2):
        add_interaction(conn, ada, "2026-01-01 10:00:00", "email", "in", "Hi", None, str(i))
    assert google.plan(conn, [], create=True, min_interactions=0) == []
    add_interaction(conn, ada, "2026-01-01 11:00:00", "email", "out", "Hi", None, "out")
    assert google.plan(conn, [], create=True) == []
    assert len(google.plan(conn, [], create=True, min_interactions=3)) == 1
    with pytest.raises(google.GoogleError, match="zero or greater"):
        google.plan(conn, [], min_interactions=-1)


def test_legacy_or_invalid_numbers_are_not_exported(conn):
    pid = save(conn, legacy_unverified=True, fields=[
        {"kind": "phone", "value": "2079460018"},
        {"kind": "phone", "value": "invalid"},
        {"kind": "phone", "value": "+4930123456"},
    ])
    warnings = []
    [ch] = google.plan(conn, [], create=True, person_ids={pid}, warnings=warnings)
    assert ch.fields["phoneNumbers"] == [{"value": "+4930123456"}]
    assert any("2 invalid/unverified" in warning for warning in warnings)
    legacy = identity.resolve(conn, [("phone", "5551234567"), ("email", "old@example.test")], "Legacy Person", "legacy")
    [ch] = google.plan(conn, [], create=True, person_ids={legacy})
    assert "phoneNumbers" not in ch.fields and "emailAddresses" not in ch.fields


def test_removed_details_and_birthday_never_resurrect_from_history(conn):
    pid = save(conn, fields=[])
    identity.add_identifier(conn, pid, "email", "removed@example.test", "legacy")
    add_event(conn, pid, "birthday", "Old birthday", "1980-01-02", 1.0, "vcard")
    [ch] = google.plan(conn, [], create=True, person_ids={pid})
    assert set(ch.fields) == {"names"}
    remote = [{"resourceName": "people/old", "emailAddresses": [{"value": "removed@example.test"}]}]
    assert google.match(conn, remote) == {}


def test_google_ids_survive_phone_changes_without_duplicate_creation(conn, monkeypatch):
    pid = save(conn, fields=[{"kind": "phone", "value": "+442079460018"}])
    calls = []

    def api(method, path, body=None, params=None):
        calls.append((method, path, body, params))
        if path == "contactGroups":
            return {"contactGroups": [{"name": google.LABEL, "resourceName": "contactGroups/ours"}]}
        if path == "people:createContact":
            return {"resourceName": "people/new"}
        return {}

    monkeypatch.setattr(google, "api", api)
    monkeypatch.setattr(google, "WRITE_PAUSE", 0)
    [created] = google.plan(conn, [], create=True, person_ids={pid})
    google.apply(conn, [created], progress=lambda _: None)
    assert calls[1][2]["phoneNumbers"] == [{"value": "+442079460018"}]
    row = identity.lookup(conn, str(pid))
    contacts.save(conn, row["contact_uid"], {"name": row["name"], "fields": [{"kind": "phone", "value": "+81312345678"}]})
    remote = {"resourceName": "people/new", "names": created.fields["names"], "phoneNumbers": created.fields["phoneNumbers"], "etag": "new-etag"}
    [updated] = google.plan(conn, [remote], create=True, person_ids={pid})
    assert updated.resource == "people/new"
    google.apply(conn, [updated], progress=lambda _: None)
    assert calls[-1][0:2] == ("PATCH", "people/new:updateContact")
    assert calls[-1][2]["etag"] == "new-etag"
    assert "phoneNumbers" in calls[-1][3]["updatePersonFields"]
    assert sum(path == "people:createContact" for _, path, _, _ in calls) == 1


def test_missing_link_does_not_recreate_an_externally_deleted_contact(conn):
    pid = save(conn)
    identity.add_identifier(conn, pid, "google", "people/missing", "google")
    warnings = []
    assert google.plan(conn, [], create=True, person_ids={pid}, warnings=warnings) == []
    assert any("missing" in warning for warning in warnings)


@pytest.mark.parametrize("conflicting", [False, True])
def test_shared_or_conflicting_keys_require_review_not_first_match_or_creation(conn, conflicting):
    first = save(conn, "First", fields=[{"kind": "phone", "value": "+442079460018"}])
    second = save(conn, "Second", fields=[{"kind": "email", "value": "other@example.test"}] if conflicting else [
        {"kind": "phone", "value": "+442079460018"}])
    remote = [{"resourceName": "people/shared", "phoneNumbers": [{"value": "+442079460018"}],
               "emailAddresses": [{"value": "other@example.test"}] if conflicting else []}]
    warnings = []
    assert google.plan(conn, remote, create=True, person_ids={first, second}, warnings=warnings) == []
    assert any("ambiguous" in warning for warning in warnings)
    # A persistent Google link disambiguates a shared household number.
    identity.add_identifier(conn, first, "google", "people/shared", "google")
    assert google.match(conn, remote) == {first: remote}


def test_names_never_match_or_merge_google_contacts(conn):
    pid = save(conn)
    remote = [{"resourceName": "people/different", "names": [{"displayName": "Ada Lovelace"}]}]
    [ch] = google.plan(conn, remote, create=True, person_ids={pid})
    assert ch.resource is None


def test_multiple_google_duplicates_are_not_merged_or_deleted(conn):
    pid = save(conn, fields=[{"kind": "phone", "value": "+442079460018"}], birthday="--12-10")
    remote = [{"resourceName": f"people/{i}", "phoneNumbers": [{"value": "+442079460018"}]} for i in range(2)]
    changes = google.plan(conn, remote, create=True, person_ids={pid})
    assert {ch.resource for ch in changes} == {"people/0", "people/1"}
    assert conn.execute("SELECT merged_into FROM people WHERE id=?", (pid,)).fetchone()[0] is None


@pytest.mark.parametrize("flag", ["trashed", "is_me"])
def test_inactive_contacts_are_not_exported_even_when_selected(conn, flag):
    pid = save(conn)
    identity.add_identifier(conn, pid, "google", "people/inactive", "google")
    conn.execute(f"UPDATE people SET {flag}=1 WHERE id=?", (pid,))
    assert google.plan(conn, [{"resourceName": "people/inactive"}], create=True, person_ids={pid}) == []


def test_unresolved_causal_conflicts_pause_google_export(conn):
    pid = save(conn)
    history = replica.capture(conn)
    uid = identity.lookup(conn, str(pid))["contact_uid"]
    left = replica.History(history.changes).edit(uid, values={"notes": "Left"})
    right = replica.History(history.changes).edit(uid, values={"notes": "Right"})
    replica.receive(conn, [left, right])
    warnings = []
    assert google.plan(conn, [], create=True, person_ids={pid}, warnings=warnings) == []
    assert any("unresolved contact conflicts" in warning for warning in warnings)


def test_manual_card_birthday_wins_and_no_notes_excludes_all_notes(conn):
    pid = save(conn, birthday="--02-29", notes="Private card notes")
    add_event(conn, pid, "birthday", "Inferred birthday", "1980-01-02", 1.0, "imessage")
    add_event(conn, pid, "job", "Works at Example", "2026-01", 1.0, "imessage")
    [ch] = google.plan(conn, [], create=True, person_ids={pid}, with_notes=False)
    assert ch.fields["birthdays"] == [{"date": {"month": 2, "day": 29}}]
    assert "biographies" not in ch.fields
    [ch] = google.plan(conn, [], create=True, person_ids={pid})
    assert ch.fields["biographies"][0]["value"].startswith("Private card notes\n\n" + google.BEGIN)


def test_current_manual_photo_is_opt_in_and_uploaded_without_preview_file_writes(conn, monkeypatch):
    data = base64.b64encode(b"\xff\xd8\xff" + b"card photo").decode()
    pid = save(conn, photo=data)
    [ch] = google.plan(conn, [], create=True, person_ids={pid})
    assert not ch.photo_data and not ch.photo
    [ch] = google.plan(conn, [], create=True, person_ids={pid}, with_photos=True)
    assert ch.photo_data == data and ch.photo is None
    identity.add_identifier(conn, pid, "google", "people/photo", "google")
    remote = {"resourceName": "people/photo", "names": ch.fields["names"], "photos": [{"default": True}]}
    calls = []
    monkeypatch.setattr(google, "api", lambda *a, **k: calls.append((a, k)) or {})
    monkeypatch.setattr(google, "WRITE_PAUSE", 0)
    [ch] = google.plan(conn, [remote], with_photos=True)
    google.apply(conn, [ch], progress=lambda _: None)
    assert calls[-1][0][1] == "people/photo:updateContactPhoto"
    assert calls[-1][0][2]["photoBytes"] == data
    remote["photos"] = [{"url": "https://example.test/existing"}]
    assert google.plan(conn, [remote], with_photos=True) == []


def test_imported_vcard_and_google_numbers_export_with_original_country(conn):
    source = vcard.parse("BEGIN:VCARD\nFN:International\nN:Person;International;;;\nTEL;TYPE=CELL:+39066982\nEND:VCARD\n")[0]
    pid, _ = vcard.import_card(conn, source, "vcard", "test")
    [ch] = google.plan(conn, [], create=True, person_ids={pid})
    assert ch.fields["phoneNumbers"] == [{"value": "+39066982", "type": "mobile"}]
    gcontacts.import_google_contacts(conn, [{"resourceName": "people/uk", "names": [{"displayName": "UK"}],
        "phoneNumbers": [{"value": "020 7946 0018", "canonicalForm": "+442079460018"}]}])
    uk = identity.lookup(conn, "UK")
    # Use the actual linked record: no duplicate or incorrect default-US number.
    assert google.plan(conn, [{"resourceName": "people/uk", "names": [{"displayName": "UK"}],
        "phoneNumbers": [{"value": "020 7946 0018", "canonicalForm": "+442079460018"}]}], person_ids={uk["id"]}) == []


def test_structured_family_name_is_used_not_guessed_from_display_name(conn):
    pid = save(conn, "Countess Ada", given="Ada", family="Lovelace")
    identity.add_identifier(conn, pid, "google", "people/ada", "google")
    [ch] = google.plan(conn, [{"resourceName": "people/ada", "names": [{"givenName": "Ada"}]}])
    assert ch.fields["names"] == [{"givenName": "Ada", "familyName": "Lovelace"}]


def test_empty_structured_family_name_does_not_reappear_from_display_name(conn):
    pid = save(conn, "Ada Display Name", given="Ada", family="")
    identity.add_identifier(conn, pid, "google", "people/ada", "google")
    assert google.plan(conn, [{"resourceName": "people/ada", "names": [{"givenName": "Ada"}]}]) == []


def test_google_link_follows_local_merge_redirect_and_old_id_selection(conn, monkeypatch):
    keep = save(conn, "Ada Lovelace", fields=[{"kind": "phone", "value": "+442079460018"}])
    drop = save(conn, "Old Ada")
    identity.add_identifier(conn, drop, "google", "people/ada", "google")
    identity.merge(conn, keep, drop)
    remote = [{"resourceName": "people/ada", "names": [{"givenName": "Ada", "familyName": "Lovelace"}]}]
    assert google.match(conn, remote) == {keep: remote}
    assert google.plan(conn, remote, create=True, person_ids={drop}) == []
    monkeypatch.setattr(google, "fetch_contacts", lambda: remote)
    applied = []
    monkeypatch.setattr(google, "apply", lambda conn, changes: applied.extend(changes))
    cli.cmd_google(conn, args("--create", "--person", str(drop), "--apply"))
    assert len(applied) == 1 and applied[0].person_id == keep and applied[0].resource == "people/ada"


def test_cli_preview_selection_validation_and_apply(conn, monkeypatch, capsys):
    ada = save(conn, fields=[{"kind": "phone", "value": "+442079460018"}])
    other = save(conn, "Other")
    monkeypatch.setattr(google, "fetch_contacts", lambda: [])
    applied = []
    monkeypatch.setattr(google, "apply", lambda conn, changes: applied.extend(changes))
    cli.cmd_google(conn, args("--create", "--person", "Ada", "--show-fields"))
    output = capsys.readouterr().out
    assert "1 to create" in output and "+442079460018" in output and "Nothing written" in output
    assert applied == []
    cli.cmd_google(conn, args("--create", "--person", str(ada), "--person", "Other", "--apply"))
    assert {ch.person_id for ch in applied} == {ada, other}
    applied.clear()
    with pytest.raises(identity.PersonNotFound):
        cli.cmd_google(conn, args("--create", "--person", "Nonexistent", "--apply"))
    save(conn, "Ada Duplicate")
    with pytest.raises(identity.PersonNotFound, match="ambiguous"):
        cli.cmd_google(conn, args("--create", "--person", "Ad", "--apply"))
    assert applied == []


def test_cli_invalid_selection_fails_before_contact_api_fetch(conn, monkeypatch):
    pid = save(conn)
    conn.execute("UPDATE people SET trashed=1 WHERE id=?", (pid,))
    monkeypatch.setattr(google, "fetch_contacts", lambda: pytest.fail("should validate before network access"))
    with pytest.raises(SystemExit, match="trashed"):
        cli.cmd_google(conn, args("--person", str(pid), "--create", "--apply"))
    with pytest.raises(SystemExit, match="zero or greater"):
        cli.cmd_google(conn, args("--min-messages", "-1"))


@pytest.mark.parametrize("value,expected", [("--02-29", {"month": 2, "day": 29}), ("2000-02-29", {"year": 2000, "month": 2, "day": 29}),
                                           ("2023-02-29", None), ("--13-01", None), ("2020", None), ("", None)])
def test_card_date_conversion(value, expected):
    assert google_cards.date_value(value) == expected
