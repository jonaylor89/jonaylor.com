package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File
import java.io.RandomAccessFile

class ContactHistoryTest {
    @get:Rule val temp = TemporaryFolder()
    private val a = "11111111-1111-4111-8111-111111111111"
    private val b = "22222222-2222-4222-8222-222222222222"
    private val source = "33333333-3333-4333-8333-333333333333"
    private val publisher = "44444444-4444-4444-8444-444444444444"
    private fun base(): ContactHistory {
        val h = ContactHistory()
        return h.plus(listOf(h.edit(a, ContactCard("Ada", fields = listOf(ContactField("email", "old@example.test"))))))
    }
    private fun snapshot(h: ContactHistory, revision: Long = 1) = TransferManifest(type = "snapshot", source = source, publisher = publisher,
        revision = revision, contact_version = 1, contact_history = h.changes, contact_heads = h.heads,
        records = listOf(RecordChange("person", "1", json.encodeToJsonElement(Person("Ada", contact_uid = a, card = h.contact(a)?.card)))))

    @Test fun `shared parent lists sort exactly like a per-edge topological walk`() {
        val random = java.util.Random(7)
        repeat(20) {
            val uid = newContactUid()
            val ids = mutableListOf<String>()
            val shared = mutableListOf<List<String>>()
            val changes = (0 until 120).map { i ->
                // Reuse an earlier interned array, as dense imported DAGs do, or pick a fresh subset.
                val parents = if (shared.isNotEmpty() && random.nextInt(3) == 0) shared[random.nextInt(shared.size)]
                    else ids.filter { random.nextInt(4) == 0 }.also { shared.add(it) }
                ContactChange(newContactUid(), parents, uid, buildJsonObject { if (i == 0) put("name", "Ada") else put("notes", "$i") }).also { ids.add(it.id) }
            }.shuffled(random)
            val degrees = changes.associate { it.id to it.parents.size }.toMutableMap()
            val children = mutableMapOf<String, MutableList<String>>()
            changes.forEach { c -> c.parents.forEach { children.getOrPut(it) { mutableListOf() }.add(c.id) } }
            val ready = java.util.PriorityQueue(degrees.filterValues { it == 0 }.keys); val expected = mutableListOf<String>()
            while (ready.isNotEmpty()) { val id = ready.remove(); expected.add(id); children[id].orEmpty().forEach { c -> degrees[c] = degrees.getValue(c) - 1; if (degrees[c] == 0) ready.add(c) } }
            val history = ContactHistory(changes)
            assertEquals(expected, history.changes.map { it.id })
            assertEquals((changes.map { it.id }.toSet() - children.keys).sorted(), history.heads)
        }
    }
    @Test fun `Python and Kotlin produce identical registers sets conflicts and projection`() {
        val fixture = javaClass.getResourceAsStream("/contact-history.json")!!.bufferedReader().use { json.parseToJsonElement(it.readText()).jsonObject }
        val changes = json.decodeFromJsonElement<List<ContactChange>>(fixture.getValue("changes"))
        for (seed in 0..9) {
            val h = ContactHistory(changes.shuffled(kotlin.random.Random(seed)))
            val c = h.contact(a)!!
            assertEquals(fixture.getValue("card"), JsonObject(ContactHistory.cardObject(c.card).filterKeys { it != "edit_id" }))
            assertEquals(fixture.getValue("conflicts"), json.encodeToJsonElement(c.conflicts))
        }
    }
    @Test fun `independent field edits additions and observed removals merge without conflicts`() {
        val base = base(); val card = base.contact(a)!!.card
        val left = base.edit(a, card.copy(notes = "Mac", fields = emptyList()))
        val right = base.edit(a, card.copy(organization = "Phone", fields = card.fields + ContactField("phone", "+4930123456")))
        val h = base.plus(listOf(right, left, right))
        assertEquals("Mac", h.contact(a)!!.card.notes)
        assertEquals("Phone", h.contact(a)!!.card.organization)
        assertEquals(listOf("+4930123456"), h.contact(a)!!.card.fields.map { it.value })
        assertTrue(h.contact(a)!!.conflicts.isEmpty())
    }
    @Test fun `same field conflicts persist until an explicit causal choice`() {
        val base = base()
        val left = base.edit(a, values = buildJsonObject { put("name", "Left") })
        val right = base.edit(a, values = buildJsonObject { put("name", "Right") })
        val h = base.plus(listOf(left, right))
        assertEquals(setOf("Left", "Right"), h.contact(a)!!.conflicts.getValue("name").map { it.value.jsonPrimitive.content }.toSet())
        val unrelated = h.plus(listOf(h.edit(a, h.contact(a)!!.card.copy(notes = "Not a name decision"))))
        assertTrue("name" in unrelated.contact(a)!!.conflicts)
        val final = h.plus(listOf(h.edit(a, values = buildJsonObject { put("name", "Left") })))
        assertTrue(final.contact(a)!!.conflicts.isEmpty()); assertEquals("Left", final.contact(a)!!.card.name)
    }
    @Test fun `a later created identity never silently replaces information from an earlier one`() {
        var h = base()
        h = h.plus(listOf(h.edit(a, h.contact(a)!!.card.copy(notes = "Keep this"))))
        h = h.plus(listOf(h.edit(b, ContactCard("Duplicate"))))
        h = h.plus(listOf(h.edit(a, links = listOf(b), values = buildJsonObject { put("name", "Ada") })))
        assertEquals("Keep this", h.contact(a)!!.card.notes)
    }
    @Test fun `missing parents cyclic histories UUID collisions and unobserved removals fail`() {
        val base = base(); val c = base.edit(a, values = buildJsonObject { put("name", "Changed") })
        val cases = listOf(listOf(c), listOf(c.copy(parents = listOf(c.id))), base.changes + c + c.copy(values = buildJsonObject { put("name", "Collision") }),
            base.changes + c.copy(removes = mapOf("fields" to listOf("$b:fields:0"))))
        cases.forEach { input -> try { ContactHistory(input); fail("Invalid DAG") } catch (_: IllegalArgumentException) { } }
    }
    @Test fun `contacts added here are offered as duplicates until marked different, but favorites are not`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir)
        val first = store.saveContact(ContactCard("Ada Lovelace"))
        val dupes = { store.state.value.records.dupes }
        val second = store.saveContact(ContactCard("Ada Lovelace", fields = listOf(ContactField("email", "ada@example.test"))))
        assertEquals(listOf(listOf(first, second).sorted()), dupes().values.map { it.person_ids })
        store.enqueue("distinct", buildJsonObject { putJsonArray("person_ids") { add(first); add(second) } })
        assertTrue(dupes().isEmpty())
        // Favoriting an existing contact is not a reason to ask about it again.
        val other = store.saveContact(ContactCard("Grace"))
        val before = dupes()
        store.saveContact(ContactCard("Ada Lovelace", favorite = true), first, store.state.value.records.people.getValue(first).contact_uid)
        assertEquals(before, dupes())
        assertTrue(other !in dupes().values.flatMap { it.person_ids })
    }
    @Test fun `fresh contacts merge immediately before any Mac pairing and survive restart`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir)
        val first = store.saveContact(ContactCard("Ada", notes = "First"))
        val second = store.saveContact(ContactCard("Duplicate", fields = listOf(ContactField("email", "a@example.test"))))
        store.enqueue("merge", buildJsonObject { putJsonArray("person_ids") { add(first); add(second) } })
        assertEquals(1, store.state.value.records.people.size)
        assertEquals("First", store.state.value.records.people.values.single().contactCard().notes)
        assertEquals("a@example.test", store.state.value.records.people.values.single().contactFields().single().value)
        val restarted = Store(dir); restarted.initialize()
        assertEquals(store.state.value.records, restarted.state.value.records)
        val outgoing = restarted.bluetoothEdits(source, publisher)
        assertEquals(3, outgoing.contact_history.size)
        assertEquals(3, outgoing.ops.size)
        assertEquals(1, ContactHistory(outgoing.contact_history).contacts.size)
    }
    @Test fun `receiving remote history cannot erase local offline changes or conflicts`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir); val base = base()
        store.installOffline(snapshot(base))
        store.saveContact(base.contact(a)!!.card.copy(notes = "Phone"), 1)
        val remote = base.plus(listOf(base.edit(a, values = buildJsonObject { put("notes", "Mac") })))
        store.installOffline(snapshot(remote, 2))
        val person = store.state.value.records.people.values.single()
        assertEquals(setOf("Phone", "Mac"), person.contact_conflicts.getValue("notes").map { it.value.jsonPrimitive.content }.toSet())
        val choice = person.contact_conflicts.getValue("notes").first { it.value.jsonPrimitive.content == "Phone" }
        store.resolveContact(person.contact_uid, "notes", choice.change)
        assertTrue(store.state.value.records.people.values.single().contact_conflicts.isEmpty())
        val restarted = Store(dir); restarted.initialize()
        assertEquals("Phone", restarted.state.value.records.people.values.single().contactCard().notes)
        assertEquals(2, restarted.state.value.pending.size)
    }
    @Test fun `incremental snapshots apply deletions atomically and reject a wrong base`() = runBlocking {
        val store = Store(temp.newFolder()); val h = base(); store.installOffline(snapshot(h))
        store.installOffline(TransferManifest(type = "snapshot", source = source, publisher = publisher, revision = 2, base_revision = 1,
            contact_version = 1, contact_heads = h.heads, records = listOf(RecordChange("person", "1", JsonNull))))
        // The contact is still authoritative even if its derived server row is absent.
        assertEquals("Ada", store.state.value.records.people.values.single().name)
        try { store.installOffline(TransferManifest(type = "snapshot", source = source, publisher = publisher, revision = 3, base_revision = 1)); fail("Wrong base") }
        catch (_: IllegalArgumentException) { }
        assertEquals(2L, store.state.value.offlineRevision)
    }
    @Test fun `collection history works across publishers with independent revision counters`() = runBlocking {
        val store = Store(temp.newFolder()); val h = base()
        store.installOffline(snapshot(h, 50))
        val peer = h.plus(listOf(h.edit(a, values = buildJsonObject { put("notes", "Other CLI") })))
        store.installOffline(snapshot(peer, 1).copy(publisher = b))
        assertEquals("Other CLI", store.state.value.records.people.values.single().contactCard().notes)
        // A new publisher needs the complete history, not assumptions about the old peer's frontier.
        assertEquals(peer.changes.size, store.bluetoothEdits(source, publisher).contact_history.size)
        assertTrue(store.bluetoothEdits(source, b).contact_history.isEmpty())
    }
    @Test fun `self identities are not resurrected from retained history`() = runBlocking {
        val h = base()
        val hidden = h.plus(listOf(h.edit(a, values = buildJsonObject { put("_is_me", true) })))
        val store = Store(temp.newFolder()); store.installOffline(snapshot(hidden))
        assertTrue(store.state.value.records.people.isEmpty())
        assertTrue(store.snapshot().replica.changes.isNotEmpty()) // hidden, not erased
    }
    @Test fun `a foreign collection cannot receive acknowledged private contact history`() = runBlocking {
        val store = Store(temp.newFolder()); store.installOffline(snapshot(base()))
        val foreign = store.bluetoothEdits(b, publisher)
        assertTrue(foreign.contact_history.isEmpty()); assertTrue(foreign.contact_heads.isEmpty()); assertTrue(foreign.ops.isEmpty())
    }
    @Test fun `Mac-only pending requests cannot be delivered to a different publisher`() = runBlocking {
        val store = Store(temp.newFolder()); val h = base(); store.installOffline(snapshot(h))
        store.enqueue("event_forget", buildJsonObject { put("event_id", "17") })
        try { store.bluetoothEdits(source, b); fail("Foreign integer IDs") } catch (_: IllegalArgumentException) { }
        try { store.installOffline(snapshot(h, 2).copy(publisher = b)); fail("Do not reassign pending memory requests") } catch (_: IllegalArgumentException) { }
        assertEquals(1, store.state.value.pending.size)
        assertEquals(publisher, store.exportOffline().publisher)
    }
    @Test fun `edits naming their contact can sync with any Mac in the collection`() = runBlocking {
        val store = Store(temp.newFolder()); val h = base(); store.installOffline(snapshot(h))
        store.enqueue("note", buildJsonObject { put("contact_uid", a); put("person_id", 1); put("text", "Written on the phone") })
        assertEquals(1, store.bluetoothEdits(source, b).ops.size)
        store.installOffline(snapshot(h, 2).copy(publisher = b))
        assertEquals(1, store.state.value.pending.size)
    }
    @Test fun `legacy receipt-before-publication upgrades without dropping its contact save`() = runBlocking {
        val dir = temp.newFolder()
        val clientId = newContactUid()
        val card = ContactCard("Ada", user_edited = true, edit_id = clientId)
        val op = PendingOp(clientId, "contact_save", buildJsonObject { put("contact_uid", a); put("local_id", -1); put("card", json.encodeToJsonElement(card)) })
        File(dir, "store.json").writeText(json.encodeToJsonElement(DiskState(pending = listOf(op), nextLocalId = -2, offlineSource = source, offlineRevision = 1)).toString())
        val store = Store(dir); store.initialize()
        store.receive(Changes(1, false, emptyList(), listOf(OpState(1, clientId, op.kind, op.payload, "done"))))
        assertTrue(store.state.value.pending.single().completed)
        assertEquals("Ada", store.state.value.records.people.getValue(-1).name)
        val h = ContactHistory().let { it.plus(listOf(it.edit(a, card))) }
        store.installOffline(snapshot(h, 2).copy(results = listOf(OpState(1, clientId, op.kind, op.payload, "done"))))
        assertTrue(store.state.value.replicatedContacts)
        assertTrue(store.state.value.pending.isEmpty())
        assertEquals(setOf(1), store.state.value.records.people.keys)
    }
    @Test fun `HTTP paging waits for complete causal history and preserves unsent edits`() = runBlocking {
        val store = Store(temp.newFolder()); val h = base()
        store.receive(Changes(1, true, listOf(RecordChange("person", "1", json.encodeToJsonElement(Person("Ada", contact_uid = a)))), emptyList()))
        assertFalse(store.state.value.replicatedContacts)
        store.receive(Changes(2, false, h.changes.map { RecordChange("contact_change", it.id, json.encodeToJsonElement(it)) }, emptyList()))
        assertTrue(store.state.value.replicatedContacts)
        store.saveContact(h.contact(a)!!.card.copy(notes = "Offline"), 1)
        assertEquals("contact_change", store.unsent().single().kind)
    }
    @Test fun `journal transactions do not rewrite address book for metadata and tolerate a torn final append`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir)
        val records = (1..2000).map { RecordChange("person", it.toString(), json.encodeToJsonElement(Person("Person $it", card = ContactCard("Person $it", notes = "x".repeat(512))))) }
        store.receive(Changes(1, false, records, emptyList()))
        val before = store.state.value.records
        val file = File(dir, "store.journal"); val size = file.length()
        repeat(10) { store.succeeded() }
        assertTrue("Metadata updates must be small", file.length() - size < 6000)
        assertSame(before, store.state.value.records)
        val validLength = file.length()
        file.appendBytes(byteArrayOf(0, 0, 1))
        val restarted = Store(dir); restarted.initialize()
        assertEquals(validLength, file.length())
        assertEquals(2000, restarted.state.value.records.people.size)
        assertEquals(1L, restarted.cursor())
    }
    @Test fun `merging two contacts in a large address book writes one small history transaction`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir)
        val changes = (1..3000).map { i ->
            val uid = "00000000-0000-4000-8000-${i.toString().padStart(12, '0')}"
            ContactChange(id = uid, contact_uid = uid, values = buildJsonObject { put("name", "Person $i"); put("notes", "x".repeat(512)) })
        }
        val h = ContactHistory(changes)
        store.installOffline(TransferManifest(type = "snapshot", source = source, publisher = publisher, revision = 1,
            contact_version = 1, contact_history = h.changes, contact_heads = h.heads))
        val selected = store.state.value.records.people.keys.take(2)
        val file = File(dir, "store.journal"); val size = file.length()
        val start = System.nanoTime()
        store.enqueue("merge", buildJsonObject { putJsonArray("person_ids") { selected.forEach { add(it) } } })
        val elapsed = (System.nanoTime() - start) / 1_000_000
        println("3000-contact local merge: ${elapsed}ms; ${file.length() - size} journal bytes")
        assertEquals(2999, store.state.value.records.people.size)
        assertTrue("Do not rewrite all contact cards/history on a merge", file.length() - size < 512 * 1024)
    }
    @Test fun `journal complete-frame corruption is never silently overwritten`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir); store.saveContact(ContactCard("Ada"))
        val file = File(dir, "store.journal")
        RandomAccessFile(file, "rw").use { it.seek(12); val value = it.readByte(); it.seek(12); it.writeByte(value.toInt() xor 1) }
        val bytes = file.readBytes()
        try { Store(dir).initialize(); fail("Damaged frame") } catch (_: IllegalArgumentException) { }
        assertArrayEquals(bytes, file.readBytes())
    }
    @Test fun `journal checkpoints and replayed old frames are idempotent`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir); store.saveContact(ContactCard("Ada"))
        val old = File(dir, "store.journal").readBytes()
        repeat(255) { store.succeeded() }
        assertTrue(File(dir, "store.bin").exists())
        File(dir, "store.journal").writeBytes(old) // crash after checkpoint rename, before log truncation
        val restarted = Store(dir); restarted.initialize()
        assertEquals(1, restarted.state.value.pending.size)
        assertEquals("Ada", restarted.state.value.records.people.values.single().name)
        restarted.saveContact(ContactCard("Ada", notes = "After checkpoint"), restarted.state.value.records.people.keys.single())
        val final = Store(dir); final.initialize()
        assertEquals("After checkpoint", final.state.value.records.people.values.single().contactCard().notes)
    }
}
