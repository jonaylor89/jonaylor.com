import pytest
import json
from email.message import EmailMessage
import mailbox

from mypeople import identity
from mypeople.events import events_for
from mypeople.importers import imessage, mbox, vcard

from .conftest import _attributed_body, at, make_chat_db


def test_vcard_parse(vcf_path):
    cards = vcard.parse(vcf_path.read_text())
    assert [c.name for c in cards] == ["Marcus Lee", "Priya Shah", "No Phone Person"]
    marcus, priya, _ = cards
    assert marcus.birthday == "1990-10-25"
    assert marcus.city == "Austin, TX"
    assert priya.birthday == "--10-23"


def test_vcard_import_is_idempotent(conn, vcf_path):
    first = vcard.import_vcards(conn, vcf_path)
    second = vcard.import_vcards(conn, vcf_path)
    assert first == {"cards": 3, "events": 4}
    assert second["events"] == 0
    assert conn.execute("SELECT COUNT(*) FROM people").fetchone()[0] == 3
    marcus = identity.find_by_identifier(conn, "email", "marcus@example.com")
    assert identity.find_by_identifier(conn, "phone", "5551234567") == marcus
    assert {e["type"] for e in events_for(conn, marcus)} == {"birthday", "job", "move"}


def test_attributed_body_decoding():
    assert imessage.decode_attributed_body(_attributed_body("hey!")) == "hey!"
    long = "x" * 300
    assert imessage.decode_attributed_body(_attributed_body(long)) == long
    assert imessage.decode_attributed_body(None) is None


def test_imessage_import(conn, vcf_path, tmp_path):
    vcard.import_vcards(conn, vcf_path)
    chat = tmp_path / "chat.db"
    make_chat_db(chat, [
        # 1:1 with a contact; one message stored only in attributedBody
        ("g1", "+15551234567", "+15551234567", 45, False, at("2026-10-01"), "I start at Figma on Monday!", True),
        ("g2", "+15551234567", "+15551234567", 45, True, at("2026-10-01", 13), "congrats!!", False),
        # unknown number I've written to -> new person
        ("g3", "+15550001111", "+15550001111", 45, True, at("2026-10-02"), "hey it's me", False),
        # unknown shortcode that only texts me -> ignored
        ("g4", "12345", "12345", 45, False, at("2026-10-02"), "Your code is 9999", False),
        ("g5", "+15550002222", "+15550002222", 45, False, at("2026-10-02"), "WIN A PRIZE", False),
        # group chat: their message counts, mine doesn't
        ("g6", "+15559876543", "chat123", 43, False, at("2026-10-03"), "running the marathon sunday", False),
        ("g7", None, "chat123", 43, True, at("2026-10-03", 13), "good luck!", False),
    ])
    stats = imessage.import_imessage(conn, chat)
    assert stats == {"messages": 7, "interactions": 4, "skipped": 3}
    marcus = identity.find_by_identifier(conn, "phone", "5551234567")
    rows = conn.execute("SELECT direction, text FROM interactions WHERE person_id = ? ORDER BY at", (marcus,)).fetchall()
    assert [(r["direction"], r["text"]) for r in rows] == [("in", "I start at Figma on Monday!"), ("out", "congrats!!")]
    priya = identity.lookup(conn, "Priya")
    assert conn.execute("SELECT thread FROM interactions WHERE person_id = ?", (priya["id"],)).fetchone()["thread"] == "group chat"
    assert identity.lookup(conn, "5550001111")["name"] == "+15550001111"
    assert imessage.import_imessage(conn, chat)["interactions"] == 0


def _email(frm, to, subject, body, date, msg_id, **headers):
    m = EmailMessage()
    m["From"], m["To"], m["Subject"], m["Date"], m["Message-ID"] = frm, to, subject, date, msg_id
    for k, v in headers.items():
        m[k.replace("_", "-")] = v
    m.set_content(body)
    return m


def test_mbox_import(conn, vcf_path, tmp_path):
    vcard.import_vcards(conn, vcf_path)
    path = tmp_path / "mail.mbox"
    box = mailbox.mbox(path)
    box.add(_email("Marcus Lee <marcus@example.com>", "me@home.org", "News", "Big news: we're moving to Denver in May.\n\nOn Tue, Oct 1 2026 Me wrote:\n> old stuff", "Tue, 06 Oct 2026 10:00:00 +0000", "<1@x>"))
    box.add(_email("Me <me@home.org>", "Dana Fox <dana@fox.io>", "Intro", "Great meeting you", "Wed, 07 Oct 2026 10:00:00 +0000", "<2@x>"))
    box.add(_email("Dana Fox <dana@fox.io>", "me@home.org", "Re: Intro", "Likewise!", "Thu, 08 Oct 2026 10:00:00 +0000", "<3@x>"))
    box.add(_email("Shop <deals@shop.com>", "me@home.org", "Sale", "50% off", "Thu, 08 Oct 2026 10:00:00 +0000", "<4@x>", List_Unsubscribe="<mailto:u@shop.com>"))
    box.add(_email("Stranger <who@else.com>", "me@home.org", "hi", "hello", "Thu, 08 Oct 2026 10:00:00 +0000", "<5@x>"))
    box.close()

    stats = mbox.import_mbox(conn, path, ["me@home.org"])
    assert stats["interactions"] == 3
    marcus = identity.lookup(conn, "Marcus")
    text = conn.execute("SELECT text FROM interactions WHERE person_id = ?", (marcus["id"],)).fetchone()["text"]
    assert text.startswith("Subject: News\nBig news") and "old stuff" not in text
    dana = identity.lookup(conn, "Dana Fox")
    dirs = [r["direction"] for r in conn.execute("SELECT direction FROM interactions WHERE person_id = ? ORDER BY at", (dana["id"],))]
    assert dirs == ["out", "in"]
    for q in ("Shop", "Stranger"):
        try:
            identity.lookup(conn, q)
            raise AssertionError(f"{q} should not exist")
        except identity.PersonNotFound:
            pass


def make_mino_db(path):
    import sqlite3

    c = sqlite3.connect(path)
    c.executescript(
        """
        CREATE TABLE accounts(account_id TEXT PRIMARY KEY, provider TEXT NOT NULL, updated_at REAL NOT NULL);
        CREATE TABLE messages(account_id TEXT NOT NULL, message_id TEXT NOT NULL, thread_id TEXT NOT NULL, subject TEXT NOT NULL,
            sender_name TEXT NOT NULL, sender_email TEXT NOT NULL, date REAL NOT NULL, body_text TEXT NOT NULL,
            quoted_text TEXT, is_from_me INTEGER NOT NULL, list_unsubscribe BLOB, reply_context BLOB, PRIMARY KEY(account_id, message_id));
        CREATE TABLE participants(account_id TEXT NOT NULL, thread_id TEXT NOT NULL, message_id TEXT, role TEXT NOT NULL,
            position INTEGER NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL, normalized_email TEXT NOT NULL, domain TEXT NOT NULL);
        CREATE TABLE labels(account_id TEXT NOT NULL, message_id TEXT NOT NULL, name TEXT NOT NULL);
        CREATE TABLE directory_contacts(account_id TEXT NOT NULL, normalized_email TEXT NOT NULL, email TEXT NOT NULL, name TEXT NOT NULL);
        INSERT INTO accounts VALUES ('me@gmail.com', 'gmail', 0), ('imap:me@work.io', 'imap', 0);
        INSERT INTO directory_contacts VALUES ('me@gmail.com', 'dana@fox.io', 'dana@fox.io', 'Dana Fox');
        """
    )
    ts = lambda day: at(day).timestamp()
    msgs = [
        # (account, id, subject, sender_name, sender, day, body, from_me, unsubscribe, recipients, labels)
        ("me@gmail.com", "m1", "News", "Marcus Lee", "marcus@example.com", "2026-10-06", "We're moving to Denver in May.", 0, None, [], ["INBOX", "CATEGORY_PERSONAL"]),
        ("me@gmail.com", "m2", "Intro", "Me", "me@gmail.com", "2026-10-07", "Great meeting you", 1, None, [("", "dana@fox.io"), ("Me", "me@work.io")], ["SENT"]),
        ("imap:me@work.io", "m3", "Re: Intro", "", "dana@fox.io", "2026-10-08", "Likewise!", 0, None, [], []),
        ("me@gmail.com", "m4", "Sale", "Shop", "deals@shop.com", "2026-10-08", "50% off", 0, b"<mailto:u>", [], []),
        ("me@gmail.com", "m5", "hi", "Stranger", "who@else.com", "2026-10-08", "hello", 0, None, [], []),
        ("me@gmail.com", "m6", "Your receipt", "Marcus Lee", "marcus@example.com", "2026-10-09", "promo", 0, None, [], ["CATEGORY_PROMOTIONS"]),
        ("me@gmail.com", "m7", "Old", "Marcus Lee", "marcus@example.com", "2020-01-01", "old news", 0, None, [], []),
    ]
    for acct, mid, subj, sname, sender, day, body, from_me, unsub, rcpts, labels in msgs:
        context = json.dumps({"messageID": f"<{mid}@x>", "references": [], "replyTo": []}).encode()
        c.execute("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?)", (acct, mid, f"t-{mid}", subj, sname, sender, ts(day), body, from_me, unsub, context))
        for i, (name, email) in enumerate(rcpts):
            c.execute("INSERT INTO participants VALUES (?, ?, ?, 'to', ?, ?, ?, ?, ?)", (acct, f"t-{mid}", mid, i, name, email, email, email.split("@")[1]))
        for label in labels:
            c.execute("INSERT INTO labels VALUES (?, ?, ?)", (acct, mid, label))
    c.commit()
    c.close()


def test_mino_import(conn, vcf_path, tmp_path):
    from mypeople.importers import mino

    vcard.import_vcards(conn, vcf_path)
    path = tmp_path / "mail.sqlite"
    make_mino_db(path)
    stats = mino.import_mino(conn, path, since=__import__("datetime").date(2025, 1, 1))
    assert stats == {"messages": 5, "interactions": 3, "skipped": 2}

    marcus = identity.lookup(conn, "Marcus")
    rows = conn.execute("SELECT channel, direction, text FROM interactions WHERE person_id = ?", (marcus["id"],)).fetchall()
    assert [tuple(r) for r in rows] == [("email", "in", "Subject: News\nWe're moving to Denver in May.")]

    # Written to from one account, replied from another; named from Mino's contacts.
    dana = identity.lookup(conn, "Dana Fox")
    dirs = [r["direction"] for r in conn.execute("SELECT direction FROM interactions WHERE person_id = ? ORDER BY at", (dana["id"],))]
    assert dirs == ["out", "in"]
    for q in ("Shop", "Stranger", "me@work.io"):
        with pytest.raises(identity.PersonNotFound):
            identity.lookup(conn, q)
    # Re-running is idempotent; widening the window picks up older mail.
    assert mino.import_mino(conn, path, since=__import__("datetime").date(2025, 1, 1))["interactions"] == 0
    assert mino.import_mino(conn, path)["interactions"] == 1


def test_gmail_takeout_labels(conn, vcf_path, tmp_path):
    vcard.import_vcards(conn, vcf_path)
    path = tmp_path / "takeout.mbox"
    box = mailbox.mbox(path)
    box.add(_email("Marcus Lee <marcus@example.com>", "me@home.org", "Hi", "real", "Tue, 06 Oct 2026 10:00:00 +0000", "<a@x>", X_Gmail_Labels="Inbox,Category Personal"))
    box.add(_email("Marcus Lee <marcus@example.com>", "me@home.org", "Deal", "promo", "Tue, 06 Oct 2026 11:00:00 +0000", "<b@x>", X_Gmail_Labels="Archived,Category Promotions"))
    box.add(_email("Marcus Lee <marcus@example.com>", "me@home.org", "Spam", "spam", "Tue, 06 Oct 2026 12:00:00 +0000", "<c@x>", X_Gmail_Labels="Spam"))
    box.add(_email("Me <me@home.org>", "Dana Fox <dana@fox.io>", "Sent", "bcc", "Wed, 07 Oct 2026 10:00:00 +0000", "<d@x>", X_Gmail_Labels="Sent", Bcc="Dana Fox <dana@fox.io>"))
    box.close()
    assert mbox.import_mbox(conn, path, ["me@home.org"])["interactions"] == 2


def test_mbox_and_mino_dedupe(conn, vcf_path, tmp_path):
    """The same email imported from a Takeout export and from Mino counts once."""
    from mypeople.importers import mino

    vcard.import_vcards(conn, vcf_path)
    path = tmp_path / "mail.mbox"
    box = mailbox.mbox(path)
    box.add(_email("Marcus Lee <marcus@example.com>", "me@gmail.com", "News", "We're moving to Denver in May.", "Tue, 06 Oct 2026 10:00:00 +0000", "<m1@x>"))
    box.close()
    assert mbox.import_mbox(conn, path, ["me@gmail.com"])["interactions"] == 1
    db = tmp_path / "mino.sqlite"
    make_mino_db(db)
    mino.import_mino(conn, db, since=__import__("datetime").date(2025, 1, 1))
    marcus = identity.lookup(conn, "Marcus")
    assert conn.execute("SELECT COUNT(*) FROM interactions WHERE person_id = ?", (marcus["id"],)).fetchone()[0] == 1


def make_whatsapp_dir(root):
    import sqlite3

    from mypeople.importers.imessage import APPLE_EPOCH

    apple = lambda day, hour=12: (at(day, hour) - APPLE_EPOCH).total_seconds()
    root.mkdir()
    c = sqlite3.connect(root / "ContactsV2.sqlite")
    c.execute("CREATE TABLE ZWAADDRESSBOOKCONTACT (ZLID TEXT, ZWHATSAPPID TEXT, ZFULLNAME TEXT)")
    c.executemany("INSERT INTO ZWAADDRESSBOOKCONTACT VALUES (?, ?, ?)", [
        ("111@lid", "15559876543@s.whatsapp.net", "Priya Shah"),
        ("222@lid", "34600000001@s.whatsapp.net", "Lucía Gómez"),
    ])
    c.commit(); c.close()

    c = sqlite3.connect(root / "ChatStorage.sqlite")
    c.executescript(
        """
        CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZSESSIONTYPE INTEGER, ZCONTACTJID TEXT, ZCONTACTIDENTIFIER TEXT, ZPARTNERNAME TEXT);
        CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT);
        CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZGROUPMEMBER INTEGER, ZSTANZAID TEXT,
            ZMESSAGEDATE REAL, ZISFROMME INTEGER, ZTEXT TEXT, ZPUSHNAME TEXT, ZMESSAGETYPE INTEGER);
        INSERT INTO ZWACHATSESSION VALUES
            (1, 0, '222@lid', '34600000001@s.whatsapp.net', 'Lucía'),   -- 1:1, LID chat with a phone identifier
            (2, 0, '333@lid', NULL, 'Spammer'),                          -- 1:1 never answered, no number
            (3, 1, 'grp@g.us', NULL, 'Climbing'),                        -- group
            (4, 3, 'status@broadcast', NULL, NULL);                      -- status updates
        INSERT INTO ZWAGROUPMEMBER VALUES (1, '111@lid', NULL), (2, '999@lid', 'Rando');
        """
    )
    c.executemany("INSERT INTO ZWAMESSAGE VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", [
        (1, 1, None, "s1", apple("2026-10-01"), 0, "¡Me caso en junio!", None, 0),
        (2, 1, None, "s2", apple("2026-10-01", 13), 1, "congrats!!", None, 0),
        (3, 1, None, "s3", apple("2026-10-01", 14), 0, None, None, 1),            # photo, no caption
        (4, 1, None, "s4", apple("2026-10-01", 15), 0, "Lucía changed her number", None, 6),  # system notice
        (5, 2, None, "s5", apple("2026-10-02"), 0, "buy crypto", None, 0),
        (6, 3, 1, "s6", apple("2026-10-03"), 0, "send me the beta", "Priya", 0),
        (7, 3, 2, "s7", apple("2026-10-03", 13), 0, "hi all", "Rando", 0),         # stranger in group
        (8, 3, None, "s8", apple("2026-10-03", 14), 1, "see you saturday", None, 0),
        (9, 4, None, "s9", apple("2026-10-04"), 0, "status", None, 0),
    ])
    c.commit(); c.close()

    c = sqlite3.connect(root / "CallHistory.sqlite")
    c.executescript(
        """
        CREATE TABLE ZWAAGGREGATECALLEVENT (Z_PK INTEGER PRIMARY KEY, ZINCOMING INTEGER, ZMISSED INTEGER);
        CREATE TABLE ZWACDCALLEVENT (Z_PK INTEGER PRIMARY KEY, Z1CALLEVENTS INTEGER, ZCALLIDSTRING TEXT, ZDATE REAL, ZDURATION REAL);
        CREATE TABLE ZWACDCALLEVENTPARTICIPANT (Z_PK INTEGER PRIMARY KEY, Z1PARTICIPANTS INTEGER, ZJIDSTRING TEXT);
        INSERT INTO ZWAAGGREGATECALLEVENT VALUES (1, 0, 0), (2, 1, 1);
        INSERT INTO ZWACDCALLEVENTPARTICIPANT VALUES (1, 1, '111@lid'), (2, 2, '222@lid');
        """
    )
    c.executemany("INSERT INTO ZWACDCALLEVENT VALUES (?, ?, ?, ?, ?)", [
        (1, 1, "call-1", apple("2026-10-05"), 600.0),   # 10 minute call I made to Priya
        (2, 2, "call-2", apple("2026-10-06"), 0.0),     # missed call from Lucía
    ])
    c.commit(); c.close()


def test_whatsapp_import(conn, vcf_path, tmp_path):
    from mypeople.importers import whatsapp

    vcard.import_vcards(conn, vcf_path)
    root = tmp_path / "wa"
    make_whatsapp_dir(root)
    stats = whatsapp.import_whatsapp(conn, root)
    assert stats["interactions"] == 5  # Lucía x3, Priya group message, Priya call

    lucia = identity.lookup(conn, "Lucía")  # new person: written to on WhatsApp, named from WhatsApp contacts
    assert identity.find_by_identifier(conn, "phone", "+34600000001") == lucia["id"]
    rows = conn.execute("SELECT direction, text FROM interactions WHERE person_id = ? ORDER BY at", (lucia["id"],)).fetchall()
    assert [tuple(r) for r in rows] == [("in", "¡Me caso en junio!"), ("out", "congrats!!"), ("in", None)]

    priya = identity.lookup(conn, "Priya")  # LID group member resolved to her address-book number
    rows = conn.execute("SELECT channel, direction, thread FROM interactions WHERE person_id = ? ORDER BY at", (priya["id"],)).fetchall()
    assert [tuple(r) for r in rows] == [("whatsapp", "in", "group chat"), ("whatsapp-call", "out", None)]

    for q in ("Spammer", "Rando"):
        with pytest.raises(identity.PersonNotFound):
            identity.lookup(conn, q)
    assert whatsapp.import_whatsapp(conn, root)["interactions"] == 0


VOICE_TEXT = """<html><body><div class="hChatLog hfeed">
<div class="message"><abbr class="dt" title="2026-10-01T09:00:00.000-04:00">Oct 1</abbr>:
<cite class="sender vcard"><a class="tel" href="tel:+15559876543"><span class="fn">Priya Shah</span></a></cite>:
<q>Landed in Austin!<br>Dinner?</q></div>
<div class="message"><abbr class="dt" title="2026-10-01T09:05:00.000-04:00">Oct 1</abbr>:
<cite class="sender vcard"><a class="tel" href="tel:+15550009999"><span class="fn"></span></a></cite>:
<q>yes!!</q></div>
</div></body></html>"""

VOICE_SPAM = """<html><body><div class="hChatLog hfeed">
<div class="message"><abbr class="dt" title="2026-10-02T09:00:00.000-04:00">Oct 2</abbr>:
<cite class="sender vcard"><a class="tel" href="tel:+18005551212"><span class="fn"></span></a></cite>:
<q>Your car warranty is expiring</q></div></div></body></html>"""

VOICEMAIL = """<html><body><div class="haudio"><span class="fn">Voicemail from Lucía</span>
<div class="contributor vcard"><a class="tel" href="tel:+14155550000"><span class="fn"></span></a></div>
<abbr class="published" title="2026-10-03T10:00:00.000-07:00">Oct 3</abbr>
<span class="description"><span class="full-text">Hey it's Lucía, call me back about the wedding.</span>
<span class="word high">Hey<span class="start-time">0</span></span></span></div></body></html>"""


def test_gvoice_import(conn, vcf_path, tmp_path):
    from mypeople.importers import gvoice

    vcard.import_vcards(conn, vcf_path)
    voice = tmp_path / "Voice"
    (voice / "Calls").mkdir(parents=True)
    (voice / "Phones.vcf").write_text("BEGIN:VCARD\nVERSION:3.0\nFN:Me\nitem1.TEL:+15550009999\nitem1.X-ABLabel:Google Voice\nEND:VCARD\n")
    (voice / "Calls" / "+15559876543 - Text - 2026-10-01T13_00_00Z.html").write_text(VOICE_TEXT)
    (voice / "Calls" / "+18005551212 - Text - 2026-10-02T13_00_00Z.html").write_text(VOICE_SPAM)
    (voice / "Calls" / "+14155550000 - Voicemail - 2026-10-03T17_00_00Z.html").write_text(VOICEMAIL)
    (voice / "Calls" / "+14155550000 - Missed - 2026-10-03T16_59_00Z.html").write_text("<html></html>")

    records = gvoice.parse_file(voice / "Calls" / "+15559876543 - Text - 2026-10-01T13_00_00Z.html")
    assert records[0]["text"] == "Landed in Austin!\nDinner?" and records[0]["name"] == "Priya Shah"

    stats = gvoice.import_gvoice(conn, voice)
    assert stats["interactions"] == 2  # Priya in + my reply; spam and unknown voicemail skipped
    priya = identity.lookup(conn, "Priya")
    rows = conn.execute("SELECT channel, direction, text FROM interactions WHERE person_id = ? ORDER BY at", (priya["id"],)).fetchall()
    assert [tuple(r) for r in rows] == [("gvoice", "in", "Landed in Austin!\nDinner?"), ("gvoice", "out", "yes!!")]

    # Once Lucía is a known person, her voicemail comes in with its transcript.
    identity.resolve(conn, [("phone", "4155550000")], "Lucía", "test")
    gvoice.import_gvoice(conn, voice)
    lucia = identity.lookup(conn, "Lucía")
    row = conn.execute("SELECT channel, text FROM interactions WHERE person_id = ?", (lucia["id"],)).fetchone()
    assert tuple(row) == ("voicemail", "(voicemail) Hey it's Lucía, call me back about the wedding.")
    assert gvoice.import_gvoice(conn, voice)["interactions"] == 0


def test_gvoice_named_threads_and_unanswered(conn, tmp_path):
    from mypeople.importers import gvoice

    voice = tmp_path / "Voice"
    (voice / "Calls").mkdir(parents=True)
    (voice / "Phones.vcf").write_text("BEGIN:VCARD\nitem1.TEL:+15550009999\nEND:VCARD\n")
    mine = lambda t: f'<div class="message"><abbr class="dt" title="{t}">x</abbr><cite class="sender vcard"><a class="tel" href="tel:+15550009999"><span class="fn"></span></a></cite><q>hi</q></div>'
    theirs = f'<div class="message"><abbr class="dt" title="2026-10-01T10:00:00-04:00">x</abbr><cite class="sender vcard"><a class="tel" href="tel:+15551230000"><span class="fn">Shawn</span></a></cite><q>hey</q></div>'
    # Named after the contact, with a reply.
    (voice / "Calls" / "Shawn - Text - 2026-10-01T13_00_00Z.html").write_text(f"<html><body>{mine('2026-10-01T09:00:00-04:00')}{theirs}</body></html>")
    # You texted, they never replied.
    (voice / "Calls" / "+15557770000 - Text - 2026-10-02T13_00_00Z.html").write_text(f"<html><body>{mine('2026-10-02T09:00:00-04:00')}</body></html>")
    assert gvoice.import_gvoice(conn, voice)["interactions"] == 3
    shawn = identity.lookup(conn, "Shawn")
    dirs = [r["direction"] for r in conn.execute("SELECT direction FROM interactions WHERE person_id = ? ORDER BY at", (shawn["id"],))]
    assert dirs == ["out", "in"]
    assert identity.find_by_identifier(conn, "phone", "5557770000")


def test_snapchat_import(conn, vcf_path, tmp_path):
    from mypeople.importers import snapchat

    vcard.import_vcards(conn, vcf_path)
    me = identity.resolve(conn, [("email", "me@example.com")], "Me Myself", "test")
    identity.set_me(conn, [me])

    def msg(sender, created, text, is_sender, media="TEXT", title=None):
        return {"From": sender, "Media Type": media, "Created": created, "Content": text, "Conversation Title": title,
                "IsSender": is_sender, "Created(microseconds)": hash(created + sender) % 10**12, "IsSaved": False}

    j = tmp_path / "mydata" / "json"
    j.mkdir(parents=True)
    (j / "account.json").write_text(json.dumps({"Basic Information": {"Username": "me_snap"}}))
    (j / "friends.json").write_text(json.dumps({"Friends": [
        {"Username": "mlee", "Display Name": "Marcus Lee"},  # matches the address-book Marcus
        {"Username": "zz", "Display Name": "Zed"},
        {"Username": "lurker", "Display Name": "Never Written"},
    ]}))
    (j / "chat_history.json").write_text(json.dumps({
        "mlee": [msg("mlee", "2024-03-01 10:00:00 UTC", "got the job!", False),
                 msg("me_snap", "2024-03-01 10:05:00 UTC", "congrats", True),
                 msg("mlee", "2024-03-02 10:00:00 UTC", None, False, media="MEDIA"),
                 msg("mlee", "2024-03-02 10:01:00 UTC", None, False, media="STATUSSAVETOCAMERAROLL")],
        "zz": [msg("me_snap", "2024-04-01 10:00:00 UTC", "yo", True)],
        "lurker": [msg("lurker", "2024-04-01 10:00:00 UTC", "hi", False)],
        "0b3b0161-164c-4198-8502-0b1bde328a19": [
            msg("zz", "2024-05-01 10:00:00 UTC", "group hello", False, title="Crew"),
            msg("me_snap", "2024-05-01 10:01:00 UTC", "hey all", True, title="Crew")],
    }))
    (j / "snap_history.json").write_text(json.dumps({"mlee": [
        {"From": "mlee", "Media Type": "IMAGE", "Created": "2024-03-03 10:00:00 UTC", "Conversation Title": None,
         "IsSender": False, "Created(microseconds)": 1}]}))

    stats = snapchat.import_snapchat(conn, tmp_path / "mydata")
    marcus = identity.lookup(conn, "Marcus Lee")["id"]
    assert identity.find_by_identifier(conn, "snapchat", "mlee") == marcus
    link = conn.execute("SELECT * FROM profiles WHERE person_id=?", (marcus,)).fetchone()
    assert (link["site"], link["url"], link["status"]) == ("snapchat", "https://www.snapchat.com/add/mlee", "confirmed")
    assert not conn.execute("SELECT 1 FROM profiles WHERE person_id=?", (me,)).fetchone()
    assert identity.find_by_identifier(conn, "snapchat", "me_snap") == me
    assert identity.find_by_identifier(conn, "snapchat", "lurker") is None  # never written to
    zed = identity.find_by_identifier(conn, "snapchat", "zz")
    assert conn.execute("SELECT name FROM people WHERE id = ?", (zed,)).fetchone()["name"] == "Zed"
    rows = conn.execute("SELECT person_id, direction, text, thread FROM interactions WHERE channel = 'snapchat' ORDER BY at").fetchall()
    assert [(r["person_id"], r["direction"], r["text"]) for r in rows if r["person_id"] == marcus] == [
        (marcus, "in", "got the job!"), (marcus, "out", "congrats"), (marcus, "in", None), (marcus, "in", None)]
    assert [(r["text"], r["thread"]) for r in rows if r["person_id"] == zed] == [("yo", None), ("group hello", "group chat")]
    assert stats["interactions"] == 6
    assert snapchat.import_snapchat(conn, tmp_path / "mydata")["interactions"] == 0  # re-import is a no-op
    assert conn.execute("SELECT COUNT(*) FROM profiles WHERE person_id=?", (marcus,)).fetchone()[0] == 1


def test_google_contacts_import(conn, vcf_path):
    from mypeople.importers import gcontacts

    vcard.import_vcards(conn, vcf_path)
    contacts = [
        {"resourceName": "people/c1", "names": [{"displayName": "Marcus Lee"}], "nicknames": [{"value": "Marky"}],
         "phoneNumbers": [{"value": "+1 (555) 123-4567", "canonicalForm": "+15551234567"}],
         "organizations": [{"name": "VCU Health", "title": "Nurse"}], "addresses": [{"city": "Richmond"}],
         "birthdays": [{"date": {"month": 10, "day": 25}}]},
        {"resourceName": "people/c2", "names": [{"displayName": "New Person"}], "emailAddresses": [{"value": "New@Example.com"}],
         "birthdays": [{"date": {"year": 1991, "month": 3, "day": 4}}]},
        {"resourceName": "people/c3", "names": [{"displayName": "Made By MyPeople"}],
         "memberships": [{"contactGroupMembership": {"contactGroupResourceName": "contactGroups/mypeople"}}]},
        {"resourceName": "people/c4"},
    ]
    stats = gcontacts.import_google_contacts(conn, contacts, "contactGroups/mypeople")
    assert stats["people"] == 2 and stats["skipped"] == 2
    marcus = identity.lookup(conn, "Marcus Lee")["id"]
    assert identity.find_by_identifier(conn, "google", "people/c1") == marcus  # matched the vCard person by phone
    assert "Marky" in identity.aliases(conn, marcus)
    assert any(e["value"] == "Works as Nurse at VCU Health" for e in events_for(conn, marcus))
    new = identity.find_by_identifier(conn, "email", "new@example.com")
    assert [e["date"] for e in events_for(conn, new) if e["type"] == "birthday"] == ["1991-03-04"]
    assert gcontacts.import_google_contacts(conn, contacts, "contactGroups/mypeople")["events"] == 0  # re-import adds nothing


def test_instagram_import(conn, vcf_path, tmp_path):
    from mypeople.importers import instagram

    vcard.import_vcards(conn, vcf_path)
    me = identity.resolve(conn, [("email", "me@example.com")], "Me Myself", "test")
    identity.set_me(conn, [me])
    garble = lambda s: s.encode("utf-8").decode("latin-1")  # how Instagram writes non-ASCII text
    root = tmp_path / "ig"
    info = root / "personal_information" / "personal_information"
    info.mkdir(parents=True)
    (info / "personal_information.json").write_text(json.dumps(
        {"profile_user": [{"string_map_data": {"Name": {"value": "Me Myself"}, "Username": {"value": "me"}}}]}))

    def thread(folder, names, messages):
        d = root / "your_instagram_activity" / "messages" / "inbox" / folder
        d.mkdir(parents=True)
        (d / "message_1.json").write_text(json.dumps({"participants": [{"name": n} for n in names], "messages": messages}))

    msg = lambda who, ms, text=None: {"sender_name": who, "timestamp_ms": ms, **({"content": text} if text else {})}
    thread("marcuslee_111", ["Marcus Lee", "Me Myself"], [
        msg("Marcus Lee", 1_700_000_000_000, garble("café tomorrow? 😂")),
        msg("Me Myself", 1_700_000_100_000, "yes!"),
        msg("Marcus Lee", 1_700_000_200_000, "Reacted 😂 to your message "),
        msg("Me Myself", 1_700_000_300_000, "Me Myself sent an attachment."),
        msg("Marcus Lee", 1_700_000_400_000),  # a shared post: contact, no text
    ])
    thread("lurker_222", ["Lurker Person", "Me Myself"], [msg("Lurker Person", 1_700_000_000_000, "hi")])
    thread("crew_333", ["Marcus Lee", "Lurker Person", "Instagram User", "Me Myself"], [
        msg("Marcus Lee", 1_700_000_500_000, "group hello"), msg("Me Myself", 1_700_000_600_000, "hey all"),
        msg("Instagram User", 1_700_000_700_000, "from a deleted account")])

    stats = instagram.import_instagram(conn, root)
    marcus = identity.lookup(conn, "Marcus Lee")["id"]
    assert identity.find_by_identifier(conn, "instagram", "marcus lee") == marcus  # joined the address-book Marcus
    assert identity.find_by_identifier(conn, "instagram", "lurker person") is None  # never written to
    assert identity.find_by_identifier(conn, "instagram", "me myself") == me
    rows = conn.execute("SELECT direction, text, thread FROM interactions WHERE channel = 'instagram' ORDER BY at").fetchall()
    assert [(r["direction"], r["text"], r["thread"]) for r in rows] == [
        ("in", "café tomorrow? 😂", None), ("out", "yes!", None), ("in", None, None), ("in", "group hello", "group chat")]
    assert stats["interactions"] == 4
    assert instagram.import_instagram(conn, root)["interactions"] == 0  # re-import is a no-op


def test_linkedin_import(conn, vcf_path, tmp_path):
    from mypeople.importers import linkedin

    vcard.import_vcards(conn, vcf_path)
    me = identity.resolve(conn, [("email", "me@example.com")], "Me Myself", "test")
    identity.set_me(conn, [me])
    root = tmp_path / "li"
    root.mkdir()
    (root / "Connections.csv").write_text(
        'Notes:\n"Some email addresses are missing."\n\n'
        "First Name,Last Name,URL,Email Address,Company,Position,Connected On\n"
        "Marcus,Lee 🚀,https://www.linkedin.com/in/marcuslee,,Acme,Designer,01 Jan 2024\n"
        "Pen,Pal,https://www.linkedin.com/in/pen-pal-123,,,,02 Jan 2024\n"
        "Quiet,Stranger,https://www.linkedin.com/in/quiet,,Big Co,CEO,03 Jan 2024\n"
    )
    (root / "Invitations.csv").write_text(
        "From,To,Sent At,Message,Direction,inviterProfileUrl,inviteeProfileUrl\n"
        "Me,Pen Pal,\"1/2/24, 8:00 AM\",,OUTGOING,https://www.linkedin.com/in/me,https://www.linkedin.com/in/pen-pal-123\n"
    )
    header = '"CONVERSATION ID","CONVERSATION TITLE","FROM","SENDER PROFILE URL","TO","RECIPIENT PROFILE URLS","DATE","SUBJECT","CONTENT","FOLDER","ATTACHMENTS"\n'
    me_url, pal_url = "https://www.linkedin.com/in/me", "https://www.linkedin.com/in/pen-pal-123"
    rows = [
        ("c1", "", "Pen Pal", pal_url, "🖋 Me Myself", me_url, "2024-01-03 10:00:00 UTC", "", "<p>hey <b>there</b></p>", "INBOX"),
        ("c1", "", "🖋 Me Myself", me_url, "Pen Pal", pal_url, "2024-01-03 11:00:00 UTC", "", "hi!", "INBOX"),
        ("c2", "", "Recruiter Rita", "https://www.linkedin.com/in/rita", "Me", me_url, "2024-01-04 10:00:00 UTC", "Role", "Great fit", "INBOX"),
        ("c3", "Sponsored Conversation", "Ad Co", "https://www.linkedin.com/in/adco", "Me", me_url, "2024-01-05 10:00:00 UTC", "", "buy", "INBOX"),
    ]
    lines = [",".join(f'"{v}"' for v in (*r, "")) for r in rows]
    (root / "messages.csv").write_text(header + "\n".join(lines) + "\n")

    stats = linkedin.import_linkedin(conn, root)
    marcus = identity.lookup(conn, "Marcus Lee")["id"]
    assert identity.find_by_identifier(conn, "linkedin", "marcuslee") == marcus  # matched by unique full name
    assert identity.find_by_identifier(conn, "linkedin", "me") == me
    assert identity.find_by_identifier(conn, "linkedin", "quiet") is None  # never messaged, unknown: not a person
    assert identity.find_by_identifier(conn, "linkedin", "rita") is None  # wrote to you, never answered
    pal = identity.find_by_identifier(conn, "linkedin", "pen-pal-123")
    assert conn.execute("SELECT name FROM people WHERE id = ?", (pal,)).fetchone()["name"] == "Pen Pal"
    job = conn.execute("SELECT value, said_at FROM events WHERE person_id = ? AND type = 'job'", (marcus,)).fetchone()
    assert (job["value"], job["said_at"]) == ("Works as Designer at Acme", "")  # known, not news
    profile = conn.execute("SELECT url, status FROM profiles WHERE person_id = ?", (marcus,)).fetchone()
    assert (profile["url"], profile["status"]) == ("https://linkedin.com/in/marcuslee", "confirmed")
    texts = [r["text"] for r in conn.execute("SELECT text FROM interactions WHERE channel = 'linkedin' ORDER BY at")]
    assert texts == ["hey there", "hi!"]
    assert stats["linked"] == 2 and stats["interactions"] == 2
    assert linkedin.import_linkedin(conn, root)["interactions"] == 0  # re-import is a no-op


def _js(path, name, data):
    path.write_text(f"window.YTD.{name}.part0 = " + json.dumps(data, indent=2))


def _dm(sender, recipient, text, msg_id, at="2026-10-01T15:00:00.000Z", urls=()):
    body = {"senderId": sender, "text": text, "id": msg_id, "createdAt": at, "urls": list(urls), "mediaUrls": [], "reactions": []}
    if recipient:
        body["recipientId"] = recipient
    return {"messageCreate": body}


def test_twitter_import(conn, tmp_path):
    from mypeople.importers import twitter

    root = tmp_path / "x"
    (root / "data").mkdir(parents=True)
    me, sam, rasha, ghost, stranger = "100", "200", "300", "400", "500"
    _js(root / "data" / "account.js", "account", [{"account": {"accountId": me, "username": "jo"}}])
    _js(root / "data" / "tweets.js", "tweets", [
        {"tweet": {"entities": {"user_mentions": [{"id_str": sam, "screen_name": "SamRivera", "name": "Sam Rivera"}]}}},
        {"tweet": {"entities": {"user_mentions": []}, "in_reply_to_user_id_str": rasha, "in_reply_to_screen_name": "rasha_h"}},
    ])
    _js(root / "data" / "direct-messages.js", "direct_messages", [
        {"dmConversation": {"conversationId": f"{me}-{sam}", "messages": [
            _dm(sam, me, "moving to Denver https://t.co/x", "1", urls=[{"url": "https://t.co/x", "expanded": "https://zillow.com/a"}]),
            _dm(me, sam, "congrats!", "2")]}},
        {"dmConversation": {"conversationId": f"{rasha}-{me}", "messages": [_dm(me, rasha, "hey", "3")]}},
        {"dmConversation": {"conversationId": f"{me}-{ghost}", "messages": [_dm(me, ghost, "who is this", "4"), _dm(ghost, me, "it's me", "5")]}},
        {"dmConversation": {"conversationId": f"{me}-{stranger}", "messages": [_dm(stranger, me, "buy crypto", "6")]}},
    ])
    _js(root / "data" / "direct-messages-group.js", "direct_messages_group", [
        {"dmConversation": {"conversationId": "g1", "messages": [
            _dm(sam, None, "group hello", "7"), _dm(me, None, "my own group message", "8"), {"participantsLeave": {"userIds": [sam]}}]}},
    ])
    existing = identity.resolve(conn, [("email", "sam@r.io")], "Sam Rivera", "test")
    conn.commit()

    stats = twitter.import_twitter(conn, root)
    assert stats["unnamed_accounts"] == [(ghost, 2)]  # you wrote to them, but the archive never names them
    sam_id = identity.find_by_identifier(conn, "x", sam)
    assert sam_id == existing  # matched by full display name
    texts = [r["text"] for r in conn.execute("SELECT text FROM interactions WHERE person_id = ? ORDER BY id", (sam_id,))]
    assert texts == ["moving to Denver https://zillow.com/a", "congrats!", "group hello"]
    assert conn.execute("SELECT url FROM profiles WHERE person_id = ?", (sam_id,)).fetchone()["url"] == "https://x.com/samrivera"
    rasha_row = conn.execute("SELECT name FROM people WHERE id = ?", (identity.find_by_identifier(conn, "x", rasha),)).fetchone()
    assert rasha_row["name"] == "@rasha_h"  # only a handle known; a real name replaces it later
    assert identity.find_by_identifier(conn, "x", stranger) is None  # never written to

    # Naming the unknown account brings in its conversation; re-importing adds nothing else.
    names = tmp_path / "names.txt"
    names.write_text(f"# id handle name\n{ghost} @gh0st Gabriel Host\n")
    again = twitter.import_twitter(conn, root, names=names)
    assert again["interactions"] == 2 and again["unnamed"] == 0
    assert conn.execute("SELECT name FROM people WHERE id = ?", (identity.find_by_identifier(conn, "x", ghost),)).fetchone()["name"] == "Gabriel Host"


def test_twitter_review_names_unknown_accounts(conn, tmp_path, monkeypatch):
    from mypeople import cli
    from mypeople.importers import twitter

    root = tmp_path / "x"
    (root / "data").mkdir(parents=True)
    me, ana, bo = "100", "600", "700"
    _js(root / "data" / "account.js", "account", [{"account": {"accountId": me, "username": "jo"}}])
    shared = [{"url": "https://t.co/a", "expanded": "https://x.com/ana_codes/status/1"}]
    _js(root / "data" / "direct-messages.js", "direct_messages", [
        {"dmConversation": {"conversationId": f"{me}-{ana}", "messages": [
            _dm(me, ana, "hi Ana!", "1", at="2026-10-01T15:00:00.000Z"),
            _dm(ana, me, "my new post https://t.co/a", "2", at="2026-10-01T15:01:00.000Z", urls=shared),
            _dm(ana, me, "see you", "3", at="2026-10-01T15:02:00.000Z")]}},
        {"dmConversation": {"conversationId": f"{me}-{bo}", "messages": [_dm(me, bo, "yo", "4")]}},
    ])
    rob = identity.create_person(conn, "Bo Rivera")
    conn.commit()
    twitter.import_twitter(conn, root)

    pending = twitter.unnamed(conn, root)
    assert [u.account_id for u in pending] == [ana, bo]
    assert pending[0].tweets_shared == ["ana_codes"]
    assert pending[0].messages[0][1:] == (True, "hi Ana!")

    # Name Ana as someone new with her handle; link Bo to the Bo Rivera you already have.
    answers = iter(["m", "Ana Lopez @ana_codes", "Bo Rivera", "y"])
    monkeypatch.setattr("builtins.input", lambda prompt="": next(answers))
    assert cli._review_x(conn, root) == 2
    stats = twitter.import_twitter(conn, root)
    assert stats["unnamed"] == 0 and stats["interactions"] == 4
    ana_id = identity.find_by_identifier(conn, "x", ana)
    assert conn.execute("SELECT name FROM people WHERE id = ?", (ana_id,)).fetchone()["name"] == "Ana Lopez"
    assert conn.execute("SELECT url FROM profiles WHERE person_id = ?", (ana_id,)).fetchone()["url"] == "https://x.com/ana_codes"
    assert identity.find_by_identifier(conn, "x", bo) == rob
    assert twitter.unnamed(conn, root) == []
