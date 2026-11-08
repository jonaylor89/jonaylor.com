package app.mypeople.data

import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ContactMoveTest {
    @get:Rule val temp = TemporaryFolder()
    private fun uid() = UUID.randomUUID().toString()
    private suspend fun install(state: GraphState): Store = Store(temp.newFolder()).also {
        it.installOffline(TransferManifest(type = "snapshot", source = state.bundle.collection, revision = 1, graph = state.bundle))
    }

    @Test fun `move to existing contact preserves original objects unrelated data and is undoable`() = runBlocking {
        val store = Store(temp.newFolder())
        val sourceId = store.saveContact(ContactCard("Cameron", notes = "Unrelated note", fields = listOf(ContactField("phone", "+12025550101"), ContactField("instagram", "othercam"))))
        val targetId = store.saveContact(ContactCard("Other Cameron", fields = listOf(ContactField("email", "cam@example.test"))))
        val source = store.state.value.records.people.getValue(sourceId)
        val target = store.state.value.records.people.getValue(targetId)
        val selection = store.associations(source.contact_uid)
        val anchor = selection.associations.single { it.url == "https://www.instagram.com/othercam/" }
        val original = store.snapshot().graph!!
        val receipt = store.moveContactItems(selection, selection.movingWith(anchor.id), target.contact_uid)
        assertEquals(target.contact_uid, receipt.destinationUid)
        val people = store.state.value.records.people
        assertEquals(2, people.size)
        assertEquals(listOf("phone"), people.getValue(sourceId).contactFields().map { it.kind })
        assertEquals(setOf("email", "instagram"), people.getValue(targetId).contactFields().map { it.kind }.toSet())
        assertEquals("Unrelated note", people.getValue(sourceId).contactCard().notes)
        assertEquals("Other Cameron", people.getValue(targetId).name)
        val moved = GraphStore(store.snapshot().graph!!)
        assertTrue(GraphStore(original).graph.objects.all { moved.graph.objects[it.key] == it.value })
        assertEquals(anchor.objectId, moved.selection(target.contact_uid).associations.single { it.kind == "has_contact_point" && it.label.contains("othercam") }.objectId)
        store.undoContactMove(receipt)
        assertEquals(source.contactCard(), store.state.value.records.people.getValue(sourceId).contactCard())
        assertEquals(target.contactCard(), store.state.value.records.people.getValue(targetId).contactCard())
    }

    @Test fun `new contact move supports safe undo and survives restart`() = runBlocking {
        val directory = temp.newFolder()
        val store = Store(directory)
        val sourceId = store.saveContact(ContactCard("Cameron", fields = listOf(ContactField("phone", "+12025550101"), ContactField("phone", "+12025550102"))))
        val source = store.state.value.records.people.getValue(sourceId)
        val selection = store.associations(source.contact_uid)
        val anchor = selection.associations.single { it.label.contains("+12025550102") }
        val receipt = store.moveContactItems(selection, setOf(anchor.id), name = "Other Cameron")
        val restarted = Store(directory); restarted.initialize()
        assertEquals(store.state.value.records.people, restarted.state.value.records.people)
        restarted.undoContactMove(receipt)
        assertEquals(source.contactCard(), restarted.state.value.records.people.getValue(sourceId).contactCard())
        val undoneTarget = restarted.state.value.records.people.values.single { it.contact_uid == receipt.destinationUid }
        assertTrue(undoneTarget.trashed)
        assertEquals("Other Cameron", undoneTarget.name)
    }

    @Test fun `moves and undo reject stale frontiers and invalid destinations atomically`() = runBlocking {
        val store = Store(temp.newFolder())
        val id = store.saveContact(ContactCard("Cameron", fields = listOf(ContactField("phone", "+12025550101"))))
        val source = store.state.value.records.people.getValue(id)
        val selection = store.associations(source.contact_uid)
        val edge = selection.associations.single { it.kind == "has_contact_point" }.id
        val before = store.snapshot()
        for (destination in listOf(source.contact_uid, uid())) {
            try { store.moveContactItems(selection, setOf(edge), destination); fail("Invalid destination") } catch (_: IllegalArgumentException) { }
            assertEquals(before, store.snapshot())
        }
        val receipt = store.moveContactItems(selection, setOf(edge), name = "Other Cameron")
        try { store.moveContactItems(selection, setOf(edge), name = "Stale"); fail("Stale selection") } catch (_: IllegalArgumentException) { }
        store.enqueue("note", buildJsonObject { put("contact_uid", source.contact_uid); put("text", "Later edit") })
        val later = store.snapshot()
        try { store.undoContactMove(receipt); fail("Unsafe undo") } catch (_: IllegalArgumentException) { }
        assertEquals(later, store.snapshot())
    }

    @Test fun `legacy phone safety follows a move to an existing contact and undo restores metadata`() = runBlocking {
        val store = Store(temp.newFolder())
        val sourceId = store.saveContact(ContactCard("Legacy", fields = listOf(ContactField("phone", "02025550101")), legacy_unverified = true))
        val targetId = store.saveContact(ContactCard("Verified", region = "GB"))
        val source = store.state.value.records.people.getValue(sourceId)
        val target = store.state.value.records.people.getValue(targetId)
        val selection = store.associations(source.contact_uid)
        val receipt = store.moveContactItems(selection, setOf(selection.associations.single { it.kind == "has_contact_point" }.id), target.contact_uid)
        val card = store.state.value.records.people.getValue(targetId).contactCard()
        assertTrue(card.legacy_unverified)
        assertFalse(card.canNormalizePhone(card.fields.single()))
        store.undoContactMove(receipt)
        assertEquals(target.contactCard(), store.state.value.records.people.getValue(targetId).contactCard())
    }

    @Test fun `local phone moves never silently adopt the destination country`() = runBlocking {
        val store = Store(temp.newFolder())
        val sourceId = store.saveContact(ContactCard("UK contact", region = "GB", fields = listOf(ContactField("phone", "02079460018"))))
        val targetId = store.saveContact(ContactCard("German contact", region = "DE"))
        val source = store.state.value.records.people.getValue(sourceId)
        val target = store.state.value.records.people.getValue(targetId)
        var selection = store.associations(source.contact_uid)
        var point = selection.associations.single { it.kind == "has_contact_point" }
        val before = store.snapshot()
        try { store.moveContactItems(selection, setOf(point.id), target.contact_uid); fail("Country must not change") } catch (_: IllegalArgumentException) { }
        assertEquals(before, store.snapshot())
        store.saveContact(source.contactCard().copy(fields = source.contactFields().map { it.copy(region = "GB") }), sourceId)
        selection = store.associations(source.contact_uid)
        point = selection.associations.single { it.kind == "has_contact_point" }
        store.moveContactItems(selection, setOf(point.id), target.contact_uid)
        assertEquals("GB", store.state.value.records.people.getValue(targetId).contactFields().single().region)
    }

    @Test fun `message evidence follows its specific interaction but mixed evidence stays`() = runBlocking {
        var state = GraphStore(GraphStore.empty()).saveCard(uid(), ContactCard("Cameron"))
        val graph = GraphStore(state)
        val person = graph.graph.people.single()
        val messages = List(2) { VersionedGraph.createObject("Interaction", buildJsonObject { put("channel", "sms"); put("text", "Synthetic message $it") }) }
        val ops = messages.toMutableList()
        messages.forEach { ops += VersionedGraph.createEdge("participant", it.target, person) }
        fun claim(label: String, inputs: List<String>): String {
            val fact = VersionedGraph.createObject("Claim", buildJsonObject { put("predicate", "test"); put("value", label) })
            val evidence = VersionedGraph.createObject("Evidence")
            ops += listOf(fact, evidence, VersionedGraph.createEdge("subject_of", person, fact.target), VersionedGraph.createEdge("supported_by", fact.target, evidence.target))
            inputs.forEach { ops += VersionedGraph.createEdge("drawn_from", evidence.target, it) }
            return fact.target
        }
        val exclusive = claim("Exclusive", listOf(messages[0].target))
        claim("Mixed", messages.map { it.target })
        state = graph.commit(ops)
        val store = install(state)
        val selection = store.associations(person)
        val anchor = selection.associations.single { it.objectId == messages[0].target }
        val fact = selection.associations.single { it.objectId == exclusive }
        assertEquals(setOf(anchor.id, fact.id), selection.movingWith(anchor.id))
        val receipt = store.moveContactItems(selection, selection.movingWith(anchor.id), name = "Other Cameron")
        val moved = GraphStore(store.snapshot().graph!!).selection(receipt.destinationUid)
        assertEquals(setOf(messages[0].target, exclusive), moved.associations.filter { it.kind != "has_name" }.map { it.objectId }.toSet())
    }

    @Test fun `a shared legacy person snapshot is not phone specific evidence`() {
        val person = uid()
        var state = GraphStore(GraphStore.empty()).saveCard(person, ContactCard("Mixed contact", birthday = "1990-01-01", fields = listOf(ContactField("phone", "+12025550101"))))
        val graph = GraphStore(state)
        val rows = graph.selection(person).associations
        val point = rows.single { it.kind == "has_contact_point" }
        val birthday = rows.single { it.kind == "subject_of" }
        val snapshot = VersionedGraph.createObject("SourceRecord", buildJsonObject { put("table", "people") })
        state = graph.commit(listOf(snapshot, VersionedGraph.createEdge("originated_from", point.objectId, snapshot.target), VersionedGraph.createEdge("originated_from", birthday.objectId, snapshot.target)))
        assertEquals(setOf(point.id), GraphStore(state).selection(person).movingWith(point.id))
    }

    @Test fun `duplicate component attributions move once and the same component is not a destination`() = runBlocking {
        val source = uid(); val alias = uid()
        var state = GraphStore(GraphStore.empty()).saveCard(source, ContactCard("Source", fields = listOf(ContactField("email", "cam@example.test"))))
        state = GraphStore(state).saveCard(alias, ContactCard("Alias"))
        val graph = GraphStore(state)
        val point = graph.selection(source).associations.single { it.kind == "has_contact_point" }
        state = graph.commit(listOf(VersionedGraph.createEdge("same_person", source, alias), VersionedGraph.createEdge("has_contact_point", alias, point.objectId)))
        val store = install(state)
        val selection = store.associations(source)
        val selected = selection.movingWith(point.id)
        assertEquals(2, selected.size)
        val before = store.snapshot()
        try { store.moveContactItems(selection, selected, alias); fail("Same component") } catch (_: IllegalArgumentException) { }
        assertEquals(before, store.snapshot())
        val receipt = store.moveContactItems(selection, selected, name = "Other Cameron")
        assertEquals(1, GraphStore(store.snapshot().graph!!).selection(receipt.destinationUid).associations.count { it.objectId == point.objectId })
        store.undoContactMove(receipt)
        assertEquals(2, GraphStore(store.snapshot().graph!!).selection(source).associations.count { it.objectId == point.objectId })
    }

    @Test fun `moving an already shared object does not duplicate its destination attribution`() = runBlocking {
        val source = uid(); val target = uid()
        var state = GraphStore(GraphStore.empty()).saveCard(source, ContactCard("Source", fields = listOf(ContactField("email", "cam@example.test"))))
        state = GraphStore(state).saveCard(target, ContactCard("Target"))
        val graph = GraphStore(state)
        val anchor = graph.selection(source).associations.single { it.kind == "has_contact_point" }
        state = graph.commit(listOf(VersionedGraph.createEdge("has_contact_point", target, anchor.objectId)))
        val store = install(state)
        val selection = store.associations(source)
        val receipt = store.moveContactItems(selection, setOf(anchor.id), target)
        assertEquals(1, GraphStore(store.snapshot().graph!!).selection(target).associations.count { it.objectId == anchor.objectId })
        store.undoContactMove(receipt)
        assertEquals(1, GraphStore(store.snapshot().graph!!).selection(source).associations.count { it.objectId == anchor.objectId })
    }
}
