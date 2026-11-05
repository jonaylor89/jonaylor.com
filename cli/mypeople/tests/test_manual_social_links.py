"""Explicit contact URLs become usable profiles without trusting imported websites."""
import argparse
import json
import uuid
from argparse import Namespace

import pytest

from mypeople import cli, contact_cli, contacts, db, identity, ops, osint, replica, social_photos, socials
from mypeople.importers import vcard

LI = "https://linkedin.com/in/alice"
IG = "https://instagram.com/alice"
UID = "11111111-1111-4111-8111-111111111111"


def contact(conn, *args):
    parser = argparse.ArgumentParser()
    contact_cli.parser(parser.add_subparsers())
    parsed = parser.parse_args(["contact", *args])
    parsed.func(conn, parsed)


def profiles(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM profiles ORDER BY url")]


def test_cli_add_confirms_canonical_profiles_for_photos_and_discovery(conn, capsys, monkeypatch):
    contact(conn, "create", "Alice", "--add", "website=https://www.linkedin.com/in/Alice/?trk=contact",
            "--add", "website=https://www.instagram.com/Alice/", "--add", "website=https://example.org")
    person = identity.lookup(conn, "Alice")
    assert {r["url"] for r in profiles(conn)} == {LI, IG}
    assert all(r["status"] == "confirmed" for r in profiles(conn))
    assert {t["url"] for t in social_photos.targets(conn, "linkedin", person["id"])} == {LI}
    assert {t["url"] for t in social_photos.targets(conn, "instagram", person["id"])} == {IG}
    assert "alice" in osint.known_usernames(conn, person["id"])
    assert len(contacts.card_for(person)["fields"]) == 3

    monkeypatch.setattr(social_photos, "collect", lambda *a, **kw: pytest.fail("dry run made requests"))
    cli.cmd_photos(conn, Namespace(source="social", path=None, person="Alice", limit=None,
                                 login=False, browser=True, dry_run=True, again=False))
    assert "2 known accounts; no requests made." in capsys.readouterr().out

    contact(conn, "edit", "Alice", "--add", "website=https://www.instagram.com/Alice/")
    assert len(profiles(conn)) == 2
    assert all(len(json.loads(r["sources"])) == 1 for r in profiles(conn))
    assert len(contacts.card_for(identity.lookup(conn, "Alice"))["fields"]) == 3


def test_imported_websites_and_unrelated_manual_edits_do_not_confirm(conn, tmp_path):
    path = tmp_path / "alice.vcf"
    path.write_text(f"BEGIN:VCARD\nFN:Alice\nURL:{LI}\nEND:VCARD\n")
    vcard.import_vcards(conn, path)
    contact(conn, "edit", "Alice", "--set", "notes=My own note")
    assert profiles(conn) == []
    assert social_photos.targets(conn, "linkedin") == []

    contact(conn, "edit", "Alice", "--add", f"website={IG}")
    assert [r["url"] for r in profiles(conn)] == [IG]
    vcard.import_vcards(conn, path)
    assert [r["url"] for r in profiles(conn)] == [IG]


def test_explicit_readdition_confirms_an_imported_link_without_duplicating_the_card(conn):
    contacts.save(conn, UID, {"name": "Alice", "fields": [{"kind": "website", "value": LI, "label": "Work"}]})
    contact(conn, "edit", "Alice", "--add", f"website={LI}")
    assert [r["url"] for r in profiles(conn)] == [LI]
    fields = contacts.card_for(identity.lookup(conn, "Alice"))["fields"]
    assert len(fields) == 1 and fields[0]["label"] == "Work" and fields[0]["user_added"] is True
    contact(conn, "edit", "Alice", "--remove", f"website={LI}")
    assert contacts.card_for(identity.lookup(conn, "Alice"))["fields"] == []
    assert profiles(conn)[0]["status"] == "confirmed"  # removal is not an ownership rejection


def test_card_json_confirms_only_added_or_changed_urls(conn, tmp_path):
    contacts.save(conn, UID, {"name": "Alice", "fields": [{"kind": "website", "value": LI}]})
    path = tmp_path / "card.json"
    path.write_text(json.dumps({"name": "Alice", "fields": [
        {"kind": "website", "value": LI, "label": "Relabelled, not confirmed"},
        {"kind": "website", "value": IG}]}))
    contact(conn, "edit", "Alice", "--card", str(path))
    assert [r["url"] for r in profiles(conn)] == [IG]
    saved = contacts.card_for(identity.lookup(conn, "Alice"))
    saved["fields"] = [{"kind": "website", "value": "https://linkedin.com/in/new-account"}]
    path.write_text(json.dumps(saved))
    contact(conn, "edit", "Alice", "--card", str(path))
    assert {r["url"] for r in profiles(conn)} == {IG, "https://linkedin.com/in/new-account"}


def test_existing_suggestions_confirm_without_losing_evidence_and_rejections_win(conn):
    pid = contacts.save(conn, UID, {"name": "Alice"})
    conn.execute("INSERT INTO profiles (person_id, site, url, confidence, title, sources) VALUES (?, 'linkedin', ?, .5, 'Evidence', ?)",
                 (pid, LI, json.dumps([{"source": "exa", "url": LI}])))
    contact(conn, "edit", "Alice", "--add", f"website={LI}")
    row = profiles(conn)[0]
    assert row["status"] == "confirmed" and row["title"] == "Evidence"
    assert {s["source"] for s in json.loads(row["sources"])} == {"exa", "manual_contact"}
    socials.set_status(conn, row["id"], "rejected")
    contact(conn, "edit", "Alice", "--set", "notes=Unrelated edit", "--add", f"website={LI}")
    assert profiles(conn)[0]["status"] == "rejected"
    assert social_photos.targets(conn, "linkedin") == []


@pytest.mark.parametrize("url", ["https://example.org/alice", "https://linkedin.com/company/alice",
                                  "https://instagram.com/p/post", "https://linkedin.com.evil.org/in/alice",
                                  "https://user@instagram.com/alice", "not a url"])
def test_non_profile_routes_are_kept_as_websites_not_confirmed(conn, url):
    contact(conn, "create", "Alice", "--add", f"website={url}")
    assert contacts.card_for(identity.lookup(conn, "Alice"))["fields"][0]["value"] == url
    assert profiles(conn) == []


def test_phone_assertions_survive_replication_and_replays_do_not_reverse_rejections(conn):
    fields = [{"kind": "website", "value": LI}, {"kind": "website", "value": IG, "user_added": True}]
    base = replica.History()
    change = base.edit(UID, {"name": "Alice", "user_edited": True, "fields": fields})
    ops.apply(conn, "contact_change", change)
    assert [r["url"] for r in profiles(conn)] == [IG]
    pid = identity.lookup(conn, "Alice")["id"]
    assert [t["url"] for t in social_photos.targets(conn, "instagram", pid)] == [IG]
    socials.set_status(conn, profiles(conn)[0]["id"], "rejected")
    ops.apply(conn, "contact_change", change)
    h = replica.load(conn)
    ops.apply(conn, "contact_change", h.edit(UID, values={"notes": "Unrelated phone edit"}))
    assert profiles(conn)[0]["status"] == "rejected"
    assert social_photos.targets(conn, "instagram") == []

    peer = db.connect(":memory:")
    try:
        replica.receive(peer, replica.load(conn).changes)
        assert [r["url"] for r in profiles(peer)] == [IG]
        assert contacts.card_for(identity.lookup(peer, "Alice"))["fields"] == replica.load(conn).contact(UID).card["fields"]
    finally:
        peer.close()


def test_legacy_contact_save_honors_only_per_link_assertions(conn):
    ops.apply(conn, "contact_save", {"contact_uid": UID, "card": {
        "name": "Alice", "user_edited": True, "fields": [
            {"kind": "website", "value": LI}, {"kind": "website", "value": IG, "user_added": True}]}})
    assert [r["url"] for r in profiles(conn)] == [IG]


def test_profile_and_card_save_roll_back_together(conn):
    contact(conn, "create", "Alice")
    person = identity.lookup(conn, "Alice")
    saved = contacts.mark_manual_websites(contacts.card_for(person) | {"fields": [{"kind": "website", "value": LI}]})
    replica.change(conn, person["contact_uid"], saved)
    assert len(profiles(conn)) == 1
    conn.rollback()
    assert profiles(conn) == []
    assert contacts.card_for(identity.lookup(conn, "Alice"))["fields"] == []


def test_invalid_provenance_flag_is_rejected(conn):
    with pytest.raises(ValueError, match="user_added"):
        contacts.save(conn, str(uuid.uuid4()), {"name": "Alice", "fields": [
            {"kind": "website", "value": LI, "user_added": "true"}]})
    assert profiles(conn) == []
