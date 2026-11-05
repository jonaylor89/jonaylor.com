package app.mypeople.data

import kotlinx.serialization.json.*
import kotlinx.coroutines.runBlocking
import org.junit.Rule
import org.junit.rules.TemporaryFolder
import org.junit.Assert.*
import org.junit.Test

class MergeEditsTest {
    @get:Rule val temp = TemporaryFolder()
    private val records = Records(people = mapOf(1 to Person("First"), 2 to Person("Second")))
    @Test fun `external Android edits cannot overwrite or trash a concurrently changed contact`() = runBlocking {
        val store = Store(temp.newFolder())
        val before = Person("Original", contact_uid = newContactUid(), card = ContactCard("Original", notes = "Before"))
        store.receive(Changes(1, false, listOf(RecordChange("person", "1", json.encodeToJsonElement(before))), emptyList()))
        store.saveContact(before.card!!.copy(notes = "User changed this"), 1)
        try { store.saveContact(before.card.copy(notes = "External stale edit"), 1, expectedPerson = before); fail("Concurrent update") } catch (_: EditRejected) { }
        try { store.enqueue("contact_trash", buildJsonObject { put("person_id", 1); put("contact_uid", before.contact_uid) }, expectedPerson = before); fail("Concurrent deletion") } catch (_: EditRejected) { }
        assertEquals("User changed this", store.state.value.records.people[1]?.card?.notes)
        assertFalse(store.state.value.records.people[1]!!.trashed)
        assertEquals(1, store.state.value.pending.size)
    }
    @Test fun `restoring an external version and its contact card is one durable transaction`() = runBlocking {
        val store = Store(temp.newFolder())
        val before = Person("Original", contact_uid = newContactUid(), card = ContactCard("Original", notes = "Before"), trashed = true)
        store.receive(Changes(1, false, listOf(RecordChange("person", "1", json.encodeToJsonElement(before))), emptyList()))
        store.saveContact(before.card!!.copy(notes = "External version"), 1, expectedPerson = before, restore = true)
        assertEquals(listOf("contact_restore", "contact_save"), store.state.value.pending.map { it.kind })
        assertFalse(store.state.value.records.people[1]!!.trashed)
        assertEquals("External version", store.state.value.records.people[1]?.card?.notes)
    }
    @Test fun `merge validates every participant before provider reconciliation`() {
        assertEquals(setOf(1, 2), mergePeople(json.parseToJsonElement("""{"person_ids":[1,2]}""").jsonObject, records))
        for (payload in listOf("{}", """{"person_ids":[1]}""", """{"person_ids":[1,1]}""", """{"person_ids":[1,99]}""", """{"person_ids":["1",2]}""", """{"person_ids":[1,-2]}""")) {
            try { mergePeople(json.parseToJsonElement(payload).jsonObject, records); fail("Invalid merge: $payload") }
            catch (e: EditRejected) { assertFalse(e.message.isNullOrBlank()) }
        }
    }
}
