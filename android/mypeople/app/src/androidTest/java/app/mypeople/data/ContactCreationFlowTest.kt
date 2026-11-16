package app.mypeople.data

import androidx.compose.runtime.*
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.AppGraph
import app.mypeople.MyPeopleApp
import app.mypeople.ui.ContactEditor
import app.mypeople.ui.MyPeopleTheme
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Fresh opted-in emulator only. Leaves synthetic graph commits; uninstall the test app to clean. */
@RunWith(AndroidJUnit4::class)
class ContactCreationFlowTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var graph: AppGraph
    private val extractor = FakeDescriptionExtractor()

    private class FakeDescriptionExtractor : ContactDescriptionExtractor {
        var status = ContactDescriptionAvailability.AVAILABLE
        var fail = false
        var calls = 0
        var gate: CompletableDeferred<Unit>? = null
        var cancelled = false
        var availabilityGate: CompletableDeferred<Unit>? = null
        override suspend fun availability(): ContactDescriptionAvailability {
            availabilityGate?.await()
            return status
        }
        override suspend fun extract(description: String, region: String): ContactCard {
            calls++
            if (fail) error("Synthetic extraction failure")
            try { gate?.await() } catch (e: CancellationException) { cancelled = true; throw e }
            return parseContactDescription(description, """{"person_count":1,"name":"John Doe","organization":"SoAndSo Startup","phones":["+11234567890"],"context":"Met at Climate Week."}""", region)
        }
    }

    @Before fun disposableOnly() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true" && android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))
        graph = (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty() && graph.store.state.value.pending.isEmpty()) { "Refusing to use an existing installation." }
    }

    private fun tap(label: String) = compose.onNode(hasText(label) or hasContentDescription(label)).performSemanticsAction(SemanticsActions.OnClick)

    @Test fun oneFormProtectsManualDraftsAndReviewsLocalExtraction() {
        var open by mutableStateOf(true)
        var editor by mutableIntStateOf(0)
        var savedId: Int? = null
        compose.setContent { MyPeopleTheme { key(editor) { if (open) ContactEditor(graph, descriptionExtractor = extractor, close = { open = false }, saved = { savedId = it }) } } }
        tap("Add manually")
        compose.onNodeWithText("Let them fill it in").assertDoesNotExist()
        compose.onNodeWithText("Your details").assertDoesNotExist()
        compose.onNodeWithText("Name (required)").performTextInput("Conference Sam")
        compose.onNodeWithText("Save contact").assertIsEnabled()
        compose.runOnIdle {
            assertNull(savedId)
            assertTrue(graph.store.state.value.records.people.isEmpty())
        }
        tap("Save contact")
        compose.waitUntil(10_000) { savedId != null }
        compose.runOnIdle {
            val card = graph.store.state.value.records.people.getValue(savedId!!).contactCard()
            assertEquals("Conference Sam", card.name)
            assertTrue(card.fields.isEmpty())
            assertFalse(open)
            savedId = null
            editor++
            open = true
        }
        tap("Add manually")
        compose.onNodeWithText("Save contact").assertIsNotEnabled()
        compose.onNodeWithText("Name (required)").performTextInput("  The bookshop owner  ")
        tap("Cancel")
        compose.onNodeWithText("Discard unsaved changes?").assertIsDisplayed()
        tap("Keep editing")
        tap("Save contact")
        compose.waitUntil(10_000) { savedId != null }
        compose.runOnIdle {
            val card = graph.store.state.value.records.people.getValue(savedId!!).contactCard()
            assertEquals("The bookshop owner", card.name)
            assertTrue(card.fields.isEmpty())
            assertEquals(2, graph.store.state.value.records.people.size)
            assertEquals(0, extractor.calls)
            savedId = null
            editor++
            open = true
        }
        val description = "John Doe from SoAndSo Startup +11234567890. Met at Climate Week."
        compose.onNodeWithText("Contact description").performTextInput(description)
        compose.waitUntil(5000) { compose.onNodeWithText("Create draft").isEnabled() }
        tap("Create draft")
        compose.onNodeWithText("Review contact").assertIsDisplayed()
        compose.onNodeWithText("John Doe").assertExists()
        compose.onNodeWithText("SoAndSo Startup").assertExists()
        tap("Show original description")
        compose.onNodeWithText(description).assertExists()
        compose.runOnIdle {
            assertNull(savedId)
            assertEquals(2, graph.store.state.value.records.people.size)
        }
        compose.onNodeWithText("Name (required)").performTextReplacement("John Doe Jr")
        tap("Save contact")
        compose.waitUntil(10_000) { savedId != null }
        compose.runOnIdle {
            val card = graph.store.state.value.records.people.getValue(savedId!!).contactCard()
            assertEquals("John Doe Jr", card.name)
            assertEquals("SoAndSo Startup", card.organization)
            assertEquals("+11234567890", card.fields.single().value)
            assertEquals("Met at Climate Week.", card.notes)
            assertEquals(3, graph.store.state.value.records.people.size)
            extractor.status = ContactDescriptionAvailability.NOT_INSTALLED
            savedId = null
            editor++
            open = true
        }
        compose.onNodeWithText("Name (required)").assertExists()
        compose.onNodeWithText("Contact description").assertDoesNotExist()
        compose.onNodeWithText("Create draft").assertDoesNotExist()
        compose.onNodeWithText("Check again").assertDoesNotExist()
        compose.onNodeWithText("Name (required)").performTextInput("A person to add manually")
        compose.runOnIdle {
            assertEquals(1, extractor.calls)
            assertEquals(3, graph.store.state.value.records.people.size)
            extractor.status = ContactDescriptionAvailability.AVAILABLE
            extractor.fail = true
            editor++
        }
        compose.onNodeWithText("Contact description").performTextInput(description)
        compose.waitUntil(5000) { compose.onNodeWithText("Create draft").isEnabled() }
        tap("Create draft")
        compose.onNodeWithText("Couldn’t extract reliable details.", substring = true).assertExists()
        compose.onNodeWithText(description).assertExists()
        tap("Add manually")
        compose.onNodeWithText("Save contact").assertIsNotEnabled()
        compose.runOnIdle {
            assertEquals(2, extractor.calls)
            assertEquals(3, graph.store.state.value.records.people.size)
            extractor.fail = false
            extractor.gate = CompletableDeferred()
            editor++
        }
        compose.onNodeWithText("Contact description").performTextInput(description)
        compose.waitUntil(5000) { compose.onNodeWithText("Create draft").isEnabled() }
        tap("Create draft")
        compose.onNodeWithText("Creating draft…").assertExists()
        tap("Add manually")
        compose.onNodeWithText("Name (required)").performTextInput("Manually entered")
        compose.runOnIdle { extractor.gate!!.complete(Unit) }
        compose.waitUntil(5000) { extractor.cancelled }
        compose.onNodeWithText("Manually entered").assertExists()
        compose.onNodeWithText("John Doe").assertDoesNotExist()
        compose.runOnIdle {
            assertNull(savedId)
            assertEquals(3, graph.store.state.value.records.people.size)
            extractor.gate = null
            extractor.status = ContactDescriptionAvailability.AICORE_MISSING
            editor++
        }
        for (status in ContactDescriptionAvailability.entries.filter { it != ContactDescriptionAvailability.AVAILABLE }) {
            compose.runOnIdle { extractor.status = status; editor++ }
            compose.onNodeWithText("Name (required)").assertExists()
            compose.onNodeWithText("Contact description").assertDoesNotExist()
            compose.onNodeWithText("Check again").assertDoesNotExist()
            compose.onNodeWithText("Save contact").assertIsNotEnabled()
        }
        compose.runOnIdle {
            extractor.status = ContactDescriptionAvailability.AVAILABLE
            extractor.availabilityGate = CompletableDeferred()
            editor++
        }
        compose.onNodeWithText("Name (required)").performTextInput("Keep my manual entry")
        compose.runOnIdle { extractor.availabilityGate!!.complete(Unit) }
        compose.onNodeWithText("Keep my manual entry").assertExists()
        compose.onNodeWithText("Contact description").assertDoesNotExist()
        compose.runOnIdle {
            assertEquals(3, extractor.calls)
            assertEquals(3, graph.store.state.value.records.people.size)
        }
    }
}

private fun SemanticsNodeInteraction.isEnabled(): Boolean = runCatching { assertIsEnabled(); true }.getOrDefault(false)
