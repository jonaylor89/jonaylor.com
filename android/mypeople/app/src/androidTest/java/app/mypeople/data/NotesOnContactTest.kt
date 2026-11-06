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
import androidx.compose.ui.test.performTextInput
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.performSemanticsAction
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

    @Test fun aFactIsForgottenByWhatItSaysAndAContactMergesWithAnyOther() = runBlocking {
        seeded = true
        graph.store.receive(Changes(1, false, listOf(
            RecordChange("person", "1", json.encodeToJsonElement(Person("Sam Rivera"))),
            RecordChange("person", "2", json.encodeToJsonElement(Person("Samuel R"))),
            RecordChange("event", "1", json.encodeToJsonElement(Event(1, "family", "Has a sister called Ana", date = "2024", source = "imessage"))),
        ), emptyList()))
        val state = graph.store.state.value
        var left = false
        compose.setContent { MyPeopleTheme { PersonScreen(1, state, graph, onBack = { left = true }) } }
        compose.onNodeWithTag("person-list").performScrollToNode(hasText("Has a sister called Ana"))
        compose.onNodeWithText("Has a sister called Ana").performSemanticsAction(SemanticsActions.OnClick)
        // Through semantics: this emulator refuses injected touches on a dialog's window.
        fun tapWhenReady(text: String) {
            compose.waitUntil(10_000) { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithText(text).performSemanticsAction(SemanticsActions.OnClick)
        }
        tapWhenReady("Forget fact")
        tapWhenReady("Forget")
        compose.waitUntil(5_000) { graph.store.state.value.pending.any { it.kind == "event_forget" } }
        val forget = graph.store.state.value.pending.first { it.kind == "event_forget" }.payload
        assertEquals("Has a sister called Ana", forget.text("value"))
        assertEquals("2024", forget.text("date"))

        compose.onNodeWithTag("person-list").performScrollToNode(hasText("Merge with…"))
        tapWhenReady("Merge with…")
        compose.waitUntil(10_000) { compose.onAllNodesWithTag("merge-search").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithTag("merge-search").performTextInput("samuel")
        tapWhenReady("Samuel R")
        tapWhenReady("Merge")
        compose.waitUntil(5_000) { left }
        assertTrue(graph.store.state.value.pending.any { it.kind == "merge" })
        Unit
    }
}
