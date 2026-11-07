package app.mypeople.data

import java.io.File
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class SqlOwnerRowsTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun contactReadsUseOwnerIndexAndDecodeOnlyThatPersonsRows() {
        val delegate = JdbcGraphSql(temp.newFile("owners.sqlite"))
        val reads = mutableListOf<String>()
        val traced = object : GraphSql by delegate {
            override fun query(sql: String, args: List<Any?>): List<List<String?>> {
                if ("data FROM screen" in sql) reads += sql
                return delegate.query(sql, args)
            }
        }
        IndexedGraphDatabase(traced, File(temp.root, "blobs")).use { db ->
            db.transaction {
                repeat(10000) { i ->
                    val owner = 100 + i % 1000
                    insert(db, "event", "noise-$i", owner, json.encodeToString(Event(owner, "note", "Unrelated synthetic note")))
                    insert(db, "profile", "noise-$i", owner, json.encodeToString(Profile(owner, "test", "https://example.test/$i")))
                }
                insert(db, "event", "blank-placeholder", 42, json.encodeToString(Event(42, "note", "")))
                insert(db, "event", "a-old", 42, json.encodeToString(Event(42, "note", "Older", date = "2025-01-01")))
                insert(db, "event", "b-new", 42, json.encodeToString(Event(42, "job", "Newer", date = "2026-01-01")))
                insert(db, "profile", "confirmed", 42, json.encodeToString(Profile(42, "test", "https://example.test/confirmed", status = "confirmed")))
                insert(db, "profile", "suggested", 42, json.encodeToString(Profile(42, "test", "https://example.test/suggested")))
            }
            var decoded = 0
            val records = Records(
                events = SqlRecordMap(db, "view", "event", 1, { decoded++; json.decodeFromString<Event>(it) }),
                profiles = SqlRecordMap(db, "view", "profile", 1, { decoded++; json.decodeFromString<Profile>(it) }),
            )
            assertEquals(listOf("Newer", "Older"), records.eventsFor(42).values.map { it.value })
            assertEquals(setOf("confirmed", "suggested"), records.profilesFor(42).keys)
            assertTrue(records.eventsFor(-1).isEmpty())
            assertEquals(5, decoded)
            assertTrue(reads.isNotEmpty())
            assertTrue("Every detail query must be owner-scoped", reads.all { "owner=?" in it })
            val selectedQuery = reads.first { it.startsWith("SELECT id,data") }
            val plan = db.sql.query("EXPLAIN QUERY PLAN $selectedQuery", listOf("view", "event", 1, 1, 42, ""))
            assertTrue(plan.flatten().any { it?.contains("screen_owner") == true })
        }
    }

    @Test fun ownerReadsPreserveHistoricalSnapshotsAndProjectionExclusions() {
        IndexedGraphDatabase(JdbcGraphSql(temp.newFile("versions.sqlite")), File(temp.root, "blobs")).use { db ->
            val before = Event(42, "note", "Before move")
            val retained = Event(43, "note", "Unchanged")
            db.transaction {
                insert(db, "event", "moved", 42, json.encodeToString(before))
                insert(db, "event", "retained", 43, json.encodeToString(retained))
            }
            val old = db.viewMap<Event>("view", "event", 1) as SqlRecordMap<Event>
            val generated = mapOf("new" to Event(42, "note", "New projection"))
            val delta = ProjectedRows(old, setOf(42), generated)
            assertEquals(generated, delta.rowsForOwner(42) { it.person_id })
            assertEquals(mapOf("retained" to retained), delta.rowsForOwner(43) { it.person_id })
            assertTrue(old.without(setOf(42)).rowsForOwner(42) { it.person_id }.isEmpty())
            db.transaction {
                db.sql.execute("UPDATE screen SET died=2 WHERE id='moved'")
                insert(db, "event", "moved", 43, json.encodeToString(before.copy(person_id = 43)), born = 2)
            }
            assertEquals(mapOf("moved" to before), old.rowsForOwner(42) { it.person_id })
            val current = Records(events = db.viewMap("view", "event", 2))
            assertTrue(current.eventsFor(42).isEmpty())
            assertEquals(setOf("retained", "moved"), current.eventsFor(43).keys)
            val inMemory = Records(events = mapOf("moved" to before, "retained" to retained))
            assertEquals(inMemory.eventsFor(42), Records(events = old).eventsFor(42))
        }
    }

    private fun insert(db: IndexedGraphDatabase, kind: String, id: String, owner: Int, data: String, born: Int = 1) {
        db.sql.execute("INSERT INTO screen(scope,kind,id,owner,data,born) VALUES ('view',?,?,?,?,?)", listOf(kind, id, owner, data, born))
    }
}
