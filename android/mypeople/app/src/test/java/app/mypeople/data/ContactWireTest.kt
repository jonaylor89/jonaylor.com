package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class ContactWireTest {
    @get:Rule val temp = TemporaryFolder()
    private val source = "11111111-1111-4111-8111-111111111111"
    private fun uid(n: Int) = "00000000-0000-4000-8000-${n.toString().padStart(12, '0')}"
    private fun dense(size: Int, updates: Int): List<ContactChange> {
        val roots = (1..size).map(::uid)
        return roots.mapIndexed { i, id -> ContactChange(id, contact_uid = id, values = buildJsonObject { put("name", "Person $i") }) } +
            (0 until updates).map { i -> ContactChange(uid(size + i + 1), roots, roots[i % size], buildJsonObject { put("notes", "Update $i") }) }
    }
    @Test fun `Python and JVM agree on frontier hashes and exact expansion`() {
        val fixture = javaClass.getResourceAsStream("/contact-frontiers.json")!!.bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }
        val expected = json.decodeFromJsonElement<TransferManifest>(fixture.getValue("expanded"))
        assertEquals(expected, ContactWire.decode(fixture.getValue("wire").jsonObject))
        assertEquals(fixture.getValue("wire").jsonObject.getValue("contact_frontiers"), ContactWire.encode(expected).getValue("contact_frontiers"))
    }
    @Test fun `history larger than the old manifest cap roundtrips through a small shared table`() {
        val changes = dense(1024, 900)
        assertTrue(1024L * 900 * 39 > 32 * 1024 * 1024)
        val m = TransferManifest(type = "snapshot", source = source, revision = 1, contact_version = 1, contact_history = changes)
        val wire = ContactWire.encode(m)
        assertEquals(2, wire.getValue("format").jsonPrimitive.int)
        assertEquals(1, wire.getValue("contact_frontiers").jsonObject.size)
        assertTrue(wire.toString().toByteArray().size < 1024 * 1024)
        val decoded = Transfer.unpack(Transfer.pack(m))
        assertEquals(m, decoded)
        assertSame(decoded.contact_history[1024].parents, decoded.contact_history.last().parents)
        assertEquals("Update 0", ContactHistory(decoded.contact_history).contact(uid(1))!!.card.notes)
    }
    @Test fun `opaque retry payloads retain exact numeric literals and omitted fields`() {
        val changes = dense(3, 3)
        val parentArray = JsonArray(changes.last().parents.map(::JsonPrimitive))
        val raw = json.parseToJsonElement("""{"id":"${uid(50)}","contact_uid":"${uid(1)}","values":{"large":123456789012345678901234567890,"exponent":1e3,"null":null}}""").jsonObject
        val withParents = JsonObject(raw + ("parents" to parentArray))
        val m = TransferManifest(type = "edits", source = source, contact_history = changes,
            ops = listOf(PendingOp(uid(50), "contact_change", withParents), PendingOp(uid(51), "contact_change", raw)))
        val decoded = Transfer.unpack(Transfer.pack(m))
        assertEquals(m, decoded)
        assertEquals(raw, decoded.ops[1].payload)
        assertFalse("parents" in decoded.ops[1].payload)
        assertEquals(withParents, decoded.ops[0].payload)
    }
    @Test fun `corrupt missing ambiguous and version-confused frontiers are rejected`() {
        val m = TransferManifest(type = "edits", source = source, contact_history = dense(3, 3))
        val original = ContactWire.encode(m)
        val table = original.getValue("contact_frontiers").jsonObject
        val ref = table.keys.single()
        val rows = original.getValue("contact_history").jsonArray
        val last = rows.last().jsonObject
        val cases = listOf(
            JsonObject(original + ("contact_frontiers" to JsonObject(mapOf(ref to JsonArray(listOf(JsonPrimitive(uid(80)))))))),
            JsonObject(original + ("format" to JsonPrimitive(1))),
            JsonObject(original + ("contact_history" to JsonArray(rows.dropLast(1) + JsonObject(last + ("parents" to JsonArray(emptyList())))))),
            JsonObject(original + ("contact_history" to JsonArray(rows.dropLast(1) + JsonObject(last + ("parent_frontier" to JsonPrimitive("a".repeat(64))))))),
        )
        cases.forEach { input -> try { ContactWire.decode(input); fail("Invalid frontier") } catch (_: IllegalArgumentException) { } }
    }
    @Test fun `typed checkpoints intern dense parent arrays and imports do not make giant JSON journals`() = runBlocking {
        val dir = temp.newFolder()
        val changes = dense(1024, 900)
        val before = DiskState()
        val next = DiskState(replica = ReplicaState(enabled = true, changes = changes))
        val v2 = StoreCheckpoint.encode(next, formatVersion = 2)
        val v3 = StoreCheckpoint.encode(next)
        assertTrue(v2.size > 32 * 1024 * 1024)
        assertTrue(v3.size < 1024 * 1024)
        val restored = StoreCheckpoint.decode(v3)
        assertEquals(next, restored)
        assertSame(restored.replica.changes[1024].parents, restored.replica.changes.last().parents)
        val journal = StoreJournal(dir); journal.load(); journal.save(before, next)
        assertEquals(0L, File(dir, "store.journal").length())
        assertTrue(File(dir, "store.bin").length() < 1024 * 1024)
        assertEquals(next.copy(journalSequence = 1), StoreJournal(dir).load())
    }
    @Test fun `targeted reachability agrees with exhaustive ancestry on random DAGs`() {
        val random = kotlin.random.Random(42)
        val changes = mutableListOf(ContactChange(uid(1), contact_uid = uid(1), values = buildJsonObject { put("name", "Person") }))
        for (i in 2..100) changes.add(ContactChange(uid(i), changes.shuffled(random).take(minOf(changes.size, random.nextInt(1, 5))).map { it.id }, uid(1), buildJsonObject { put("notes", "$i") }))
        val h = ContactHistory(changes.shuffled(random))
        h.changes.forEach { c -> val past = h.past(c.parents); h.byId.keys.forEach { assertEquals(it in past, h.observed(it, c.parents)) } }
    }
}
