import json

import pytest

from mypeople import db, google, identity, publish, snapchat_links
from mypeople.profile_urls import enumeration_site, profile_url, username_for

URL = "https://www.snapchat.com/add/cwren"


def person(conn, handle="cwren", source="snapchat"):
    return identity.resolve(conn, [("snapchat", handle)], "Chris Wren", source)


def test_old_import_is_backfilled_on_open_and_published(tmp_path):
    path = tmp_path / "old.db"
    conn = db.connect(path)
    pid = person(conn)
    card = json.dumps({"name": "Chris Wren", "notes": "Keep this", "fields": []})
    conn.execute("UPDATE people SET contact_data=? WHERE id=?", (card, pid))
    conn.commit()
    conn.close()

    conn = db.connect(path)
    profile = conn.execute("SELECT * FROM profiles").fetchone()
    assert (profile["person_id"], profile["site"], profile["url"], profile["status"]) == (pid, "snapchat", URL, "confirmed")
    assert json.loads(profile["sources"]) == [{"source": "snapchat", "kind": "snapchat", "value": "cwren"}]
    assert conn.execute("SELECT contact_data FROM people WHERE id=?", (pid,)).fetchone()[0] == card
    records, _ = publish.records(conn)
    assert records[("profile", str(profile["id"]))]["url"] == URL
    assert google.links(conn, pid) == [{"value": URL, "type": "Snapchat"}]
    assert snapchat_links.backfill(conn) == 0
    db._migrate(conn)
    assert conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 1
    conn.close()


@pytest.mark.parametrize("handle", ["cwren", " CWren ", "chris.wren", "chris_wren", "chris-wren"])
def test_known_usernames_become_links(conn, handle):
    pid = person(conn, handle)
    assert snapchat_links.backfill(conn) == 1
    row = conn.execute("SELECT * FROM profiles").fetchone()
    assert row["person_id"] == pid
    assert row["url"] == URL.replace("cwren", handle.strip().lower())
    assert row["confidence"] == 1


@pytest.mark.parametrize("handle", [
    "01234567-abcd-abcd-abcd-0123456789ab", "friend@example.com", "1234567890",
    "Chris Wren", "cwren?x=1", "cwren#x", "cwren/extra", "zz", "_cwren", "cwren_",
])
def test_invalid_or_private_identifiers_are_not_links(conn, handle):
    pid = person(conn, handle)
    assert snapchat_links.backfill(conn) == 0
    assert google.links(conn, pid) == []


@pytest.mark.parametrize("state", ["me", "merged", "trashed", "untrusted"])
def test_ineligible_people_are_skipped(conn, state):
    pid = person(conn, source="other" if state == "untrusted" else "snapchat")
    if state == "me":
        identity.set_me(conn, [pid])
    elif state == "merged":
        target = identity.resolve(conn, [], "Another Person", "test")
        conn.execute("UPDATE people SET merged_into=? WHERE id=?", (target, pid))
    elif state == "trashed":
        conn.execute("UPDATE people SET trashed=1 WHERE id=?", (pid,))
    assert snapchat_links.backfill(conn) == 0
    assert not conn.execute("SELECT 1 FROM profiles").fetchone()


@pytest.mark.parametrize("url", [URL, "https://snapchat.com/add/CWren/"])
@pytest.mark.parametrize("status", ["suggested", "confirmed", "rejected"])
def test_existing_decisions_and_provenance_are_preserved(conn, url, status):
    pid = person(conn)
    sources = [{"source": "existing"}]
    conn.execute(
        "INSERT INTO profiles (person_id, site, url, confidence, status, sources) VALUES (?, 'snapchat', ?, .5, ?, ?)",
        (pid, url, status, json.dumps(sources)),
    )
    snapchat_links.backfill(conn)
    row = conn.execute("SELECT * FROM profiles").fetchone()
    assert conn.execute("SELECT COUNT(*) FROM profiles").fetchone()[0] == 1
    assert row["status"] == ("confirmed" if status == "suggested" else status)
    assert json.loads(row["sources"])[0] == sources[0]
    if status == "rejected":
        assert google.links(conn, pid) == []


def test_snapchat_profile_routes():
    assert profile_url("https://snapchat.com/add/CWren/?share=1") == URL
    assert username_for(URL) == "cwren"
    for url in ["https://snapchat.com/cwren", "https://snapchat.com/add/cwren/extra",
                "https://snapchat.com/add/12345", "https://snapchat.com.evil.example/add/cwren"]:
        assert profile_url(url) is None
    # Supporting imported links must not silently expand the scanner network scope.
    assert not enumeration_site("https://www.snapchat.com/add/{username}")
