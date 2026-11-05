package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class StoreTest {
    @get:Rule val temp = TemporaryFolder()
    private val payload = buildJsonObject { put("person_id", 1); put("name", "Renamed") }

    @Test fun `outbox cursor ack and server view survive process restart`() = runBlocking {
        val dir = temp.newFolder()
        val first = Store(dir)
        first.initialize()
        first.receive(Changes(10, false, listOf(RecordChange("person", "1", json.encodeToJsonElement(Person("Original")))), emptyList()))
        first.enqueue("rename", payload)
        val id = first.unsent().single().client_id
        assertEquals(id, first.unsent().single().client_id) // retry uses identical UUID
        assertEquals("Renamed", first.state.value.records.people[1]?.name)
        val restarted = Store(dir)
        restarted.initialize()
        assertEquals(10L, restarted.cursor())
        assertEquals(id, restarted.unsent().single().client_id)
        restarted.sent(setOf(id))
        val again = Store(dir)
        again.initialize()
        assertTrue(again.unsent().isEmpty())
        assertEquals(1, again.state.value.pending.size) // sent is NOT done
        again.receive(Changes(11, false, listOf(RecordChange("person", "1", json.encodeToJsonElement(Person("Renamed")))), listOf(OpState(1, id, "rename", payload, "done"))))
        val finished = Store(dir)
        finished.initialize()
        assertEquals(11L, finished.cursor())
        assertTrue(finished.state.value.pending.isEmpty())
        assertEquals("Renamed", finished.state.value.records.people[1]?.name)
    }
    @Test fun `retry rejected relationship uses a fresh UUID without losing its payload`() = runBlocking {
        val dir = temp.newFolder()
        val store = Store(dir)
        val payload = buildJsonObject { put("person_id", 1); put("contact_uid", "11111111-1111-4111-8111-111111111111"); put("category", "friend") }
        store.enqueue("relationship", payload)
        val original = store.unsent().single()
        store.receive(Changes(1, false, emptyList(), listOf(OpState(1, original.client_id, original.kind, original.payload, "failed", "Unknown relationship field 'contact_uid'"))))
        store.retryFailed(original.client_id)
        val restarted = Store(dir); restarted.initialize()
        val retry = restarted.unsent().single()
        assertNotEquals(original.client_id, retry.client_id)
        assertEquals("relationship", retry.kind); assertEquals(original.payload, retry.payload)
        assertFalse(retry.completed); assertFalse(retry.sent)
        assertTrue(restarted.state.value.failedEdits.isEmpty())
        try { restarted.retryFailed(original.client_id); fail("Cannot retry twice") } catch (_: IllegalArgumentException) { }
        assertEquals(1, restarted.unsent().size)
    }
    @Test fun `switching devices cannot discard pending edits`() = runBlocking {
        val store = Store(temp.newFolder())
        store.enqueue("rename", payload)
        try { store.reset(); fail("Must protect outbox") } catch (_: IllegalArgumentException) { }
        assertEquals(1, store.unsent().size)
    }
    @Test fun `corrupt disk is never silently replaced`() = runBlocking {
        val dir = temp.newFolder()
        val file = File(dir, "store.json").apply { writeText("broken") }
        val store = Store(dir)
        try { store.initialize(); fail("Expected corruption") } catch (_: IllegalArgumentException) { }
        try { store.enqueue("rename", payload); fail("Expected corruption") } catch (_: IllegalArgumentException) { }
        assertEquals("broken", file.readText())
    }
    @Test fun `deletions null JSON and result notifications are persisted together`() = runBlocking {
        val dir = temp.newFolder()
        val store = Store(dir)
        store.enqueue("rename", payload)
        val op = store.unsent().single()
        store.receive(Changes(20, false, listOf(RecordChange("person", "1", JsonNull)), listOf(OpState(1, op.client_id, op.kind, payload, "failed", "No person #1"))))
        val restarted = Store(dir)
        restarted.initialize()
        assertEquals(20L, restarted.cursor())
        assertTrue(restarted.state.value.pending.isEmpty())
        val notice = restarted.state.value.notices.single()
        assertEquals("No person #1", notice.message)
        restarted.dismissNotice(notice.id)
        assertTrue(restarted.state.value.notices.isEmpty())
    }
}
