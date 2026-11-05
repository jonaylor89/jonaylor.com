package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class StartupIndexTest {
    @get:Rule val temp = TemporaryFolder()
    private val card = ContactCard("Ada 🌱", notes = "Full private notes must not be in a startup index", photo = "Large photo excluded", favorite = true,
        fields = listOf(ContactField("email", "ada@example.test")))
    private fun book() = Records(people = mapOf(1 to Person(card.name, "uuid", listOf("old uuid"), card, aliases = listOf("Nickname"), photo = "photo-hash", closeness = .8)))
    @Test fun `tiny index contains browsing data not full cards histories or facts`() {
        val dir = temp.newFolder(); val state = DiskState(records = book())
        File(dir, "store.bin").writeBytes(StoreCheckpoint.encode(state))
        val index = StartupIndex(dir); index.save(state.records)
        val view = index.read()!!
        val p = view.people.getValue(1)
        assertEquals(card.name, p.name); assertEquals("uuid", p.contact_uid)
        assertEquals(listOf("old uuid"), p.contact_aliases); assertEquals(listOf("Nickname"), p.aliases)
        assertEquals("photo-hash", p.photo); assertEquals(.8, p.closeness, 0.0)
        assertTrue(p.card!!.favorite); assertEquals("ada@example.test", p.card.fields.single().value)
        assertTrue(p.card.notes.isEmpty()); assertTrue(p.card.photo.isEmpty()); assertTrue(view.events.isEmpty())
        assertTrue(File(dir, "startup.idx").length() < 1024)
    }
    @Test fun `a newer journal transaction or checkpoint invalidates the old index`() {
        val dir = temp.newFolder(); val journal = StoreJournal(dir); val state = DiskState(records = book())
        journal.load(); journal.cacheView(state, state.records) // no authoritative state yet: no checkpoint
        journal.save(DiskState(), state); journal.cacheView(state, state.records)
        val index = StartupIndex(dir); index.save(state.records); assertNotNull(index.read())
        journal.save(state, state.copy(pending = listOf(PendingOp(newContactUid(), "rename", buildJsonObject { put("person_id", 1); put("name", "Changed") }))))
        assertNull(index.read())
        index.save(state.records); assertNotNull(index.read())
        File(dir, "store.bin").writeBytes(StoreCheckpoint.encode(DiskState(records = Records())))
        assertNull(index.read())
    }
    @Test fun `corrupt index is disposable but corrupt authoritative state never becomes editable`() = runBlocking {
        val dir = temp.newFolder(); val bytes = StoreCheckpoint.encode(DiskState(records = book()))
        val binary = File(dir, "store.bin").apply { writeBytes(bytes) }
        val index = StartupIndex(dir); index.save(book())
        binary.writeBytes(bytes.copyOf().also { it[20] = (it[20].toInt() xor 1).toByte() })
        val store = Store(dir)
        try { store.initialize(); fail("Must reject corrupt authority") } catch (_: IllegalArgumentException) { }
        assertFalse(store.state.value.ready)
        assertEquals(card.name, store.state.value.records.people.getValue(1).name) // last valid read-only view
        try { store.enqueue("rename", buildJsonObject { put("person_id", 1); put("name", "Wrong") }); fail("Must not edit a preview") } catch (_: IllegalArgumentException) { }
        assertFalse(File(dir, "store.journal").exists())
        val preview = File(dir, "startup.idx"); preview.writeBytes(preview.readBytes().also { it[15] = (it[15].toInt() xor 1).toByte() })
        assertNull(StartupIndex(dir).read())
    }
    @Test fun `real contact rows are published before the full authority is opened`() = runBlocking {
        val dir = temp.newFolder(); val book = book()
        File(dir, "store.bin").writeBytes(StoreCheckpoint.encode(DiskState(records = book)))
        StartupIndex(dir).save(book)
        var observed = false
        lateinit var store: Store
        store = Store(dir) { stage, _ ->
            if (stage == "address_book") {
                observed = true
                assertFalse(store.state.value.ready)
                assertEquals(card.name, store.state.value.records.people.getValue(1).name)
                assertTrue(store.state.value.records.people.getValue(1).contactCard().notes.isEmpty())
            }
        }
        store.initialize()
        assertTrue(observed); assertTrue(store.state.value.ready)
        assertEquals(card.notes, store.state.value.records.people.getValue(1).contactCard().notes)
    }
}
