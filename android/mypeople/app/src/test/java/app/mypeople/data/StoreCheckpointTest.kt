package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.security.MessageDigest

class StoreCheckpointTest {
    @get:Rule val temp = TemporaryFolder()
    private fun fullState(): DiskState {
        val uid = "11111111-1111-4111-8111-111111111111"
        val id = "22222222-2222-4222-8222-222222222222"
        val payload = json.parseToJsonElement("""{"text":"Adá 🌱\nline","boolean":true,"false":false,"null":null,"integer":-7,"fraction":0.25,"exponent":1e20,"huge":123456789012345678901234567890,"array":[1,"",{},[]]}""").jsonObject
        val change = ContactChange(id, listOf(uid), uid, payload, mapOf("fields" to listOf(payload)), mapOf("fields" to listOf("tag")), listOf(uid), mapOf("notes" to listOf(id)))
        val card = ContactCard("Adá 🌱", "given", "family", "middle", "prefix", "suffix", "phonetic",
            listOf(ContactField("phone", "+4930123456", "label", true, "structured", "DE"),
                ContactField("website", "https://instagram.com/ada", user_added = true)),
            "--02-29", "organization", "title", "notes\u0000\n" + "x".repeat(70000), "photo", true, "email", "DE", listOf("original"), listOf("source"), true, id, true)
        val person = Person("name", uid, listOf("old uid"), card, true, true, mapOf("notes" to listOf(ContactConflict(id, payload))),
            listOf("alias"), listOf(Identifier("email", "a@example.test")), "photo hash", "friend", .75, 28.5, "growing", 15, true,
            listOf(ChannelCount("email", 123)), "first", "last")
        val op = PendingOp(id, "contact_change", payload, true, "created", true)
        val records = Records(mapOf(-7 to person, 42 to Person("Defaults")),
            mapOf("event" to Event(-7, "job", "value", "2026", .8, "source", "evidence", "said", "created")),
            mapOf("profile" to Profile(-7, "site", "url", "title", "confirmed", "supported", "reason", .9)),
            mapOf("moment" to Moment(-7, "kind", "reason", "context", .7, "2026-10-29", "new")),
            mapOf("dupes" to Dupes(listOf(-7, 42), listOf("clue"))), mapOf(id to change))
        return DiskState(records, 100, -99, listOf(op, op.copy(client_id = uid, sent = false, completed = false)), listOf(op.copy(kind = "relationship")), "sync", "error", listOf(Notice(id, "notice")), uid, 150, 256,
            ReplicaState(true, listOf(change), listOf(id), mapOf(uid to -7), mapOf("person:42" to "hash"), id))
    }
    @OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
    @Test fun `model additions require an explicit checkpoint codec update`() {
        val shapes = listOf(
            DiskState.serializer().descriptor to 12, Records.serializer().descriptor to 6,
            Person.serializer().descriptor to 19, ContactCard.serializer().descriptor to 21,
            ContactField.serializer().descriptor to 7, Identifier.serializer().descriptor to 2,
            ChannelCount.serializer().descriptor to 2, Event.serializer().descriptor to 9,
            Profile.serializer().descriptor to 8, Moment.serializer().descriptor to 7,
            Dupes.serializer().descriptor to 2, ContactChange.serializer().descriptor to 8,
            PendingOp.serializer().descriptor to 6, ReplicaState.serializer().descriptor to 6,
            ContactConflict.serializer().descriptor to 2, Notice.serializer().descriptor to 2)
        shapes.forEach { (descriptor, count) -> assertEquals("Update StoreCheckpoint when changing ${descriptor.serialName}", count, descriptor.elementsCount) }
    }
    @Test fun `every model field payload and non-BMP or large string roundtrips exactly`() {
        val state = fullState()
        assertEquals(state, StoreCheckpoint.decode(StoreCheckpoint.encode(state)))
        assertEquals(DiskState(), StoreCheckpoint.decode(StoreCheckpoint.encode(DiskState())))
    }
    @Test fun `truncated corrupt or future checkpoints are refused`() {
        val bytes = StoreCheckpoint.encode(fullState())
        val bad = bytes.copyOf().also { it[30] = (it[30].toInt() xor 1).toByte() }
        val future = bytes.copyOf().also {
            it[11] = 5
            val hash = MessageDigest.getInstance("SHA-256").digest(it.copyOf(it.size - 32))
            hash.copyInto(it, it.size - 32)
        }
        for (value in listOf(bytes.copyOf(30), bytes.copyOf(bytes.size - 1), bad, future)) {
            try { StoreCheckpoint.decode(value); fail("Must not accept damaged/future data") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun `legacy migration includes the journal and does not touch original JSON`() {
        val dir = temp.newFolder(); val state = fullState()
        val legacy = File(dir, "store.json").apply { writeText(json.encodeToJsonElement(state).toString()) }
        val original = legacy.readBytes()
        val serialized = json.decodeFromString<DiskState>(legacy.readText())
        val journal = StoreJournal(dir)
        val first = journal.load()
        assertEquals(serialized, first)
        val updated = serialized.copy(lastSync = "Later", notices = serialized.notices + Notice("n2", "Second"))
        journal.save(first, updated)
        assertEquals(updated.copy(journalSequence = state.journalSequence + 1), StoreJournal(dir).load())
        assertArrayEquals(original, legacy.readBytes())
        assertTrue(File(dir, "store.bin").exists())
        // A later run must not pay for decoding JSON again, or choose it over new state.
        legacy.writeText("not the authority anymore")
        assertEquals("Later", StoreJournal(dir).load().lastSync)
    }
    @Test fun `corrupt binary cannot fall back to stale JSON and erase newer edits`() {
        val dir = temp.newFolder(); val old = DiskState(lastSync = "old")
        File(dir, "store.json").writeText(json.encodeToJsonElement(old).toString())
        val journal = StoreJournal(dir); journal.load()
        val binary = File(dir, "store.bin")
        val bytes = binary.readBytes().also { it[15] = (it[15].toInt() xor 1).toByte() }; binary.writeBytes(bytes)
        try { StoreJournal(dir).load(); fail("Must refuse corruption") } catch (_: IllegalArgumentException) { }
        assertArrayEquals(bytes, binary.readBytes())
    }
    @Test fun `large journal transactions checkpoint to avoid repeated cold JSON decoding`() {
        val dir = temp.newFolder(); val journal = StoreJournal(dir)
        val before = journal.load()
        val next = DiskState(records = Records(people = (1..2000).associateWith { Person("Person $it", card = ContactCard("Person $it", notes = "x".repeat(200))) }), cursor = 15)
        journal.save(before, next)
        assertTrue(File(dir, "store.bin").exists())
        assertEquals(0, File(dir, "store.journal").length())
        assertEquals(next.copy(journalSequence = 1), StoreJournal(dir).load())
    }
    @Test fun `cached projection is separate from authoritative records and invalidated by edits`() = runBlocking {
        val dir = temp.newFolder(); val journal = StoreJournal(dir)
        val base = Records(people = mapOf(1 to Person("Original")))
        fun op(name: String) = PendingOp(newContactUid(), "rename", buildJsonObject { put("person_id", 1); put("name", name) })
        val state = DiskState(records = base, pending = listOf(op("First")))
        journal.save(journal.load(), state)
        val view = optimistic(state.records, state.pending)
        journal.cacheView(state, view)
        val cached = StoreCheckpoint.snapshot(File(dir, "store.bin").readBytes())
        assertEquals("Original", cached.state.records.people.getValue(1).name)
        assertEquals("First", cached.view!!.people.getValue(1).name)
        val meta = state.copy(lastSync = "now")
        journal.save(state, meta)
        val metadataReader = StoreJournal(dir); metadataReader.load()
        assertNotNull(metadataReader.cachedRecords)
        val edited = meta.copy(pending = meta.pending + op("Second"))
        journal.save(meta, edited)
        val changedReader = StoreJournal(dir); changedReader.load()
        assertNull(changedReader.cachedRecords)
        val store = Store(dir); store.initialize()
        assertEquals("Second", store.state.value.records.people.getValue(1).name)
        assertEquals("Original", store.snapshot().records.people.getValue(1).name)
        assertEquals(2, store.snapshot().pending.size)
    }
    @Test fun `old binary version without a projection can migrate without reading legacy JSON`() {
        val state = DiskState(lastSync = "old binary")
        val old = StoreCheckpoint.encode(state, formatVersion = 1)
        assertEquals(state, StoreCheckpoint.snapshot(old).state)
        assertNull(StoreCheckpoint.snapshot(old).view)
        val v2 = StoreCheckpoint.encode(state, Records(), formatVersion = 2)
        assertEquals(state, StoreCheckpoint.snapshot(v2).state)
        assertEquals(Records(), StoreCheckpoint.snapshot(v2).view)
    }
    @Test fun `older contact fields migrate without asserting ownership and new checkpoints retain assertions`() {
        val card = ContactCard("Alice", fields = listOf(ContactField("website", "https://instagram.com/alice")))
        val state = DiskState(records = Records(people = mapOf(1 to Person("Alice", card = card))))
        for (version in 1..3) {
            val old = StoreCheckpoint.encode(state, formatVersion = version)
            val migrated = StoreCheckpoint.decode(old)
            assertEquals(state, migrated)
            assertFalse(migrated.records.people.getValue(1).contactCard().fields.single().user_added)
            val manualCard = card.withManualWebsites()
            val updated = migrated.copy(records = Records(people = mapOf(1 to Person("Alice", card = manualCard))))
            val snapshot = StoreCheckpoint.snapshot(StoreCheckpoint.encode(updated, updated.records))
            assertEquals(updated, snapshot.state)
            assertTrue(snapshot.view!!.people.getValue(1).contactCard().fields.single().user_added)
            try { StoreCheckpoint.encode(updated, formatVersion = version); fail("Must not drop provenance") } catch (_: IllegalArgumentException) { }
        }
    }
    @Test fun `synthetic 10000-record cold checkpoint load does not use JSON`() = runBlocking {
        val dir = temp.newFolder(); val journal = StoreJournal(dir)
        val state = DiskState(records = Records(
            people = (1..3000).associateWith { Person("Person $it", card = ContactCard("Person $it", fields = listOf(ContactField("email", "$it@example.test")))) },
            events = (1..7000).associate { it.toString() to Event(it % 3000 + 1, "job", "Synthetic event $it", evidence = "test evidence") }))
        journal.save(journal.load(), state)
        val start = System.nanoTime()
        val loaded = StoreJournal(dir).load()
        println("10,000-record typed cold load: ${(System.nanoTime() - start) / 1_000_000}ms; ${File(dir, "store.bin").length()} bytes")
        assertEquals(state.copy(journalSequence = 1), loaded)
    }
    @Test fun `optional private-device sample roundtrips exactly without printing contents`() {
        val path = System.getenv("MYPEOPLE_STARTUP_SAMPLE")
        assumeTrue(!path.isNullOrBlank())
        val source = File(path!!)
        val dir = temp.newFolder()
        source.listFiles().orEmpty().filter { it.name in setOf("store.json", "store.journal") }.forEach { it.copyTo(File(dir, it.name)) }
        val start = System.nanoTime(); val first = StoreJournal(dir).load()
        val migrated = (System.nanoTime() - start) / 1_000_000
        val secondStart = System.nanoTime(); val next = StoreJournal(dir).load()
        println("Private sample: legacy=${migrated}ms; typed=${(System.nanoTime() - secondStart) / 1_000_000}ms; people=${next.records.people.size}; events=${next.records.events.size}; pending=${next.pending.size}")
        assertTrue("Typed checkpoint must match the private input exactly", first == next)
    }
}
