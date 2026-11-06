"""Native Kotlin-authored synthetic graph, consumed by the real Python engine."""
import json
from pathlib import Path

from mypeople import db, graph_runtime
from mypeople.graph import Store

FIXTURE = Path(__file__).parent / "fixtures/android-native-graph.json"


def test_native_graph_retains_every_authored_contact_property_and_decision(conn):
    native = json.loads(FIXTURE.read_text())
    graph_runtime.receive(conn, native)
    conn.commit()
    rows = {r["name"]: r for r in conn.execute("SELECT * FROM people WHERE merged_into IS NULL")}
    assert set(rows) == {"Native Cameron", "Native Split"}
    cameron = json.loads(rows["Native Cameron"]["contact_data"])
    assert cameron["given"] == "Native"
    assert cameron["family"] == "Cameron"
    assert cameron["birthday"] == "--02-29"
    assert cameron["organization"] == "Synthetic Lab"
    assert cameron["favorite"] is True
    assert cameron["originals"] == ["BEGIN:VCARD\nFN:Native Cameron\nX-RETAIN:yes\nEND:VCARD"]
    assert cameron["notes"] == "Native card note"
    assert {f["value"] for f in cameron["fields"]} == {"+442079460018", "native@example.test", "https://example.test/native"}
    assert {r["value"] for r in conn.execute("SELECT value FROM events WHERE status='active'")} >= {"Native graph note", "Graph protocols"}
    prefs = conn.execute("SELECT * FROM relationship_overrides WHERE person_id=?", (rows["Native Cameron"]["id"],)).fetchone()
    assert prefs["category"] == "friend" and prefs["cadence_days"] == 21 and prefs["muted"] == 1
    assert json.loads(rows["Native Split"]["contact_data"])["notes"] == "Other note"
    before = Store(conn).load().commits
    graph_runtime.receive(conn, native)
    conn.commit()
    assert Store(conn).load().commits == before


def test_native_graph_survives_sql_projection_rebuild_and_second_peer(conn):
    graph_runtime.receive(conn, json.loads(FIXTURE.read_text()))
    conn.commit()
    second = db.connect(":memory:")
    try:
        graph_runtime.receive(second, graph_runtime.bundle(conn))
        second.commit()
        assert Store(conn).load().commits == Store(second).load().commits
        first = {r["contact_uid"]: json.loads(r["contact_data"]) for r in conn.execute("SELECT * FROM people WHERE merged_into IS NULL")}
        copied = {r["contact_uid"]: json.loads(r["contact_data"]) for r in second.execute("SELECT * FROM people WHERE merged_into IS NULL")}
        assert copied == first
    finally:
        second.close()
