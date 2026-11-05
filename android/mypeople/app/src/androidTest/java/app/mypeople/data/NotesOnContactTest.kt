package app.mypeople.data

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performScrollToNode
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.AppGraph
import app.mypeople.MyPeopleApp
import app.mypeople.ui.MyPeopleTheme
import app.mypeople.ui.PersonScreen
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.put
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** What you wrote and what was derived sit together on the contact, and you can tell them apart. */
@RunWith(AndroidJUnit4::class)
class NotesOnContactTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var graph: AppGraph
    private var seeded = false

    @Before fun disposableOnly() = runBlocking {
        assumeTrue("Use an explicitly opted-in disposable emulator", InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        graph = (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        val disk = graph.store.snapshot()
        check(disk.records.people.isEmpty() && disk.pending.isEmpty()) { "Refusing to seed an existing installation." }
    }
    @After fun clear() = runBlocking {
        if (seeded) {
            // A Mac's receipt clears the queued note, which a restore otherwise refuses to discard.
            val receipts = graph.store.state.value.pending.map { OpState(1, it.client_id, it.kind, it.payload, "done") }
            graph.store.receive(Changes(2, false, emptyList(), receipts))
            graph.store.restoreBackup(DiskState())
        }
        Unit
    }

    @Test fun aNoteShowsAtOnceBesideADerivedFact() = runBlocking {
        seeded = true
        graph.store.receive(Changes(1, false, listOf(
            RecordChange("person", "1", json.encodeToJsonElement(Person("Sam Rivera"))),
            RecordChange("event", "1", json.encodeToJsonElement(Event(1, "family", "Has a sister called Ana", source = "note", said_at = "2026-01-01", created_at = "2026-01-01"))),
        ), emptyList()))
        graph.submitEdit("note", buildJsonObject { put("person_id", 1); put("text", "Allergic to peanuts") })
        val state = graph.store.state.value
        compose.setContent { MyPeopleTheme { PersonScreen(1, state, graph, onBack = {}) } }
        val list = compose.onNodeWithTag("person-list")
        list.performScrollToNode(hasText("Allergic to peanuts"))
        compose.onNodeWithText("Allergic to peanuts").assertIsDisplayed()
        compose.onNodeWithText("Added by you · Not yet on your Mac").assertIsDisplayed()
        list.performScrollToNode(hasText("Has a sister called Ana"))
        compose.onNodeWithText("family · Derived from your note").assertIsDisplayed()
        Unit
    }
}
