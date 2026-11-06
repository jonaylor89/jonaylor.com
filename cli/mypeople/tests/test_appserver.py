"""The macOS app's engine, driven mostly the way the app drives it: a real process over stdio.

Every process here gets a throwaway HOME, so nothing can reach a real ~/.mypeople.
"""

import base64
import datetime as dt
import json
import os
import queue
import sqlite3
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

from mypeople import appjobs, appserver, db, jobevents, publish, replica
from mypeople.events import add_event
from mypeople.importers.common import add_interaction

FIXTURE = Path(__file__).parents[3] / "macos/mypeople/MyPeopleKit/Tests/MyPeopleKitTests/Fixtures/engine-view.json"
TIMEOUT = 30
JPEG = b"\xff\xd8\xff" + b"0" * 64
PNG = b"\x89PNG\r\n\x1a\n" + b"0" * 64


def seed(conn: sqlite3.Connection, root: Path) -> dict[str, int]:
    """A small memory touching every record kind. Synthetic, and rich enough to compare views."""
    ids = {}
    for name, fields in (("Ada Lovelace", [{"kind": "email", "value": "ada@example.test", "label": "Home"}]),
                         ("Ada", [{"kind": "phone", "value": "+442079460000", "label": "Mobile"}]),
                         ("Grace Hopper", [{"kind": "website", "value": "https://example.test/grace"}]),
                         ("Alan Turing", [])):
        history = replica.capture(conn)
        change = history.edit(str(__import__("uuid").uuid4()), {"name": name, "region": "GB", "fields": fields, "originals": ["BEGIN:VCARD"]})
        replica.receive(conn, [change])
        ids[name] = conn.execute("SELECT id FROM people WHERE contact_uid = ?", (change["contact_uid"],)).fetchone()[0]
    conn.commit()
    today = dt.date.today()
    add_interaction(conn, ids["Ada Lovelace"], f"{today} 09:00:00", "imessage", "in", "see you soon", None, "m1")
    add_interaction(conn, ids["Ada"], f"{today - dt.timedelta(days=9)} 09:00:00", "whatsapp", "out", "hello again", None, "m2")
    add_event(conn, ids["Ada Lovelace"], "job", "Analyst", "1843", 1.0, "manual")
    add_event(conn, ids["Ada"], "plan", "Visit the engine", str(today + dt.timedelta(days=3)), 0.9, "imessage", evidence="a quote")
    add_event(conn, ids["Grace Hopper"], "birthday", "Birthday", str(today.replace(year=1906)), 1.0, "vcard")
    conn.execute("INSERT INTO profiles (person_id, site, url, title, confidence, status, assessment, reason) VALUES "
                 "(?, 'github', 'https://github.com/ada', 'Ada', 0.8, 'suggested', 'supported', 'Matches'), "
                 "(?, 'github', 'https://github.com/grace', 'Grace', 1, 'confirmed', 'supported', 'Yours')",
                 (ids["Ada Lovelace"], ids["Grace Hopper"]))
    conn.execute("INSERT INTO moments (key, person_id, kind, reason, context, score, surfaced_on) VALUES ('m:1', ?, 'upcoming', 'A reason', 'Context', 0.9, ?)",
                 (ids["Ada"], str(today)))
    photo = root / "alan.jpg"
    photo.write_bytes(JPEG)
    conn.execute("INSERT INTO photos (person_id, source, path, width) VALUES (?, 'contacts', ?, 64)", (ids["Alan Turing"], str(photo)))
    conn.commit()
    return ids


class Engine:
    """The app's side of the conversation."""

    def __init__(self, home: Path, script: str | None = None):
        self.db = home / ".mypeople" / "mypeople.db"
        self.env = {**os.environ, "HOME": str(home), "MYPEOPLE_DB": str(self.db), "MYPEOPLE_ENV_FILE": str(home / "secrets.ini"),
                    "MYPEOPLE_PI_AUTH": str(home / "no-auth.json")}
        argv = [sys.executable, "-c", script, str(self.db)] if script else [sys.executable, "-m", "mypeople", "app-server"]
        self.process = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=self.env)
        self.frames: queue.Queue = queue.Queue()
        self.log: list[dict] = []
        self.next_id = 1
        self.garbage: list[bytes] = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for raw in self.process.stdout:
            try:
                self.frames.put(json.loads(raw))
            except ValueError:
                self.garbage.append(raw)

    def next_frame(self) -> dict:
        frame = self.frames.get(timeout=TIMEOUT)
        self.log.append(frame)
        return frame

    def request(self, method: str, **params) -> dict:
        id = self.next_id
        self.next_id += 1
        self.process.stdin.write((json.dumps({"id": id, "method": method, "params": params}) + "\n").encode())
        self.process.stdin.flush()
        while (frame := self.next_frame()).get("id") != id:
            pass
        return frame

    def call(self, method: str, **params):
        frame = self.request(method, **params)
        assert "error" not in frame, frame
        return frame["result"]

    def error(self, method: str, **params) -> dict:
        frame = self.request(method, **params)
        assert "error" in frame, frame
        return frame["error"]

    def wait_event(self, name: str, match=lambda p: True) -> dict:
        deadline = time.monotonic() + TIMEOUT
        for frame in self.log:
            if frame.get("event") == name and match(frame["params"]):
                return frame["params"]
        while time.monotonic() < deadline:
            frame = self.next_frame()
            if frame.get("event") == name and match(frame["params"]):
                return frame["params"]
        raise AssertionError(f"no {name}")

    def view(self) -> dict[tuple[str, str], dict]:
        """A snapshot, kept current by applying every delta seen afterwards."""
        snapshot = self.call("view.snapshot")
        self.mark = len(self.log)
        return {(r["kind"], r["id"]): r["data"] for r in snapshot["records"]}

    def apply_deltas(self, view: dict) -> dict:
        for frame in self.log[self.mark:]:
            if frame.get("event") == "view.delta":
                for r in frame["params"]["upserts"]:
                    view[(r["kind"], r["id"])] = r["data"]
                for r in frame["params"]["deletes"]:
                    view.pop((r["kind"], r["id"]), None)
        self.mark = len(self.log)
        return view

    def close(self):
        self.process.stdin.close()
        assert self.process.wait(timeout=TIMEOUT) == 0


@pytest.fixture
def home(tmp_path):
    (tmp_path / ".mypeople").mkdir()
    return tmp_path


@pytest.fixture
def seeded(home):
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    ids = seed(conn, home)
    conn.close()
    return ids


@pytest.fixture
def engine(home):
    e = Engine(home)
    yield e
    e.close()


# --- framing ------------------------------------------------------------------------------

def test_hello_reports_protocol_and_database(engine):
    hello = engine.call("app.hello")
    assert hello["protocol"] == appserver.PROTOCOL
    assert hello["db"] == str(engine.db.resolve())


def test_stray_print_and_input_cannot_touch_the_protocol(home):
    script = """
import sys
from pathlib import Path
from mypeople import appserver

@appserver.method("test.noisy")
def noisy(self, conn, p):
    print("stray output from deep in a domain function")
    try:
        input("are you sure? ")
    except EOFError:
        return {"eof": True}
    return {"eof": False}

appserver.serve(Path(sys.argv[1]))
"""
    e = Engine(home, script)
    # A second request is already waiting: input() must not swallow it.
    assert e.call("test.noisy") == {"eof": True}
    assert e.call("app.hello")["protocol"] == appserver.PROTOCOL
    e.close()
    assert e.garbage == []


def test_bad_frames_get_errors_and_the_engine_survives(engine):
    engine.process.stdin.write(b"not json\n[1, 2]\n")
    engine.process.stdin.flush()
    assert engine.next_frame()["error"]["code"] == "invalid"
    assert engine.next_frame()["error"]["code"] == "invalid"
    assert engine.error("no.such.method")["code"] == "unknown_method"
    assert engine.error("contact.get", uid=7)["code"] == "invalid"
    assert engine.call("app.hello")


def test_encoding_survives_what_imports_and_models_produce():
    line = appserver.encode({"name": "lone \ud83d surrogate", "score": float("nan"), "nested": [float("inf")]})
    assert line.endswith(b"\n") and line.count(b"\n") == 1
    frame = json.loads(line)
    assert frame["score"] is None and frame["nested"] == [None]


# --- the view -----------------------------------------------------------------------------

def test_snapshot_is_the_published_view_without_private_bulk(home, seeded):
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    uid = conn.execute("SELECT contact_uid FROM people WHERE id = ?", (seeded["Ada"],)).fetchone()[0]
    replica.change(conn, uid, values={"photo": base64.b64encode(PNG).decode()})
    conn.commit()
    conn.close()
    e = Engine(home)
    view = e.view()
    assert {k for k, _ in view} == {"person", "event", "profile", "moment", "dupes"}
    for (kind, _), data in view.items():
        if kind == "person" and data["card"]:
            assert not {"photo", "originals", "source_records"} & set(data["card"])
    alan = view[("person", str(seeded["Alan Turing"]))]
    assert Path(alan["avatar_path"]).read_bytes() == JPEG
    # A photo chosen in the editor is materialized as a private file.
    avatar = Path(view[("person", str(seeded["Ada"]))]["avatar_path"])
    assert avatar.read_bytes() == PNG and avatar.suffix == ".png" and avatar.stat().st_mode & 0o077 == 0
    assert view[("person", str(seeded["Grace Hopper"]))]["avatar_path"] is None
    e.close()


def test_scoped_publish_matches_the_full_view(home, seeded):
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    full, files = publish.records(conn)
    everyone = set(seeded.values())
    scoped, scoped_files = publish.records(conn, people=everyone)
    assert scoped == {k: v for k, v in full.items() if k[0] not in ("dupes", "contact_change")}
    assert scoped_files == files
    ada = seeded["Ada"]
    one, _ = publish.records(conn, people={ada})
    assert ("person", str(ada)) in one
    assert all(int(k[1]) == ada if k[0] == "person" else v["person_id"] == ada for k, v in one.items())


def test_scoped_view_never_picks_moments_or_writes(home, seeded):
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    before = conn.execute("SELECT COUNT(*) FROM moments").fetchone()[0]
    publish.records(conn, people={seeded["Ada"]})
    assert conn.execute("SELECT COUNT(*) FROM moments").fetchone()[0] == before
    assert not conn.in_transaction


def test_an_edit_is_visible_before_its_response(engine):
    engine.view()
    saved = engine.call("contact.save", card={"name": "Ada", "region": "GB"})
    deltas = [f for f in engine.log if f.get("event") == "view.delta"]
    assert deltas, "the delta must arrive before the response"
    people = [r for f in deltas for r in f["params"]["upserts"] if r["kind"] == "person"]
    assert any(r["id"] == str(saved["person_id"]) for r in people)
    assert any(r["data"]["name"] == "Ada" for r in people)


def test_deltas_from_every_edit_keep_the_view_identical_to_a_fresh_one(home, seeded):
    e = Engine(home)
    view = e.view()
    uid = lambda name: view[("person", str(seeded[name]))]["contact_uid"]
    grace, ada, full_ada = seeded["Grace Hopper"], seeded["Ada"], seeded["Ada Lovelace"]
    grace_uid, ada_uid = uid("Grace Hopper"), uid("Ada")

    e.call("contact.patch", uid=grace_uid, values={"name": "Grace B. Hopper"})
    e.call("contact.patch", uid=grace_uid, values={"favorite": True})
    e.call("edit.apply", kind="alias_add", payload={"person_id": grace, "alias": "Amazing Grace"})
    event = e.call("edit.apply", kind="event_add", payload={"person_id": grace, "type": "achievement", "value": "COBOL", "date": "1959"})
    assert event["message"] == "Added."
    forgotten = next(k[1] for k, v in view.items() if k[0] == "event" and v["person_id"] == full_ada)
    e.call("edit.apply", kind="event_forget", payload={"event_id": int(forgotten)})
    e.call("edit.apply", kind="relationship", payload={"person_id": grace, "category": "friend", "muted": True, "cadence_days": 30})
    profile = next(k[1] for k, v in view.items() if k[0] == "profile" and v["status"] == "suggested")
    e.call("edit.apply", kind="profile_status", payload={"profile_id": int(profile), "status": "rejected"})
    e.call("edit.apply", kind="moment_status", payload={"key": "m:1", "status": "done"})
    created = e.call("contact.save", card={"name": "Linus T", "region": "US", "fields": [{"kind": "email", "value": "l@example.test"}]})
    e.call("contact.trash", uid=created["uid"])
    e.call("contact.trash", uid=created["uid"], trashed=False)
    e.call("contact.trash", uid=ada_uid)
    e.call("contact.trash", uid=ada_uid, trashed=False)
    merged = e.call("people.merge", ids=[ada, full_ada])
    assert merged["person_id"] in (ada, full_ada)

    patched = {k: v for k, v in e.apply_deltas(view).items() if k[0] != "dupes"}
    e.close()
    fresh_engine = Engine(home)
    fresh = {k: v for k, v in fresh_engine.view().items() if k[0] != "dupes"}
    fresh_engine.close()
    assert patched == fresh
    # And the edits really are in there.
    assert fresh[("person", str(grace))]["name"] == "Grace B. Hopper"
    assert fresh[("person", str(grace))]["card"]["favorite"] is True
    assert fresh[("person", str(grace))]["muted"] is True
    assert ("event", forgotten) not in fresh and ("profile", profile) not in fresh
    dropped = ada if merged["person_id"] == full_ada else full_ada
    assert ("person", str(dropped)) not in fresh


def _in_process(home, **kw):
    sink: list[dict] = []
    engine = appserver.Engine(home / ".mypeople" / "mypeople.db", lambda data: sink.append(json.loads(data)), poll=0.02, min_refresh=0.02, **kw)
    return engine, sink


def _wait(predicate, timeout=TIMEOUT):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_commits_from_other_processes_reach_the_view(home, seeded):
    engine, sink = _in_process(home)
    engine.start()
    assert engine.view.ready.wait(TIMEOUT)
    other = db.connect(home / ".mypeople" / "mypeople.db")
    add_event(other, seeded["Grace Hopper"], "plan", "Spotted by the watcher", "", 1.0, "manual")
    other.commit()
    other.close()
    def arrived():
        return any(r["kind"] == "event" and r["data"]["value"] == "Spotted by the watcher"
                   for f in sink if f.get("event") == "view.delta" for r in f["params"]["upserts"])
    assert _wait(arrived)
    engine.stopping.set()


def test_a_full_refresh_overlapping_an_edit_is_thrown_away(home, seeded):
    engine, sink = _in_process(home)
    real_build, calls = engine.view.build, []
    def overlapping(conn, people=None):
        result = real_build(conn, people)
        if people is None:
            calls.append(1)
            if len(calls) == 2:
                # An edit lands after this view was read, and before it's adopted.
                with engine.view.lock:
                    engine.view.records[("person", "999")] = {"name": "Edited meanwhile"}
                engine.edits += 1
        return result
    engine.view.build = overlapping
    engine.start()
    assert engine.view.ready.wait(TIMEOUT)
    engine.wake_refresh()
    assert _wait(lambda: len(calls) >= 2)
    time.sleep(0.005)
    assert ("person", "999") in engine.view.records, "the overlapping refresh must not be adopted"
    assert _wait(lambda: len(calls) >= 3), "and it must be rerun"
    engine.stopping.set()


def test_the_date_changing_alone_causes_a_refresh(home, seeded, monkeypatch):
    engine, sink = _in_process(home)
    engine.start()
    assert engine.view.ready.wait(TIMEOUT)
    assert _wait(lambda: sum(f.get("event") == "view.state" and f["params"]["refreshing"] for f in sink) == 1)
    monkeypatch.setattr(appserver, "_today", lambda: dt.date.today() + dt.timedelta(days=1))
    assert _wait(lambda: sum(f.get("event") == "view.state" and f["params"]["refreshing"] for f in sink) >= 2)
    engine.stopping.set()


# --- contacts -----------------------------------------------------------------------------

def test_saving_a_stale_card_is_refused_and_nothing_changes(engine):
    created = engine.call("contact.save", card={"name": "Ada", "region": "GB"})
    loaded = engine.call("contact.get", uid=created["uid"])
    engine.call("contact.patch", uid=created["uid"], values={"organization": "Analytical Engines"})
    conflict = engine.error("contact.save", uid=created["uid"], card={**loaded["card"], "notes": "stale"}, fingerprint=loaded["fingerprint"])
    assert conflict["code"] == "conflict"
    current = engine.call("contact.get", uid=created["uid"])
    assert current["card"]["organization"] == "Analytical Engines" and current["card"]["notes"] == ""
    engine.call("contact.save", uid=created["uid"], card={**current["card"], "notes": "fresh"}, fingerprint=current["fingerprint"])
    assert engine.call("contact.get", uid=created["uid"])["card"]["notes"] == "fresh"


def test_a_card_round_trips_unknown_keys_and_marks_only_new_websites(engine):
    created = engine.call("contact.save", card={"name": "Ada", "region": "GB", "x_future_key": "kept",
                                                "fields": [{"kind": "website", "value": "https://example.test/old"}]})
    loaded = engine.call("contact.get", uid=created["uid"])
    assert loaded["card"]["x_future_key"] == "kept"
    fields = [*loaded["card"]["fields"], {"kind": "website", "value": "https://github.com/ada-new"}]
    engine.call("contact.save", uid=created["uid"], card={**loaded["card"], "fields": fields}, fingerprint=loaded["fingerprint"])
    saved = engine.call("contact.get", uid=created["uid"])["card"]
    assert saved["x_future_key"] == "kept" and saved["user_edited"] is True
    by_value = {f["value"]: f for f in saved["fields"]}
    assert by_value["https://github.com/ada-new"]["user_added"] is True


def test_invalid_cards_leave_no_transaction_open(engine):
    assert engine.error("contact.save", card={"name": "  "})["code"] == "invalid"
    assert engine.error("contact.save", card={"name": "Ada", "region": "XX"})["code"] == "invalid"
    assert engine.error("contact.save", card="nope")["code"] == "invalid"
    assert engine.error("contact.get", uid="00000000-0000-0000-0000-000000000000")["code"] == "not_found"
    assert engine.call("contact.save", card={"name": "Ada", "region": "GB"})["person_id"]


def test_conflicts_resolve_through_causal_history(home):
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    history = replica.capture(conn)
    first = history.edit("00000000-0000-4000-8000-000000000001", {"name": "Ada"})
    replica.receive(conn, [first])
    conn.commit()
    history = replica.load(conn)
    # Two devices edit the same field without having seen each other.
    a = history.edit(first["contact_uid"], values={"notes": "from the phone"})
    b = history.edit(first["contact_uid"], values={"notes": "from the Mac"})
    replica.receive(conn, [a, b])
    conn.commit()
    conn.close()
    e = Engine(home)
    view = e.view()
    person = next(v for k, v in view.items() if k[0] == "person")
    choices = person["contact_conflicts"]["notes"]
    assert len(choices) == 2
    assert e.error("contact.resolve", uid=first["contact_uid"], field="notes", change="nope")["code"] == "invalid"
    chosen = choices[0]
    e.call("contact.resolve", uid=first["contact_uid"], field="notes", change=chosen["change"])
    person = next(v for k, v in e.apply_deltas(view).items() if k[0] == "person")
    assert person["contact_conflicts"] == {} and person["card"]["notes"] == chosen["value"]
    history = e.call("contact.history", uid=first["contact_uid"])
    assert history["total"] == 4 and history["changes"][0]["parents"] >= 1
    e.close()


def test_history_hides_photos_and_raw_vcard_properties(home):
    e = Engine(home)
    created = e.call("contact.save", card={"name": "Ada", "region": "GB", "photo": base64.b64encode(JPEG).decode(), "originals": ["BEGIN:VCARD secret"]})
    dump = json.dumps(e.call("contact.history", uid=created["uid"]))
    assert "BEGIN:VCARD" not in dump and "<photo>" in dump and base64.b64encode(JPEG).decode() not in dump
    e.close()


def test_the_view_says_where_a_call_should_go_and_refuses_to_guess(home):
    e = Engine(home)
    view = e.view()
    local = e.call("contact.save", card={"name": "Local", "region": "GB", "fields": [{"kind": "phone", "value": "020 7946 0000 ext 12"}]})
    garbage = e.call("contact.save", card={"name": "Garbage", "region": "GB", "fields": [{"kind": "phone", "value": "12"}, {"kind": "email", "value": "g@example.test"}]})
    legacy = e.call("contact.save", card={"name": "Legacy", "legacy_unverified": True, "fields": [
        {"kind": "phone", "value": "2079460000"}, {"kind": "phone", "value": "+442079460000"}]})
    view = e.apply_deltas(view)
    fields = lambda saved: view[("person", str(saved["person_id"]))]["card"]["fields"]
    assert (fields(local)[0]["dial"], fields(local)[0]["dial_ext"]) == ("+442079460000", "12")
    assert fields(garbage)[0]["dial"] == "" and "dial" not in fields(garbage)[1]
    assert fields(legacy)[0]["dial"] == "" and fields(legacy)[1]["dial"] == "+442079460000"
    # The editor's copy is the stored card: display hints must not be saved back.
    assert "dial" not in e.call("contact.get", uid=local["uid"])["card"]["fields"][0]
    e.close()


def test_vcard_export_writes_full_cards_that_import_cleanly(home, tmp_path):
    from mypeople.importers.vcard import import_vcards

    e = Engine(home)
    photo = base64.b64encode(JPEG).decode()
    first = e.call("contact.save", card={
        "name": "Ada; Lovelace", "region": "GB", "given": "Ada", "family": "Lovelace", "organization": "Engines, Ltd", "photo": photo, "favorite": True,
        "notes": "line one\nline two " + "long " * 40, "fields": [
            {"kind": "phone", "value": "020 7946 0000", "label": "Mobile", "preferred": True}, {"kind": "email", "value": "ada@example.test"}],
        "originals": ["BEGIN:VCARD\r\nX-CUSTOM:kept\r\nFN:Old\r\nEND:VCARD\r\n"]})
    second = e.call("contact.save", card={"name": "Grace", "region": "US"})
    target = tmp_path / "out.vcf"
    assert e.call("contact.export", uids=[first["uid"], second["uid"]], path=str(target)) == {"count": 2, "path": str(target)}
    text = target.read_bytes().decode()
    assert text.count("BEGIN:VCARD") == 2 and all(len(line.encode()) <= 75 for line in text.split("\r\n"))
    unfolded = text.replace("\r\n ", "")
    assert "item0.TEL;TYPE=PREF:+442079460000" in unfolded and "item0.X-SHERLOQ-ORIGINAL-PHONE:020 7946 0000" in unfolded
    assert "X-CUSTOM:kept" in unfolded and "FN:Old" not in unfolded and f"PHOTO;ENCODING=b;TYPE=JPEG:{photo}" in unfolded
    assert "FN:Ada\\; Lovelace" in unfolded and "ORG:Engines\\, Ltd" in unfolded
    assert e.error("contact.export", uids=[], path=str(target))["code"] == "invalid"
    assert e.error("contact.export", uids=[first["uid"]], path=str(tmp_path / "missing" / "x.vcf"))["code"] == "invalid"
    e.close()
    conn = db.connect(":memory:")
    import_vcards(conn, target)
    names = {r["name"] for r in conn.execute("SELECT name FROM people")}
    assert names == {"Ada; Lovelace", "Grace"}
    assert conn.execute("SELECT COUNT(*) FROM identifiers WHERE kind = 'phone' AND value LIKE '%2079460000'").fetchone()[0] == 1


def test_a_broken_stdout_stops_the_engine_from_any_thread(home):
    """The app died without closing our stdin: the next frame, sent from any lane, ends the engine."""
    read, write = os.pipe()
    env = {**os.environ, "HOME": str(home), "MYPEOPLE_DB": str(home / ".mypeople" / "mypeople.db"),
           "MYPEOPLE_ENV_FILE": str(home / "secrets.ini"), "MYPEOPLE_PI_AUTH": str(home / "no-auth.json")}
    process = subprocess.Popen([sys.executable, "-m", "mypeople", "app-server"], stdin=subprocess.PIPE, stdout=write, stderr=subprocess.DEVNULL, env=env)
    os.close(write)
    os.close(read)
    process.stdin.write(b'{"id": 1, "method": "contact.save", "params": {"card": {"name": "Grace", "region": "GB"}}}\n')
    process.stdin.flush()
    assert process.wait(timeout=TIMEOUT) == 0
    process.stdin.close()


# --- other edits --------------------------------------------------------------------------

def test_only_listed_edits_reach_ops(engine):
    for kind in ("contact_save", "contact_change", "merge", "note", "extract", "find_profiles", "photos", "rename", "nonsense"):
        assert engine.error("edit.apply", kind=kind, payload={})["code"] == "invalid", kind


def test_edit_errors_are_reported_and_change_nothing(home, seeded):
    e = Engine(home)
    assert e.error("edit.apply", kind="event_forget", payload={"event_id": 999999})["code"] == "invalid"
    assert e.error("edit.apply", kind="relationship", payload={"person_id": seeded["Ada"], "closeness": 7})["code"] == "invalid"
    assert e.error("edit.apply", kind="alias_add", payload={"person_id": 999999, "alias": "x"})["code"] == "invalid"
    assert e.error("people.merge", ids=[seeded["Ada"]])["code"] == "invalid"
    assert e.error("people.merge", ids=[seeded["Ada"], 999999])["code"] == "invalid"
    e.close()


def test_me_hides_the_record_from_the_view(home, seeded):
    e = Engine(home)
    view = e.view()
    assert e.call("me.get") == {"person": None}
    me = e.call("me.set", ids=[seeded["Alan Turing"]])
    assert me["person"]["name"] == "Alan Turing"
    assert ("person", str(seeded["Alan Turing"])) not in e.apply_deltas(view)
    assert e.call("me.get")["person"]["id"] == seeded["Alan Turing"]
    e.close()


def test_moment_preview_records_nothing(home, seeded):
    # Far enough ahead that today's real refresh has no reason to surface it.
    birthday = dt.date.today() + dt.timedelta(days=60)
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    add_event(conn, seeded["Ada"], "birthday", "Birthday", birthday.strftime("--%m-%d"), 1.0, "manual")
    conn.commit()
    conn.close()
    e = Engine(home)
    e.view()  # the first refresh has already recorded today's moments
    day = str(birthday - dt.timedelta(days=1))
    moments = e.call("moments.preview", date=day, limit=3)["moments"]
    assert any(m["kind"] == "birthday" and m["person_id"] == seeded["Ada"] for m in moments)
    assert e.error("moments.preview", date="not a date")["code"] == "invalid"
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    recorded = "SELECT COUNT(*) FROM moments WHERE kind = 'birthday' AND person_id = ?"
    assert conn.execute(recorded, (seeded["Ada"],)).fetchone()[0] == 0
    conn.close()
    e.close()


def test_review_shows_the_evidence_the_published_view_omits(home, seeded):
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    conn.execute("UPDATE profiles SET snippet = 'a snippet', evidence = ?, sources = ? WHERE status = 'suggested'",
                 (json.dumps({"page": {"access": "ok"}, "matches": []}), json.dumps([{"source": "exa"}])))
    conn.commit()
    conn.close()
    e = Engine(home)
    [profile] = e.call("profiles.review")["profiles"]
    assert profile["snippet"] == "a snippet" and profile["evidence"]["page"]["access"] == "ok" and profile["sources"] == [{"source": "exa"}]
    e.close()


def test_duplicate_cards_show_both_records_side_by_side(home, seeded):
    e = Engine(home)
    result = e.call("dupes.cards", ids=[seeded["Ada Lovelace"], seeded["Ada"]])
    assert [c["name"] for c in result["cards"]] == ["Ada Lovelace", "Ada"]
    assert result["cards"][0]["channels"] == [{"channel": "imessage", "count": 1}]
    assert isinstance(result["clues"], list)
    e.close()


def test_a_merge_can_be_undone_from_the_view_until_the_records_move_on(home, seeded):
    e = Engine(home)
    view = e.view()
    keep = e.call("people.merge", ids=[seeded["Ada Lovelace"], seeded["Ada"]])["person_id"]
    gone = ({seeded["Ada Lovelace"], seeded["Ada"]} - {keep}).pop()
    # The deltas sent before the reply already show it, and agree with a fresh snapshot.
    view = e.apply_deltas(view)
    assert ("person", str(gone)) not in view
    assert view[("person", str(keep))]["can_undo_merge"] is True

    assert e.call("edit.apply", kind="merge_undo", payload={"person_id": keep})["message"] == "Merge undone."
    view = e.apply_deltas(view)
    assert ("person", str(gone)) in view
    assert view[("person", str(keep))]["can_undo_merge"] is False
    assert e.view()[("person", str(gone))] == view[("person", str(gone))]

    # Merged again, then edited: undoing would overwrite that edit, so it's no longer offered.
    keep = e.call("people.merge", ids=[seeded["Ada Lovelace"], seeded["Ada"]])["person_id"]
    uid = e.view()[("person", str(keep))]["contact_uid"]
    e.call("contact.patch", uid=uid, values={"favorite": True})
    # Saving can move the merged contact's root to the other record, whichever way its UUIDs fall.
    # Either way there's one Ada, with no leftover copy of the record that lost.
    ada = [d for (kind, _), d in e.view().items() if kind == "person" and d["name"].startswith("Ada")]
    assert len(ada) == 1 and ada[0]["can_undo_merge"] is False
    assert e.error("edit.apply", kind="merge_undo", payload={"person_id": keep})["code"] == "invalid"
    e.close()


def test_an_id_that_does_not_exist_is_refused_rather_than_searched_for_by_name(home, seeded):
    e = Engine(home)
    missing = 987654
    e.call("contact.save", card={"name": f"Agent {missing}", "region": "US", "fields": []})
    before = len(e.view())
    assert e.error("people.merge", ids=[seeded["Ada"], missing])["code"] == "invalid"
    assert e.error("dupes.cards", ids=[seeded["Ada"], missing])["code"] == "invalid"
    assert len(e.view()) == before
    e.close()


def test_merging_someone_with_themselves_is_refused(home, seeded):
    e = Engine(home)
    assert e.error("people.merge", ids=[seeded["Ada"], seeded["Ada"]])["code"] == "invalid"
    e.close()


def test_x_archive_review_names_a_conversation(home, tmp_path):
    root = tmp_path / "x"
    data = root / "data"
    data.mkdir(parents=True)
    (data / "account.js").write_text('window.YTD.account.part0 = [{"account": {"accountId": "1", "username": "me"}}]')
    (data / "direct-messages.js").write_text('window.YTD.direct_messages.part0 = ' + json.dumps([{"dmConversation": {
        "conversationId": "1-2", "messages": [{"messageCreate": {"senderId": "1", "recipientId": "2", "text": "hi", "createdAt": "2024-01-01T10:00:00.000Z", "id": "9"}}]}}]))
    e = Engine(home)
    [conversation] = e.call("twitter.unnamed", root=str(root))["conversations"]
    assert conversation["account_id"] == "2" and conversation["messages"][0]["mine"] is True
    assert e.error("twitter.name", account_id="2")["code"] == "invalid"
    assert e.call("twitter.name", account_id="2", name="Ada Lovelace", handle="ada")["person_id"]
    assert e.call("twitter.unnamed", root=str(root))["conversations"] == []
    assert e.error("twitter.unnamed", root=str(tmp_path / "missing"))["code"] == "invalid"
    e.close()


# --- secrets ------------------------------------------------------------------------------

def test_status_reports_that_a_secret_exists_but_never_its_value(home):
    (home / "secrets.ini").write_text("ANTHROPIC_API_KEY=value-that-must-not-leak\n")
    e = Engine(home)
    status = e.call("system.status")
    assert "must-not-leak" not in json.dumps(status)
    assert status["secrets"]["keys"] == {"ANTHROPIC_API_KEY": True}
    assert status["full_disk_access"] is None  # a throwaway HOME has no Messages database
    e.close()


def test_a_note_is_saved_as_written_without_a_model(home, seeded, monkeypatch):
    monkeypatch.setenv("MYPEOPLE_LLM", "nonexistent-backend")  # any model call would fail
    e = Engine(home)
    e.call("edit.apply", kind="note", payload={"person_id": seeded["Grace Hopper"], "text": "  Her daughter starts school in May  "})
    notes = [r for r in e.call("view.snapshot")["records"] if r["kind"] == "event" and r["data"]["type"] == "note"]
    assert [(n["data"]["value"], n["data"]["source"]) for n in notes] == [("Her daughter starts school in May", "manual")]
    e.close()


@pytest.mark.parametrize("method", ["sync.setup", "server.devices", "server.addDevice", "dupes.judge"])
def test_the_engine_no_longer_offers(home, method):
    e = Engine(home)
    assert e.error(method)["code"] in ("unknown_method", "invalid", "not_found")
    e.close()


# --- jobs ---------------------------------------------------------------------------------

EVERY_JOB = {
    "import": [{"source": s, "path": "/tmp/x", "since": "2024-01-01"} for s in appjobs.IMPORT_SOURCES]
              + [{"source": "imessage"}, {"source": "mbox", "path": "/tmp/m", "me": ["a@example.test", "b@example.test"]},
                 {"source": "twitter", "path": "/tmp/x", "names": "/tmp/names.txt"}],
    "ask": [{"question": "who do I know in Lisbon?"}, {"question": "--help"}],
    "google_login": [{}],
    "google_sync": [{}, {"apply": True, "photos": True, "no_notes": True, "create": True},
                    {"person_ids": [1, 2], "min_messages": 5, "show": 50, "show_notes": True, "show_fields": True}],
    "transfer_qr": [{}, {"minutes": 5, "no_photos": True}],
    "transfer_export": [{"path": "/tmp/m.sherloq", "no_photos": True}, {"path": "/tmp/m.sherloq", "send": True}],
    "transfer_import": [{"path": "/tmp/e.sherloq"}],
    "transfer_merge": [{"path": "/tmp/m.sherloq"}],
    "recover_phones": [{}, {"google": True, "apply": True}],
}


def test_every_job_kind_is_covered_here():
    assert set(EVERY_JOB) == set(appjobs.JOBS)


@pytest.mark.parametrize("kind,params", [(k, p) for k, cases in EVERY_JOB.items() for p in cases])
def test_every_job_builds_a_command_line_the_cli_accepts(kind, params):
    # build_argv checks with the real parser, so the CLI's options can't drift from this table.
    argv = appjobs.build_argv(kind, params, db_path=Path("/tmp/t.db"))
    assert argv[:3] == [sys.executable, "-m", "mypeople"] and argv[3:5] == ["--db", "/tmp/t.db"]


def test_job_options_mean_what_they_say():
    from mypeople.cli import build_parser

    def parse(kind, **params):
        return build_parser().parse_args(appjobs.build_argv(kind, params, db_path=Path("/tmp/t.db"))[3:])

    assert parse("ask", question="--help").question == ["--help"]
    google = parse("google_sync", apply=True, person_ids=[1, 2], min_messages=0)
    assert (google.apply, google.person, google.min_messages) == (True, ["1", "2"], 0)
    assert parse("transfer_qr").no_open is True  # the app shows the QR itself


def test_reading_messages_for_facts_stays_in_the_cli():
    # An older phone can still queue a request, so both ways in have to leave it for the CLI.
    for kind, params in (("transfer_qr", {}), ("transfer_import", {"path": "/tmp/e.sherloq"})):
        assert "--no-enrich" in appjobs.build_argv(kind, params, db_path=Path("/tmp/t.db"))
    assert not {"extract", "note", "socials_find", "photos", "sync", "server_run"} & set(appjobs.JOBS)


@pytest.mark.parametrize("kind,params", [
    ("nonsense", {}),
    ("import", {"source": "nonsense"}),
    ("import", {"source": "vcf", "since": "yesterday"}),
    ("ask", {}),
    ("google_sync", {"person_ids": "1"}),
    ("transfer_export", {}),
    ("transfer_qr", {"minutes": "soon"}),
    ("extract", {}),
    ("sync", {}),
])
def test_invalid_job_requests_are_refused(kind, params):
    with pytest.raises(appjobs.JobError):
        appjobs.build_argv(kind, params, db_path=Path("/tmp/t.db"))


def test_the_signal_export_job_runs_its_own_module():
    argv = appjobs.build_argv("signal_export", {"output": "/tmp/s.jsonl"}, db_path=Path("/tmp/t.db"))
    assert argv == [sys.executable, "-m", "mypeople.importers.signal_export", "/tmp/s.jsonl"]


def test_a_job_runs_streams_and_refreshes_the_view(home, seeded):
    e = Engine(home)
    vcf = home / "people.vcf"
    vcf.write_text("BEGIN:VCARD\nVERSION:3.0\nFN:Katherine Johnson\nEMAIL:katherine@example.test\nEND:VCARD\n")
    job = e.call("job.start", kind="import", params={"source": "vcf", "path": str(vcf)})
    e.wait_event("job.started", lambda p: p["id"] == job["id"] and p["kind"] == "import")
    finished = e.wait_event("job.finished", lambda p: p["id"] == job["id"])
    assert finished["status"] == "succeeded" and finished["code"] == 0
    e.wait_event("view.delta", lambda p: any(r["data"].get("name") == "Katherine Johnson" for r in p["upserts"]))
    e.close()


def test_a_failing_job_reports_the_clis_own_message(home):
    e = Engine(home)
    job = e.call("job.start", kind="import", params={"source": "vcf", "path": str(home / "missing.vcf")})
    finished = e.wait_event("job.finished", lambda p: p["id"] == job["id"])
    assert finished["status"] == "failed" and finished["message"]
    e.close()


def test_free_text_stays_out_of_job_announcements():
    assert appjobs._public({"person_id": 3, "text": "private note", "question": "private question"}) == {"person_id": 3}


def test_cancel_is_ctrl_c(home, tmp_path):
    fifo = tmp_path / "blocks-until-written.vcf"
    os.mkfifo(fifo)  # reading this waits forever, like a long-running job
    e = Engine(home)
    job = e.call("job.start", kind="import", params={"source": "vcf", "path": str(fifo)})
    e.call("job.cancel", id=job["id"])
    assert e.wait_event("job.finished", lambda p: p["id"] == job["id"])["status"] == "cancelled"
    e.call("job.cancel", id=job["id"])  # harmless once it's over
    e.close()


def test_singletons_stay_single_until_they_finish(tmp_path, monkeypatch):
    monkeypatch.setattr(appjobs, "build_argv", lambda *a, **k: [sys.executable, "-c", "input()"])
    finished = queue.Queue()
    runner = appjobs.JobRunner(lambda name, params: finished.put(params) if name == "job.finished" else None, tmp_path / "t.db")
    first = runner.start("transfer_qr", {})
    with pytest.raises(appjobs.JobError):
        runner.start("transfer_qr", {})
    runner.write(first["id"], "done")
    assert finished.get(timeout=TIMEOUT)["id"] == first["id"]
    runner.write(runner.start("transfer_qr", {})["id"], "done")  # the slot is free again
    assert finished.get(timeout=TIMEOUT)


def test_closing_the_app_stops_running_jobs(home, tmp_path):
    fifo = tmp_path / "blocks-until-written.vcf"
    os.mkfifo(fifo)
    e = Engine(home)
    e.call("job.start", kind="import", params={"source": "vcf", "path": str(fifo)})
    e.close()  # asserts a clean exit, which waits for the job
    out = subprocess.run(["pgrep", "-f", str(fifo)], capture_output=True, text=True).stdout
    assert out.strip() == ""


def test_a_waiting_job_can_be_answered(tmp_path, monkeypatch):
    events = []
    done = threading.Event()
    runner = appjobs.JobRunner(lambda name, p: events.append((name, p)), tmp_path / "t.db", on_finished=done.set)
    monkeypatch.setattr(appjobs, "build_argv", lambda *a, **k: [sys.executable, "-c", "print('got', input())"])
    job = runner.start("photos", {})
    runner.write(job["id"], "enter")
    assert done.wait(TIMEOUT)
    assert ("job.output", {"id": job["id"], "line": "got enter"}) in events
    with pytest.raises(appjobs.JobError):
        runner.write(job["id"], "too late")


def test_job_output_is_cleaned():
    assert appjobs.clean(b"\x1b[31mred\x1b[0m\x07 text \xff\n") == "red text �"
    assert len(appjobs.clean(b"x" * 10_000)) == appjobs.MAX_LINE


def test_job_events_are_silent_unless_asked_for(capsys, monkeypatch):
    jobevents.emit("qr", path="/tmp/x")
    assert capsys.readouterr().out == ""
    monkeypatch.setenv(jobevents.ENV, "1")
    jobevents.emit("qr", path="/tmp/x")
    line = capsys.readouterr().out.strip()
    assert jobevents.parse(line) == {"kind": "qr", "path": "/tmp/x"}
    assert jobevents.parse("ordinary output") is None
    assert jobevents.parse(jobevents.PREFIX + "not json") is None


# --- the cross-language contract ----------------------------------------------------------

def test_the_shared_fixture_has_exactly_the_keys_the_engine_sends(home, seeded):
    """The Swift suite decodes this same file, so a shape change fails on whichever side lags."""
    conn = db.connect(home / ".mypeople" / "mypeople.db")
    add_event(conn, seeded["Ada"], "birthday", "Birthday", "--12-25", 1.0, "manual")
    conn.execute("INSERT OR IGNORE INTO moments (key, person_id, kind, reason, context, score, surfaced_on) VALUES ('k', ?, 'birthday', 'r', 'c', 1, ?)", (seeded["Ada"], str(dt.date.today())))
    conn.commit()
    conn.close()
    e = Engine(home)
    live: dict[str, set] = {}
    live_cards: set = set()
    live_fields: set = set()
    for (kind, _), data in e.view().items():
        live.setdefault(kind, set()).update(data)
        if kind == "person" and data["card"]:
            live_cards.update(data["card"])
            for field in data["card"]["fields"]:
                live_fields.update(field)
    e.close()
    fixture = json.loads(FIXTURE.read_text())
    assert fixture["protocol"] == appserver.PROTOCOL
    shape: dict[str, set] = {}
    for record in fixture["records"]:
        shape.setdefault(record["kind"], set()).update(record["data"])
    live.setdefault("dupes", {"person_ids", "clues"})
    assert shape == live
    people = [r["data"] for r in fixture["records"] if r["kind"] == "person"]
    assert set().union(*(p["card"] for p in people)) == live_cards
    assert set().union(*(f for p in people for f in p["card"]["fields"])) == live_fields
