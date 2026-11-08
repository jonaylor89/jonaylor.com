package app.mypeople.data

import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class ContactFieldDeletionTest {
    @get:Rule val temp = TemporaryFolder()

    @Test fun `deleting a duplicate phone or email removes only one saved field and retains facts`() = runBlocking {
        val directory = temp.newFolder()
        val store = Store(directory)
        val id = store.saveContact(ContactCard("Cameron", notes = "Keep this note", birthday = "1990-01-01", fields = listOf(
            ContactField("phone", "+12025550101", "Mobile"), ContactField("phone", "+12025550101", "Work"),
            ContactField("email", "cam@example.test", "Home"), ContactField("email", "cam@example.test", "Work"),
        )))
        val initial = store.state.value.records.people.getValue(id)
        val objects = GraphStore(store.snapshot().graph!!).graph.objects
        val events = store.state.value.records.events
        store.deleteContactField(initial, initial.contactFields().first { it.kind == "phone" }.object_id)
        var person = store.state.value.records.people.getValue(id)
        assertEquals(1, person.contactFields().count { it.kind == "phone" })
        assertEquals(2, person.contactFields().count { it.kind == "email" })
        store.deleteContactField(person, person.contactFields().first { it.kind == "email" }.object_id)
        person = store.state.value.records.people.getValue(id)
        assertEquals(1, person.contactFields().count { it.kind == "email" })
        assertEquals("Keep this note", person.contactCard().notes)
        assertEquals("1990-01-01", person.contactCard().birthday)
        assertEquals(events, store.state.value.records.events)
        assertEquals(objects, GraphStore(store.snapshot().graph!!).graph.objects)
        val restarted = Store(directory); restarted.initialize()
        assertEquals(person.contactCard(), restarted.state.value.records.people.getValue(id).contactCard())
    }

    @Test fun `deletion removes component links but never a shared field on another contact`() = runBlocking {
        val source = UUID.randomUUID().toString(); val alias = UUID.randomUUID().toString(); val other = UUID.randomUUID().toString()
        var state = GraphStore(GraphStore.empty()).saveCard(source, ContactCard("Source", fields = listOf(ContactField("email", "cam@example.test"))))
        state = GraphStore(state).saveCard(alias, ContactCard("Alias"))
        state = GraphStore(state).saveCard(other, ContactCard("Other"))
        val graph = GraphStore(state)
        val point = graph.selection(source).associations.single { it.kind == "has_contact_point" }
        state = graph.commit(listOf(VersionedGraph.createEdge("same_person", source, alias), VersionedGraph.createEdge("has_contact_point", alias, point.objectId), VersionedGraph.createEdge("has_contact_point", other, point.objectId)))
        val store = Store(temp.newFolder())
        store.installOffline(TransferManifest(type = "snapshot", source = state.bundle.collection, revision = 1, graph = state.bundle))
        val person = store.state.value.records.people.values.single { it.contact_uid == source || source in it.contact_aliases }
        store.deleteContactField(person, point.objectId)
        val after = GraphStore(store.snapshot().graph!!)
        assertTrue(after.selection(source).associations.none { it.objectId == point.objectId })
        assertEquals(1, after.selection(other).associations.count { it.objectId == point.objectId })
        assertTrue(after.graph.active(point.objectId))
        assertEquals(JsonPrimitive("cam@example.test"), after.graph.value(point.objectId, "value"))
    }

    @Test fun `stale or foreign field deletions do not change the graph`() = runBlocking {
        val store = Store(temp.newFolder())
        val id = store.saveContact(ContactCard("Cameron", fields = listOf(ContactField("email", "cam@example.test"))))
        val otherId = store.saveContact(ContactCard("Other", fields = listOf(ContactField("email", "other@example.test"))))
        val initial = store.state.value.records.people.getValue(id)
        val foreign = store.state.value.records.people.getValue(otherId).contactFields().single().object_id
        var before = store.snapshot()
        try { store.deleteContactField(initial, foreign); fail("Foreign field") } catch (_: IllegalArgumentException) { }
        assertEquals(before, store.snapshot())
        store.saveContact(initial.contactCard().copy(name = "Updated Cameron"), id)
        before = store.snapshot()
        try { store.deleteContactField(initial, initial.contactFields().single().object_id); fail("Stale view") } catch (_: IllegalArgumentException) { }
        assertEquals(before, store.snapshot())
    }
}
