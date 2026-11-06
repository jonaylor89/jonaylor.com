package app.mypeople.data

import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.zip.ZipInputStream
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class GraphStoreTest {
    @get:Rule val temp = TemporaryFolder()
    private fun uuid() = UUID.randomUUID().toString()
    private fun personPayload(uid: String, block: JsonObjectBuilder.() -> Unit = {}) = buildJsonObject { put("contact_uid", uid); block() }
    private fun snapshot(bundle: GraphBundle, source: String = bundle.collection, revision: Long = 1) = TransferManifest(type = "snapshot", source = source, revision = revision, graph = bundle)
    private fun base(): GraphState = GraphStore(GraphStore.empty()).saveCard(uuid(), ContactCard("Cameron", given = "Cameron", notes = "Card note", fields = listOf(ContactField("phone", "+49123456789", "Mobile"), ContactField("email", "cameron@example.test")), originals = listOf("original vCard")))

    @Test fun `Python handoff acknowledges six legacy edits and activates the graph without resetting`() = runBlocking {
        val fixture = json.parseToJsonElement(javaClass.getResource("/python-legacy-graph-handoff.json")!!.readText()).jsonObject
        val legacy = json.decodeFromJsonElement<DiskState>(fixture.getValue("legacy"))
        val reply = json.decodeFromJsonElement<TransferManifest>(fixture.getValue("reply"))
        val directory = temp.newFolder()
        val store = Store(directory)
        store.restoreBackup(legacy)
        assertNull(store.snapshot().graph)
        assertEquals(6, store.state.value.pending.size)
        val before = store.state.value.records.people.entries.first { it.value.contactCard().notes == "Synthetic phone note 5" }
        store.installOffline(reply)
        assertNotNull(store.snapshot().graph)
        assertTrue(store.state.value.pending.isEmpty())
        val person = store.state.value.records.people.getValue(before.key)
        assertEquals(before.value.contact_uid, person.contact_uid)
        assertEquals("Synthetic phone note 5", person.contactCard().notes)
        assertTrue(person.contactCard().favorite)
        assertTrue(person.contactCard().legacy_unverified)
        assertEquals(1, store.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
        val field = person.contactCard().fields.single().object_id
        store.saveContact(person.contactCard().copy(favorite = false), before.key)
        assertEquals(field, store.state.value.records.people.getValue(before.key).contactCard().fields.single().object_id)
        val restarted = Store(directory)
        restarted.initialize()
        assertNotNull(restarted.snapshot().graph)
        assertTrue(restarted.state.value.pending.isEmpty())
        assertEquals(store.state.value.records, restarted.state.value.records)
    }

    @Test fun `small card saves reuse unrelated people and match a complete projection`() = runBlocking {
        val directory = temp.newFolder()
        val store = Store(directory)
        val a = store.saveContact(ContactCard("Cameron", notes = "Old note", fields = listOf(ContactField("email", "cam@example.test"))))
        val b = store.saveContact(ContactCard("Other", notes = "Keep this note"))
        val unrelated = store.state.value.records.people.getValue(b)
        suspend fun edit(card: ContactCard) {
            store.saveContact(card, a)
            assertSame(unrelated, store.state.value.records.people.getValue(b))
            assertEquals(GraphStore(store.snapshot().graph!!).project(), store.state.value.records)
        }
        fun card() = store.state.value.records.people.getValue(a).contactCard()
        edit(card().copy(favorite = true))
        edit(card().copy(notes = "New note", organization = "Synthetic company"))
        edit(card().copy(name = "Renamed Cameron"))
        edit(card().copy(fields = emptyList()))
        edit(card().copy(fields = listOf(ContactField("phone", "+49123456789"))))
        edit(card().copy(fields = card().fields.map { it.copy(label = "Mobile") }))
        // Shared graph objects invalidate every owner, not just the edited card.
        val gs = GraphStore(store.snapshot().graph!!)
        val point = card().fields.single().object_id
        val owner = store.state.value.records.people.getValue(b).contact_uid
        val shared = gs.commit(listOf(VersionedGraph.createEdge("has_contact_point", owner, point)))
        store.installOffline(snapshot(shared.bundle))
        store.saveContact(card().copy(fields = card().fields.map { it.copy(label = "Shared") }), a)
        assertEquals(GraphStore(store.snapshot().graph!!).project(), store.state.value.records)
        assertEquals("Shared", store.state.value.records.people.getValue(b).contactFields().single().label)
        val restarted = Store(directory)
        restarted.initialize()
        assertEquals(store.snapshot().graph!!.localIds, restarted.snapshot().graph!!.localIds)
        assertEquals(store.state.value.records, restarted.state.value.records)
    }

    @Test fun `non identity fallback projections retain existing duplicate candidates`() = runBlocking {
        val store = Store(temp.newFolder())
        val fields = listOf(ContactField("email", "shared@example.test"))
        val a = store.saveContact(ContactCard("A", fields = fields))
        store.saveContact(ContactCard("B", fields = fields))
        val dupes = store.state.value.records.dupes
        assertFalse(dupes.isEmpty())
        val uid = store.state.value.records.people.getValue(a).contact_uid
        store.enqueue("note", personPayload(uid) { put("text", "Keep candidates") })
        assertEquals(dupes, store.state.value.records.dupes)
        val event = store.state.value.records.events.keys.single()
        store.enqueue("event_forget", personPayload(uid) { put("event_id", event) })
        assertEquals(dupes, store.state.value.records.dupes)
        val gs = GraphStore(store.snapshot().graph!!)
        val profile = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", "public_profile"); put("value", "https://example.test/a") })
        store.installOffline(snapshot(gs.commit(listOf(profile, VersionedGraph.createEdge("subject_of", uid, profile.target))).bundle))
        // Decision/targets changes deliberately use the full fallback projection.
        store.enqueue("profile_status", personPayload(uid) { put("profile_id", profile.target); put("status", "confirmed") })
        assertEquals(dupes, store.state.value.records.dupes)
        assertEquals(GraphStore(store.snapshot().graph!!).project(), store.state.value.records)
    }

    @Test fun `component projection preserves shared memory ownership and removes retracted attributes`() = runBlocking {
        val store = Store(temp.newFolder())
        val a = store.saveContact(ContactCard("A"))
        val b = store.saveContact(ContactCard("B"))
        val gs = GraphStore(store.snapshot().graph!!)
        val note = VersionedGraph.createObject("Note", buildJsonObject { put("body", "Shared note"); put("origin", "contact_card_notes") })
        val edges = listOf(a, b).map { VersionedGraph.createEdge("has_note", store.state.value.records.people.getValue(it).contact_uid, note.target) }
        store.installOffline(snapshot(gs.commit(listOf(note) + edges).bundle))
        for (id in listOf(a, b, a)) {
            store.saveContact(store.state.value.records.people.getValue(id).contactCard().copy(favorite = true), id)
            assertEquals(GraphStore(store.snapshot().graph!!).project(), store.state.value.records)
        }
        store.saveContact(store.state.value.records.people.getValue(a).contactCard().copy(notes = "Changed shared note"), a)
        assertEquals(GraphStore(store.snapshot().graph!!).project(), store.state.value.records)
        store.saveContact(store.state.value.records.people.getValue(b).contactCard().copy(notes = ""), b)
        assertEquals(GraphStore(store.snapshot().graph!!).project(), store.state.value.records)
    }

    @Test fun `verified base never bypasses validation of newly appended blobs and references`() {
        val gs = GraphStore(base())
        assertTrue(gs.state.bundle.blobsVerified)
        val missing = VersionedGraph.createObject("Asset", buildJsonObject { putJsonObject("content") { put("blob_hash", "0".repeat(64)) } })
        try { gs.commit(listOf(missing)); fail("Missing blob accepted") } catch (_: IllegalArgumentException) { }
        try { gs.commit(listOf(missing), mapOf("0".repeat(64) to "YmFk")); fail("Damaged blob accepted") } catch (_: IllegalArgumentException) { }
        val bytes = "synthetic photo".toByteArray()
        val hash = GraphStore.digest(bytes)
        val asset = VersionedGraph.createObject("Asset", buildJsonObject { putJsonObject("content") { put("blob_hash", hash) } })
        val next = gs.commit(listOf(asset), mapOf(hash to java.util.Base64.getEncoder().encodeToString(bytes)))
        assertTrue(next.bundle.blobsVerified)
        assertTrue(GraphStore(next).graph.objects.containsKey(asset.target))
        assertTrue(gs.state.bundle.blobs.isEmpty())
    }

    @Test fun `known peer delta retains all data without resending acknowledged blobs`() {
        val initial = GraphStore(base())
        val bytes = "synthetic original evidence".toByteArray()
        val hash = GraphStore.digest(bytes)
        val source = VersionedGraph.createObject("SourceRecord", buildJsonObject { put("original", buildJsonObject { put("blob_hash", hash) }) })
        val full = initial.commit(listOf(source), mapOf(hash to java.util.Base64.getEncoder().encodeToString(bytes)))
        val acknowledged = full.copy(remoteHeads = full.bundle.heads)
        assertTrue(GraphStore(acknowledged).outbound().commits.isEmpty())
        assertTrue(GraphStore(acknowledged).outbound().blobs.isEmpty())
        val uid = GraphStore(full).project().people.values.single().contact_uid
        val changed = GraphStore(acknowledged).mutate("note", personPayload(uid) { put("text", "Offline delta note") })
        val delta = GraphStore(changed).outbound()
        assertEquals(1, delta.commits.size)
        assertTrue(delta.blobs.isEmpty())
        val received = GraphStore(full).receive(delta)
        assertEquals(full.bundle.blobs, received.bundle.blobs)
        assertTrue(GraphStore(received).project().events.values.any { it.value == "Offline delta note" })
    }

    @Test fun `derived relationship hints survive graph projection but never replace domain values`() {
        val state = base()
        val gs = GraphStore(state)
        val uid = gs.project().people.values.single().contact_uid
        val hints = Records(people = mapOf(500 to Person("Not the authoritative name", contact_uid = uid, category = "friend", closeness = .75, cadence_days = 30.0, trend = "growing", days_365 = 12)))
        val projected = gs.project(derived = hints).people.values.single()
        assertEquals("Cameron", projected.name)
        assertEquals("friend", projected.category)
        assertEquals(.75, projected.closeness, .00001)
        assertEquals("growing", projected.trend)
        assertEquals(12, projected.days_365)
        val changed = gs.mutate("relationship", personPayload(uid) { put("category", "family"); put("closeness", .2); put("muted", true) })
        val explicit = GraphStore(changed).project(derived = hints).people.values.single()
        assertEquals("family", explicit.category)
        assertEquals(.2, explicit.closeness, .00001)
        assertTrue(explicit.muted)
    }

    @Test fun `graph ZIP is separate from manifest and binary backup preserves every field`() {
        val state = GraphStore(base()).indexed()
        val archive = Transfer.pack(snapshot(state.bundle))
        val entries = mutableMapOf<String, String>()
        ZipInputStream(ByteArrayInputStream(archive)).use { zip -> while (true) { val e = zip.nextEntry ?: break; entries[e.name] = zip.readBytes().toString(Charsets.UTF_8) } }
        assertEquals(setOf("manifest.json", "graph.json"), entries.keys)
        assertFalse(json.parseToJsonElement(entries.getValue("manifest.json")).jsonObject.containsKey("graph"))
        assertEquals(state.bundle, Transfer.unpack(archive).graph)
        val disk = DiskState(graph = state)
        assertEquals(disk, StoreCheckpoint.decode(StoreCheckpoint.encode(disk)))
        val encrypted = BackupArchive.encode(ContactBackup(state = disk), emptyMap(), "synthetic-graph-passphrase")
        assertEquals(disk, BackupArchive.decode(encrypted, "synthetic-graph-passphrase").first.state)
    }

    @Test fun `every native memory edit commits locally and survives journal checkpoint restore`() = runBlocking {
        val directory = temp.newFolder(); val store = Store(directory)
        val id = store.saveContact(ContactCard("Cameron", notes = "Card", fields = listOf(ContactField("email", "cameron@example.test"))))
        val uid = store.state.value.records.people.getValue(id).contact_uid
        store.enqueue("note", personPayload(uid) { put("text", "Personal note") })
        store.enqueue("event_add", personPayload(uid) { put("type", "birthday"); put("value", "Birthday"); put("date", "--02-29") })
        store.enqueue("alias_add", personPayload(uid) { put("alias", "Cam") })
        store.enqueue("relationship", personPayload(uid) { put("category", "friend"); put("closeness", .8); put("cadence_days", 14); put("muted", true) })
        val fact = store.state.value.records.events.entries.single { it.value.type == "birthday" }
        store.enqueue("event_forget", personPayload(uid) { put("event_id", fact.key) })
        store.enqueue("contact_trash", personPayload(uid)); store.enqueue("contact_restore", personPayload(uid))
        assertTrue(store.unsent().isEmpty()); assertTrue(store.state.value.pending.isEmpty())
        val view = store.state.value.records
        assertEquals("friend", view.people.getValue(id).category)
        assertEquals(listOf("Cam"), view.people.getValue(id).aliases)
        assertEquals(setOf("Card", "Personal note"), view.events.values.map { it.value }.toSet())
        assertTrue(view.people.getValue(id).muted)
        repeat(256) { store.succeeded() }
        val restarted = Store(directory); restarted.initialize()
        assertEquals(view, restarted.state.value.records)
        val restored = Store(temp.newFolder()); restored.restoreBackup(restarted.snapshot())
        assertEquals(view, restored.state.value.records)
        assertNotEquals(restarted.snapshot().graph!!.peer, restored.snapshot().graph!!.peer)
        assertEquals(restarted.snapshot().graph!!.bundle, restored.snapshot().graph!!.bundle)
    }

    @Test fun `delta receive preserves offline edits and conflict choice is explicit`() = runBlocking {
        val initial = GraphStore(base()).indexed(); val uid = GraphStore(initial).project().people.values.single().contact_uid
        val source = uuid(); val left = Store(temp.newFolder()); val right = Store(temp.newFolder())
        left.installOffline(snapshot(initial.bundle, source)); right.installOffline(snapshot(initial.bundle, source))
        val a = left.state.value.records.people.entries.single(); val b = right.state.value.records.people.entries.single()
        left.saveContact(a.value.contactCard().copy(name = "Cameron Left"), a.key)
        right.saveContact(b.value.contactCard().copy(name = "Cameron Right"), b.key)
        val rb = right.snapshot().graph!!.bundle
        val delta = rb.copy(commits = rb.commits.filterNot { it.id in initial.bundle.commits.map { c -> c.id } })
        left.installOffline(snapshot(delta, source, 2))
        val person = left.state.value.records.people.values.single()
        val conflict = person.contact_conflicts.entries.single { it.key.endsWith("/display") }
        assertEquals(setOf("Cameron Left", "Cameron Right"), conflict.value.map { it.value.jsonPrimitive.content }.toSet())
        left.saveContact(person.contactCard().copy(favorite = true), left.state.value.records.people.keys.single())
        assertTrue(left.state.value.records.people.values.single().contact_conflicts.containsKey(conflict.key))
        val choice = conflict.value.first { it.value == JsonPrimitive("Cameron Left") }
        left.resolveContact(uid, conflict.key, choice.change)
        assertTrue(left.state.value.records.people.values.single().contact_conflicts.isEmpty())
        right.installOffline(snapshot(left.snapshot().graph!!.bundle, source, 3))
        assertEquals("Cameron Left", right.state.value.records.people.values.single().name)
        assertTrue(right.state.value.records.people.values.single().contactCard().favorite)
    }

    @Test fun `split selected message phone note and profile associations retains all original objects`() = runBlocking {
        var s = base(); val uid = GraphStore(s).graph.objects.entries.single { it.value.type == "Person" }.key
        val gs = GraphStore(s)
        val interaction = VersionedGraph.createObject("Interaction", buildJsonObject { put("channel", "sms"); put("text", "Message for other Cameron"); put("timestamp", "2026-01-01T00:00:00Z") })
        val profile = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", "public_profile"); put("value", "https://example.test/cameron"); put("site", "Website") })
        s = gs.commit(listOf(interaction, VersionedGraph.createEdge("participant", interaction.target, uid), profile, VersionedGraph.createEdge("subject_of", uid, profile.target)))
        val store = Store(temp.newFolder()); store.installOffline(snapshot(s.bundle))
        val originalObjects = GraphStore(store.snapshot().graph!!).graph.objects
        val selection = store.associations(uid)
        val edges = selection.associations.filter { it.kind in setOf("participant", "has_note", "subject_of") || it.label.startsWith("phone:") }.map { it.id }
        val id = store.split(selection, "Other Cameron", edges)
        val next = GraphStore(store.snapshot().graph!!)
        assertTrue(originalObjects.all { next.graph.objects[it.key] == it.value })
        assertTrue(edges.none { next.graph.active(it) })
        assertEquals(2, store.state.value.records.people.size)
        assertEquals("Other Cameron", store.state.value.records.people.getValue(id).name)
        assertEquals(setOf("phone"), store.state.value.records.people.getValue(id).contactFields().map { it.kind }.toSet())
        assertEquals(id, store.state.value.records.events.values.single().person_id)
        assertEquals(id, store.state.value.records.profiles.values.single().person_id)
        assertEquals(1, next.associated(store.state.value.records.people.getValue(id).contact_uid).count { it.second.type == "participant" })
        val before = store.snapshot()
        try { store.split(selection, "Stale", edges); fail("stale selection") } catch (_: IllegalArgumentException) { }
        assertEquals(before, store.snapshot())
    }

    @Test fun `merge retract and split operate on original component associations`() = runBlocking {
        val store = Store(temp.newFolder()); val a = store.saveContact(ContactCard("Cam A", notes = "A")); val b = store.saveContact(ContactCard("Cam B", notes = "B"))
        store.enqueue("merge", buildJsonObject { putJsonArray("person_ids") { add(a); add(b) } })
        var merged = store.state.value.records.people.values.single()
        assertEquals(2, store.associations(merged.contact_uid).associations.count { it.kind == "has_note" })
        store.enqueue("merge_undo", personPayload(merged.contact_uid))
        assertEquals(setOf("Cam A", "Cam B"), store.state.value.records.people.values.map { it.name }.toSet())
        val ids = store.state.value.records.people.keys
        store.enqueue("merge", buildJsonObject { put("person_ids", JsonArray(ids.map(::JsonPrimitive))) })
        merged = store.state.value.records.people.values.single()
        val selection = store.associations(merged.contact_uid)
        store.split(selection, "Cam separated", listOf(selection.associations.first { it.label == "B" }.id))
        assertEquals(2, store.state.value.records.people.size)
        assertEquals(setOf("A", "B"), store.state.value.records.events.values.map { it.value }.toSet())
    }

    @Test fun `queued legacy mutations migrate atomically while unknown requests and failed payloads remain`() = runBlocking {
        val source = uuid(); val uid = uuid(); val dir = temp.newFolder()
        val person = Person("Cameron", uid, card = ContactCard("Cameron"))
        fun op(kind: String, p: JsonObject) = PendingOp(uuid(), kind, p)
        val note = op("note", personPayload(uid) { put("person_id", 7); put("text", "Queued before upgrade") })
        val legacy = op("extract", personPayload(uid) { put("person_id", 7) })
        val failed = op("relationship", personPayload(uid) { put("category", "friend") })
        val old = DiskState(records = Records(people = mapOf(7 to person)), pending = listOf(note, legacy), failedEdits = listOf(failed), offlineSource = source, offlineRevision = 1)
        File(dir, "store.json").writeText(json.encodeToJsonElement(old).toString())
        val remote = GraphStore(GraphStore.empty()).saveCard(uid, person.contactCard())
        val store = Store(dir); store.installOffline(snapshot(remote.bundle, source, 2))
        assertEquals(listOf(legacy), store.state.value.pending)
        assertEquals(listOf(failed), store.state.value.failedEdits)
        assertEquals("Queued before upgrade", store.state.value.records.events.values.single().value)
        assertEquals(7, store.state.value.records.events.values.single().person_id)
        val restart = Store(dir); restart.initialize()
        assertEquals(store.state.value.records, restart.state.value.records)
        assertEquals(legacy.payload, restart.unsent().single().payload)
        assertTrue(File(dir, "store.json").readText().contains("Queued before upgrade"))
    }

    @Test fun `invalid graph and missing blobs cannot partially change a store`() = runBlocking {
        val store = Store(temp.newFolder()); val original = base(); store.installOffline(snapshot(original.bundle))
        val before = store.snapshot(); val graph = GraphStore(before.graph!!)
        val asset = VersionedGraph.createObject("Asset", buildJsonObject { put("content", buildJsonObject { put("blob_hash", "a".repeat(64)) }) })
        val c = graph.graph.commit(uuid(), listOf(asset), original.bundle.collection)
        val bad = original.bundle.copy(heads = listOf(c.id), commits = original.bundle.commits + c)
        try { store.installOffline(snapshot(bad, revision = 2)); fail("missing blob") } catch (_: IllegalArgumentException) { }
        assertEquals(before, store.snapshot())
        try { store.installOffline(snapshot(original.bundle.copy(collection = uuid()), revision = 2)); fail("foreign collection") } catch (_: IllegalArgumentException) { }
        assertEquals(before, store.snapshot())
    }

    @Test fun `native profile and moment reviews are durable graph edits not queued requests`() = runBlocking {
        var s = base(); val uid = GraphStore(s).graph.objects.entries.single { it.value.type == "Person" }.key
        val profile = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", "public_profile"); put("value", "https://example.test/cam"); put("site", "Website") })
        val moment = VersionedGraph.createObject("Moment", buildJsonObject { put("kind", "birthday"); put("reason", "Birthday"); put("surfaced_on", "2026-01-01") })
        s = GraphStore(s).commit(listOf(profile, VersionedGraph.createEdge("subject_of", uid, profile.target), moment, VersionedGraph.createEdge("about", moment.target, uid)))
        val store = Store(temp.newFolder()); store.installOffline(snapshot(s.bundle))
        store.enqueue("profile_status", buildJsonObject { put("profile_id", profile.target); put("status", "confirmed") })
        store.enqueue("moment_status", buildJsonObject { put("key", moment.target); put("status", "done") })
        assertEquals("confirmed", store.state.value.records.profiles.getValue(profile.target).status)
        assertEquals("done", store.state.value.records.moments.getValue(moment.target).status)
        assertTrue(store.unsent().isEmpty())
        val b = store.bluetoothEdits(s.bundle.collection)
        assertNotNull(b.graph); assertTrue(b.ops.isEmpty())
    }

    @Test fun `actual Python runtime graph projects current native screens without resurfacing rejected facts`() {
        val fixture = json.parseToJsonElement(javaClass.getResource("/python-graph-runtime.json")!!.readText()).jsonObject
        val expected = fixture.getValue("expected").jsonObject
        val bundle = VersionedGraph.wire.decodeFromJsonElement<GraphBundle>(fixture.getValue("graph"))
        val gs = GraphStore(GraphState(bundle)); val records = gs.project()
        val person = records.people.values.single()
        assertEquals(expected.text("uid"), person.contact_uid)
        assertEquals(expected.text("name"), person.name)
        assertEquals(expected.getValue("phones").jsonArray.map { it.jsonPrimitive.content }.toSet(), person.contactFields().filter { it.kind == "phone" }.map { it.value }.toSet())
        assertTrue(person.contactFields().all { it.object_id.isNotEmpty() })
        assertEquals(expected.getValue("muted").jsonPrimitive.boolean, person.muted)
        assertTrue(person.contactCard().notes.contains("Review this note"))
        assertTrue(records.events.values.none { it.value == expected.text("rejected_fact") })
        assertNotNull(person.last_contact)
        assertTrue(person.channels.sumOf { it.count } >= 1)
        val raw = VersionedGraph.wire.encodeToString(GraphBundle.serializer(), bundle)
        val blobText = bundle.blobs.values.joinToString("\n") {
            val bytes = java.util.Base64.getDecoder().decode(it)
            if (bytes.size > 2 && bytes[0] == 0x1f.toByte() && bytes[1] == 0x8b.toByte()) java.util.zip.GZIPInputStream(bytes.inputStream()).bufferedReader().use { reader -> reader.readText() }
            else bytes.toString(Charsets.UTF_8)
        }
        assertTrue(raw.contains(expected.text("raw_message")) || blobText.contains(expected.text("raw_message")))
    }

    @Test fun `contact point identity combines concurrent label and number edits`() = runBlocking {
        val original = base(); val source = uuid(); val a = Store(temp.newFolder()); val b = Store(temp.newFolder())
        a.installOffline(snapshot(original.bundle, source)); b.installOffline(snapshot(original.bundle, source))
        val pa = a.state.value.records.people.entries.single(); val pb = b.state.value.records.people.entries.single()
        val phone = pa.value.contactFields().single { it.kind == "phone" }
        assertTrue(phone.object_id.isNotEmpty())
        a.saveContact(pa.value.contactCard().copy(fields = pa.value.contactFields().map { if (it.object_id == phone.object_id) it.copy(label = "Home") else it }), pa.key)
        b.saveContact(pb.value.contactCard().copy(fields = pb.value.contactFields().map { if (it.object_id == phone.object_id) it.copy(value = "+442079460018") else it }), pb.key)
        a.installOffline(snapshot(b.snapshot().graph!!.bundle, source, 2))
        val merged = a.state.value.records.people.values.single().contactFields().single { it.kind == "phone" }
        assertEquals(phone.object_id, merged.object_id); assertEquals("Home", merged.label); assertEquals("+442079460018", merged.value)
        assertTrue(a.state.value.records.people.values.single().contact_conflicts.isEmpty())
        assertTrue(GraphStore(a.snapshot().graph!!).graph.objects.containsKey(phone.object_id))
        val disk = a.snapshot()
        assertEquals(disk, StoreCheckpoint.decode(StoreCheckpoint.encode(disk)))
    }

    @Test fun `batch participant associations preserve all message blobs and count statistics without flattening`() = runBlocking {
        var state = base(); val gs = GraphStore(state); val uid = gs.project().people.values.single().contact_uid
        val rows = buildJsonArray { repeat(256) { n -> add(buildJsonObject { put("at", "2026-01-01T00:00:00Z"); put("channel", "sms"); put("direction", "in"); put("text", "Complete synthetic raw message $n"); put("source_ref", "synthetic:$n") }) } }
        val bytes = rows.toString().toByteArray(); val hash = GraphStore.digest(bytes)
        val batch = VersionedGraph.createObject("InteractionBatch", buildJsonObject { put("content", buildJsonObject { put("blob_hash", hash) }); put("count", 256); put("channel", "sms"); put("thread", "Synthetic group"); put("first_at", "2026-01-01T00:00:00Z"); put("last_at", "2026-01-01T00:00:00Z"); put("original_owner", uid) })
        state = gs.commit(listOf(batch, VersionedGraph.createEdge("participant", batch.target, uid)), mapOf(hash to java.util.Base64.getEncoder().encodeToString(bytes)))
        val store = Store(temp.newFolder()); store.installOffline(snapshot(state.bundle))
        val person = store.state.value.records.people.values.single()
        assertEquals(256, person.channels.single().count); assertEquals("2026-01-01T00:00:00Z", person.last_contact)
        val selection = store.associations(uid)
        val selected = selection.associations.single { it.objectId == batch.target }
        assertTrue(selected.label.contains("256 messages")); assertTrue(selected.label.contains("Synthetic group"))
        val target = store.split(selection, "Batch owner", listOf(selected.id))
        assertEquals(256, store.state.value.records.people.getValue(target).channels.single().count)
        val after = store.snapshot().graph!!.bundle
        assertEquals(state.bundle.blobs, after.blobs)
        assertEquals(256, json.parseToJsonElement(java.util.Base64.getDecoder().decode(after.blobs.getValue(hash)).toString(Charsets.UTF_8)).jsonArray.size)
    }

    @Test fun `legacy phone safety and hidden source identifiers survive editing and splitting`() = runBlocking {
        val person = VersionedGraph.createObject("Person", buildJsonObject { put("card_metadata", buildJsonObject { put("legacy_unverified", true) }) })
        val name = VersionedGraph.createObject("Name", buildJsonObject { put("display", "Legacy") })
        val phone = VersionedGraph.createObject("ContactPoint", buildJsonObject { put("kind", "phone"); put("value", "2079460018"); put("compat_table", "identifiers") })
        val google = VersionedGraph.createObject("ContactPoint", buildJsonObject { put("kind", "google"); put("value", "people/synthetic"); put("compat_table", "identifiers") })
        val c = VersionedGraph().commit(uuid(), listOf(person, name, phone, google,
            VersionedGraph.createEdge("has_name", person.target, name.target), VersionedGraph.createEdge("has_contact_point", person.target, phone.target), VersionedGraph.createEdge("has_contact_point", person.target, google.target)))
        val store = Store(temp.newFolder())
        store.installOffline(snapshot(GraphBundle(c.collection, listOf(c.id), listOf(c))))
        val initial = store.state.value.records.people.entries.single()
        assertTrue(initial.value.contactCard().legacy_unverified)
        assertFalse(initial.value.contactCard().canNormalizePhone(initial.value.contactFields().single()))
        assertEquals(listOf("phone"), initial.value.contactFields().map { it.kind })
        store.saveContact(initial.value.contactCard().copy(favorite = true), initial.key)
        val selection = store.associations(person.target)
        assertTrue(selection.associations.any { it.objectId == google.target })
        val moved = store.split(selection, "Legacy split", listOf(selection.associations.single { it.objectId == phone.target }.id))
        val split = store.state.value.records.people.getValue(moved).contactCard()
        assertTrue(split.legacy_unverified)
        assertFalse(split.canNormalizePhone(split.fields.single()))
        store.saveContact(split.copy(legacy_unverified = false, region = "GB"), moved)
        val verified = store.state.value.records.people.getValue(moved).contactCard()
        assertFalse(verified.legacy_unverified)
        assertEquals(phone.target, verified.fields.single().object_id)
        assertTrue(verified.canNormalizePhone(verified.fields.single()))
        assertTrue(GraphStore(store.snapshot().graph!!).associated(person.target).any { it.second.to == google.target })
    }

    @Test fun `pre graph recovery checkpoint and journal are copied once before activation`() = runBlocking {
        val dir = temp.newFolder(); val source = uuid(); val legacy = Store(dir)
        legacy.installOffline(TransferManifest(type = "snapshot", source = source, revision = 1))
        legacy.enqueue("note", buildJsonObject { put("person_id", 999); put("text", "Must remain recoverable") })
        val journalBefore = File(dir, "store.journal").readBytes()
        legacy.installOffline(snapshot(base().bundle, source, 2))
        val backup = File(dir, "pre-graph-backup")
        assertTrue(File(backup, "complete").isFile)
        assertArrayEquals(journalBefore, File(backup, "store.journal").readBytes())
        assertEquals("Must remain recoverable", StoreJournal(backup).load().pending.single().payload.text("text"))
        legacy.installOffline(snapshot(legacy.snapshot().graph!!.bundle, source, 3))
        assertArrayEquals(journalBefore, File(backup, "store.journal").readBytes())
    }

    @Test fun `first confirmed pairing joins standalone graph without rewriting old commit UUIDs`() = runBlocking {
        val directory = temp.newFolder()
        val store = Store(directory)
        store.saveContact(ContactCard("Standalone person", fields = listOf(ContactField("email", "local@example.test"))))
        val before = store.snapshot().graph!!
        val target = uuid(); val source = uuid(); val publisher = uuid()
        val upload = store.bluetoothEdits(source, publisher, target).graph!!
        assertEquals(target, upload.collection)
        assertTrue(upload.commits.none { c -> before.bundle.commits.any { it.id == c.id } })
        assertEquals("Standalone person", store.state.value.records.people.values.single().name)
        val originals = upload.blobs.values.map { java.util.Base64.getDecoder().decode(it).toString(Charsets.UTF_8) }
        assertTrue(originals.any { it.contains(before.bundle.collection) })
        val recovery = File(directory, "pre-graph-join-${before.bundle.collection}")
        assertTrue(File(recovery, "complete").isFile)
        assertEquals(before.bundle, StoreJournal(recovery).load().graph!!.bundle)
        val remote = GraphStore(GraphState(GraphBundle(target))).saveCard(uuid(), ContactCard("Mac person"))
        store.installOffline(TransferManifest(type = "snapshot", source = source, publisher = publisher, revision = 1, graph = remote.bundle))
        assertEquals(setOf("Standalone person", "Mac person"), store.state.value.records.people.values.map { it.name }.toSet())
        try { store.bluetoothEdits(source, publisher, uuid()); fail("Established collections must not be silently joined") } catch (_: IllegalArgumentException) { }
    }

    @Test fun `produce native graph bundle for Python runtime verification`() = runBlocking {
        val store = Store(temp.newFolder())
        val id = store.saveContact(ContactCard("Native Cameron", given = "Native", family = "Cameron", birthday = "--02-29", organization = "Synthetic Lab", favorite = true, notes = "Native card note", originals = listOf("BEGIN:VCARD\nFN:Native Cameron\nX-RETAIN:yes\nEND:VCARD"), fields = listOf(ContactField("phone", "+442079460018", "Work"), ContactField("email", "native@example.test"), ContactField("website", "https://example.test/native", user_added = true))))
        val uid = store.state.value.records.people.getValue(id).contact_uid
        store.enqueue("note", personPayload(uid) { put("text", "Native graph note") })
        store.enqueue("event_add", personPayload(uid) { put("type", "interest"); put("value", "Graph protocols"); put("date", "2026") })
        store.enqueue("relationship", personPayload(uid) { put("category", "friend"); put("closeness", .75); put("cadence_days", 21); put("muted", true) })
        val other = store.saveContact(ContactCard("Native Other", notes = "Other note"))
        store.enqueue("merge", buildJsonObject { putJsonArray("person_ids") { add(id); add(other) } })
        val p = store.state.value.records.people.values.single()
        val selection = store.associations(p.contact_uid)
        store.split(selection, "Native Split", listOf(selection.associations.first { it.label == "Other note" }.id))
        File("build/interop-native-graph.json").writeText(VersionedGraph.wire.encodeToString(GraphBundle.serializer(), store.snapshot().graph!!.bundle))
        File("build/interop-native-graph.zip").writeBytes(Transfer.pack(TransferManifest(type = "edits", source = store.snapshot().graph!!.bundle.collection, graph = store.snapshot().graph!!.bundle)))
        Unit
    }
}
