package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.time.LocalDate
import java.util.UUID

class ContactsTest {
    @get:Rule val temp = TemporaryFolder()
    private val card = ContactCard("Alice Anders", given = "Alice", family = "Anders", notes = "A note\nSecond line", region = "DE", fields = listOf(ContactField("phone", "+49 30 123456 ext 5", "Personal", true), ContactField("email", "alice@example.com", "Work"), ContactField("address", "12 Main Street\nBerlin", "Home")))

    private suspend fun legacyStore(dir: java.io.File = temp.newFolder()): Store = Store(dir).also {
        it.installOffline(TransferManifest(type = "snapshot", source = UUID.randomUUID().toString(), revision = 1))
    }

    @Test fun `editor confirms only newly entered website values not imported or relabelled links`() {
        val imported = ContactCard("Alice", fields = listOf(ContactField("website", "https://linkedin.com/in/alice")))
        val changed = imported.copy(notes = "Manual note", fields = imported.fields.map { it.copy(label = "Work") } +
            ContactField("website", "https://instagram.com/alice") + ContactField("email", "alice@example.test"))
        val saved = changed.withManualWebsites(imported)
        assertEquals(listOf(false, true, false), saved.fields.map { it.user_added })
        assertFalse(imported.copy(favorite = true).withManualWebsites(imported).fields.single().user_added)
        val edited = imported.copy(fields = listOf(imported.fields.single().copy(value = "https://linkedin.com/in/new")))
        assertTrue(edited.withManualWebsites(imported).fields.single().user_added)
        assertTrue(imported.withManualWebsites().fields.single().user_added)
        assertFalse(VCards.parse("BEGIN:VCARD\nFN:Alice\nURL:https://instagram.com/alice\nEND:VCARD\n").single().fields.single().user_added)
    }
    @Test fun `manual link provenance survives offline history restart and wire serialization`() = runBlocking {
        val dir = temp.newFolder(); val store = Store(dir)
        val card = ContactCard("Alice", fields = listOf(ContactField("website", "https://instagram.com/alice"))).withManualWebsites()
        val id = store.saveContact(card)
        val restarted = Store(dir); restarted.initialize()
        assertTrue(restarted.state.value.records.people.getValue(id).contactCard().fields.single().user_added)
        assertTrue(restarted.unsent().isEmpty())
        val bundle = restarted.snapshot().graph!!.bundle
        val decoded = Transfer.unpack(Transfer.pack(TransferManifest(type = "edits", source = UUID.randomUUID().toString(), graph = bundle))).graph!!
        assertTrue(GraphStore(GraphState(decoded)).project().people.values.single().contactCard().fields.single().user_added)
        // Default false is omitted even by fullJson, preserving existing field dots and fixtures.
        val imported = ContactHistory.cardObject(card.copy(fields = listOf(ContactField("website", "https://instagram.com/alice"))))
        assertFalse("user_added" in imported.getValue("fields").jsonArray.single().jsonObject)
    }
    @Test fun `international dialing keeps country and extensions`() {
        assertEquals("+442079460018;ext=42", dialable("020 7946 0018 ext 42", "GB"))
        assertEquals("+4930123456;ext=5", dialable(card.fields[0].value, card.region))
        assertNull(dialable("not a number", "US"))
        assertNotEquals(dialable("+442079460018", "US"), dialable("+492079460018", "US"))
    }
    @Test fun `vcard structured names labels unicode notes and unknown properties roundtrip`() {
        val original = card.copy(originals = listOf("BEGIN:VCARD\r\nFN:Old name\r\nX-CUSTOM:retain this\r\nEND:VCARD\r\n"))
        val exported = VCards.export(listOf(original))
        assertTrue(exported.contains("X-CUSTOM:retain this"))
        val result = VCards.parse(exported).single()
        assertEquals(card.name, result.name); assertEquals(card.fields, result.fields.map { it.copy(structured = "") })
        assertEquals(card.given, result.given); assertEquals(card.family, result.family); assertEquals(card.notes, result.notes)
        val emoji = card.copy(name = "🌱".repeat(100))
        val text = VCards.export(listOf(emoji))
        assertTrue(text.split("\r\n").all { it.toByteArray().size <= 75 })
        assertEquals(emoji.name, VCards.parse(text).single().name)
    }
    @Test fun `vcard custom labels typed numbers and folded values import`() {
        val text = "BEGIN:VCARD\r\nVERSION:3.0\r\nFN:Alice\r\nitem1.TEL;TYPE=CELL,PREF:+44 20 7946\r\n 0018\r\nitem1.X-ABLabel:Personal\r\nADR;TYPE=HOME:;;12 Main St;Berlin;;10115;Germany\r\nEND:VCARD\r\n"
        val c = VCards.parse(text).single()
        assertEquals("+44 20 79460018", c.fields[0].value)
        assertEquals("Personal", c.fields[0].label); assertTrue(c.fields[0].preferred)
        assertTrue(c.fields[1].value.contains("Germany"))
        assertTrue(c.originals.single().contains("ADR;TYPE=HOME"))
    }
    @Test fun `new contact and subsequent offline edits survive restart and canonical id adoption`() = runBlocking {
        val dir = temp.newFolder(); val store = legacyStore(dir)
        val id = store.saveContact(card)
        assertTrue(id < 0); assertEquals(card.name, store.state.value.records.people[id]?.name)
        store.saveContact(card.copy(name = "Alice W"), id)
        val again = Store(dir); again.initialize()
        assertEquals("Alice W", again.state.value.records.people[id]?.name)
        val queue = again.unsent(); assertEquals(2, queue.size)
        val uid = queue.first().payload.text("contact_uid")
        assertEquals(uid, queue.last().payload.text("contact_uid")); UUID.fromString(uid)
        val updated = card.copy(name = "Alice W", user_edited = true, edit_id = queue.last().client_id)
        again.receive(Changes(5, false, listOf(RecordChange("person", "37", json.encodeToJsonElement(Person(updated.name, contact_uid = uid, card = updated)))), queue.mapIndexed { i, op -> OpState(i.toLong(), op.client_id, op.kind, op.payload, "done") }))
        assertTrue(again.state.value.pending.isEmpty())
        assertEquals(setOf(37), again.state.value.records.people.keys)
    }
    @Test fun `terminal receipt before publication does not make a new contact disappear`() = runBlocking {
        val store = legacyStore(); val id = store.saveContact(card); val op = store.unsent().single()
        store.receive(Changes(1, false, emptyList(), listOf(OpState(1, op.client_id, op.kind, op.payload, "done"))))
        assertEquals(card.name, store.state.value.records.people[id]?.name)
        assertTrue(store.unsent().isEmpty()); assertTrue(store.state.value.pending.single().completed) // legacy receipt waits for publication
        val canonical = Person(card.name, contact_uid = op.payload.text("contact_uid"), card = card.copy(user_edited = true, edit_id = op.client_id))
        store.receive(Changes(2, false, listOf(RecordChange("person", "10", json.encodeToJsonElement(canonical))), emptyList()))
        assertTrue(store.state.value.pending.isEmpty()); assertEquals(setOf(10), store.state.value.records.people.keys)
    }
    @Test fun `failed contact payload is recoverable after restart`() = runBlocking {
        val dir = temp.newFolder(); val store = legacyStore(dir); store.saveContact(card); val op = store.unsent().single()
        store.receive(Changes(1, false, emptyList(), listOf(OpState(1, op.client_id, op.kind, op.payload, "failed", "Rejected"))))
        val again = Store(dir); again.initialize()
        assertEquals(op.payload, again.state.value.failedEdits.single().payload)
        assertTrue(again.state.value.pending.isEmpty())
    }
    @Test fun `standalone phone queue can adopt first Mac without losing contacts`() = runBlocking {
        val store = Store(temp.newFolder()); val id = store.saveContact(card)
        val source = UUID.randomUUID().toString()
        val outgoing = store.bluetoothEdits(source)
        assertTrue(outgoing.ops.isEmpty()); assertNotNull(outgoing.graph)
        val empty = GraphBundle(UUID.randomUUID().toString())
        store.installOffline(TransferManifest(type = "snapshot", source = source, revision = 1, graph = empty))
        assertEquals(card.name, store.state.value.records.people[id]?.name)
        assertTrue(store.state.value.pending.isEmpty())
        assertFalse(store.snapshot().graph!!.bundle.commits.isEmpty())
        try { store.installOffline(TransferManifest(type = "snapshot", source = UUID.randomUUID().toString(), revision = 1)); fail("foreign queue") } catch (_: IllegalArgumentException) { }
    }
    @Test fun `trash hides contacts facts moments and upcoming but restore is immediate`() {
        val uid = UUID.randomUUID().toString()
        val base = Records(people = mapOf(1 to Person(card.name, contact_uid = uid, card = card)), events = mapOf("1" to Event(1, "birthday", "Birthday", "--11-01")), moments = mapOf("m" to Moment(1, "birthday", "Birthday", surfaced_on = "2026-10-27")))
        fun op(kind: String) = PendingOp(UUID.randomUUID().toString(), kind, buildJsonObject { put("contact_uid", uid) })
        val trash = optimistic(base, listOf(op("contact_trash")))
        assertTrue(trash.search("").isEmpty()); assertEquals(1, trash.search("", trash = true).size)
        assertTrue(trash.today(LocalDate.of(2026,10,27)).isEmpty()); assertTrue(trash.upcoming(LocalDate.of(2026,10,27)).isEmpty())
        assertFalse(optimistic(base, listOf(op("contact_trash"), op("contact_restore"))).people.getValue(1).trashed)
    }
    @Test fun `alphabetical and favorites do not depend on inferred closeness`() {
        val r = Records(people = mapOf(1 to Person("Zed", closeness = 1.0), 2 to Person("Alice", card = card.copy(favorite = true))))
        assertEquals(2, r.search("", "name").first().key); assertEquals(listOf(2), r.search("", "favorites").map { it.key })
        assertEquals(2, r.search("+49 (30)", "name").single().key)
    }
    @Test fun `alphabetical order puts numbers and symbols after named contacts`() {
        val names = listOf("+1 415 555 0123", "@handle", "Zoe", "alice", "5551234567", "!Unknown", "", " Bob")
        val records = Records(people = names.mapIndexed { i, name -> i to Person(name, card = card.copy(name = name, favorite = true)) }.toMap())
        val expected = listOf("alice", " Bob", "Zoe", "", "!Unknown", "+1 415 555 0123", "5551234567", "@handle")
        assertEquals(expected, records.search("", "name").map { it.value.name })
        assertEquals(expected, records.search("", "favorites").map { it.value.name })
        assertEquals(listOf('A', 'B', 'Z', '#'), records.search("", "name").map { contactLetter(it.value.name) }.distinct())
    }
    @Test fun `alphabetical buckets fold accents and ignore leading whitespace`() {
        val names = listOf("123", "Zoe", "Émile", "Åsa", " Alice", "bob", "🌱")
        val records = Records(people = names.mapIndexed { i, name -> i to Person(name) }.toMap())
        val sorted = records.search("", "name").map { it.value.name }
        assertEquals(listOf(" Alice", "Åsa", "bob", "Émile", "Zoe", "123", "🌱"), sorted)
        assertEquals(listOf('A', 'B', 'E', 'Z', '#'), sorted.map(::contactLetter).distinct())
        assertEquals('#', contactLetter("   "))
        assertEquals('#', contactLetter("@Alice"))
    }
    @Test fun `closest order still prioritizes closeness over letter buckets`() {
        val records = Records(people = mapOf(1 to Person("+441234567890", closeness = 1.0), 2 to Person("Alice", closeness = 0.5)))
        assertEquals(listOf(1, 2), records.search("", "closeness").map { it.key })
    }
    @Test fun `full encrypted backup preserves trash failed and pending edits and photos`() = runBlocking {
        val store = legacyStore(); store.saveContact(card)
        val photo = "photo bytes".toByteArray(); val hash = BackupArchive.hash(photo)
        val disk = store.snapshot().copy(records = Records(people = mapOf(1 to Person("Trash", trashed = true, photo = hash))), failedEdits = store.unsent())
        val backup = ContactBackup(state = disk)
        val encrypted = BackupArchive.encode(backup, mapOf(hash to photo), "correct horse battery")
        assertFalse(encrypted.toString(Charsets.UTF_8).contains("Alice"))
        val (decoded, photos) = BackupArchive.decode(encrypted, "correct horse battery")
        assertEquals(backup, decoded); assertArrayEquals(photo, photos[hash])
        val fresh = Store(temp.newFolder()); fresh.restoreBackup(decoded.state)
        assertTrue(fresh.state.value.records.people[1]!!.trashed)
        assertEquals(1, fresh.state.value.pending.size); assertEquals(1, fresh.state.value.failedEdits.size)
        for (bytes in listOf(encrypted, encrypted.copyOf().also { it[it.lastIndex] = (it.last().toInt() xor 1).toByte() })) {
            try { BackupArchive.decode(bytes, "wrong passphrase"); fail("authentication") } catch (_: Exception) { }
        }
    }
    @Test fun `editor uid survives canonical id changes and temporary ids are never reused`() = runBlocking {
        val store = legacyStore(); val id = store.saveContact(card); val op = store.unsent().single()
        val uid = op.payload.text("contact_uid")
        val canonical = Person(card.name, contact_uid = uid, card = card.copy(user_edited = true, edit_id = op.client_id))
        store.receive(Changes(1, false, listOf(RecordChange("person", "17", json.encodeToJsonElement(canonical))), listOf(OpState(1, op.client_id, op.kind, op.payload, "done"))))
        val second = store.saveContact(card.copy(name = "Someone else"))
        assertTrue(second < id)
        assertEquals(17, store.saveContact(card.copy(notes = "Edited while syncing"), id, uid))
        assertEquals("Someone else", store.state.value.records.people[second]?.name)
        assertEquals("Edited while syncing", store.state.value.records.people[17]?.card?.notes)
    }
    @Test fun `offline snapshot acknowledges a newly created contact in one exchange`() = runBlocking {
        val store = Store(temp.newFolder())
        val source = UUID.randomUUID().toString()
        store.installOffline(TransferManifest(type = "snapshot", source = source, revision = 1))
        store.saveContact(card); val op = store.unsent().single()
        val canonical = Person(card.name, contact_uid = op.payload.text("contact_uid"), card = card.copy(user_edited = true, edit_id = op.client_id))
        store.installOffline(TransferManifest(type = "snapshot", source = source, revision = 2, records = listOf(RecordChange("person", "12", json.encodeToJsonElement(canonical))), results = listOf(OpState(1, op.client_id, op.kind, op.payload, "done"))))
        assertTrue(store.state.value.pending.isEmpty())
        assertEquals(setOf(12), store.state.value.records.people.keys)
    }
    @Test fun `save acknowledgment clears after a later rename without reverting the name`() = runBlocking {
        val store = legacyStore(); val id = store.saveContact(card); val save = store.unsent().single()
        val uid = save.payload.text("contact_uid")
        store.enqueue("rename", buildJsonObject { put("person_id", id); put("contact_uid", uid); put("name", "Later name") })
        val all = store.unsent()
        val finalCard = card.copy(name = "Later name", user_edited = true, edit_id = save.client_id)
        store.receive(Changes(3, false, listOf(RecordChange("person", "1", json.encodeToJsonElement(Person("Later name", contact_uid = uid, card = finalCard)))), all.mapIndexed { i, op -> OpState(i.toLong(), op.client_id, op.kind, op.payload, "done") }))
        assertTrue(store.state.value.pending.isEmpty()); assertEquals("Later name", store.state.value.records.people[1]?.name)
    }
    @Test fun `optimistic merge retains both cards and country overrides`() {
        val b = ContactCard("Other", region = "GB", notes = "Other notes", fields = listOf(ContactField("phone", "020 7946 0018", "Home")))
        val base = Records(people = mapOf(1 to Person(card.name, card = card), 2 to Person(b.name, card = b)))
        val op = PendingOp(UUID.randomUUID().toString(), "merge", buildJsonObject { putJsonArray("person_ids") { add(1); add(2) } })
        val merged = optimistic(base, listOf(op)).people.values.single().card!!
        assertTrue(merged.notes.contains("Other notes")); assertEquals(4, merged.fields.size)
        val phone = merged.fields.last(); assertEquals("GB", phone.region)
        assertEquals("+442079460018", dialable(phone.value, phone.region))
    }
    @Test fun `produce contact operations for Python roundtrip verification`() = runBlocking {
        val store = Store(temp.newFolder())
        val source = "11111111-1111-4111-8111-111111111111"
        store.installOffline(TransferManifest(type = "snapshot", source = source, revision = 1))
        val id = store.saveContact(card)
        store.saveContact(card.copy(name = "Alice Anders Updated"), id)
        val uid = store.state.value.records.people.getValue(id).contact_uid
        for (kind in listOf("contact_trash", "contact_restore")) store.enqueue(kind, buildJsonObject { put("person_id", id); put("contact_uid", uid) })
        val edits = store.exportOffline()
        java.io.File("build/interop-contacts.sherloq").writeBytes(Transfer.encrypt(Transfer.pack(edits), "test-contact-passphrase"))
        Unit
    }
    @Test fun `restore cannot discard current outbox`() = runBlocking {
        val store = Store(temp.newFolder()); store.saveContact(card)
        try { store.restoreBackup(DiskState()); fail("pending queue") } catch (_: IllegalArgumentException) { }
        assertTrue(store.state.value.pending.isEmpty())
        assertEquals(1, store.snapshot().graph!!.bundle.commits.size)
    }
}
