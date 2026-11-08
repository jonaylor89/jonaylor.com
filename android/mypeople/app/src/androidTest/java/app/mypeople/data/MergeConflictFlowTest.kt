package app.mypeople.data

import android.os.Build
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.compose.runtime.*
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.Modifier
import app.mypeople.ui.ContactDetails
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import app.mypeople.ui.MyPeopleTheme
import app.mypeople.ui.ReviewScreen
import java.io.File
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit opt-in, fresh disposable emulator only. Never chooses real people's identities. */
@RunWith(AndroidJUnit4::class)
class MergeConflictFlowTest {
    @get:Rule val compose = createComposeRule()
    private fun seed(sixEntries: Boolean = false) = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val graph = (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty()) { "Use an empty disposable store" }
        graph.settings.contactsEnabled = false
        val a=UUID.randomUUID().toString(); val b=UUID.randomUUID().toString()
        val aPhones=if(sixEntries) listOf("+442079460018","+44 20 7946 0018","+44 (20) 7946-0018") else listOf("02079460018")
        val bPhones=if(sixEntries) listOf("+12025550101","+1 202 555 0101","+1 (202) 555-0101") else listOf("+442079460018")
        var base=GraphStore(GraphStore.empty()).saveCard(a,ContactCard("Case A",region="GB",notes="A original notes",legacy_unverified=sixEntries,fields=aPhones.map { ContactField("phone",it,"Mobile") }))
        base=GraphStore(base).saveCard(b,ContactCard("Case B",region=if(sixEntries) "US" else "GB",notes="B original notes",legacy_unverified=sixEntries,fields=bPhones.map { ContactField("phone",it,"Mobile") }))
        if(sixEntries) {
            val hints=listOf("2079460018","2025550101").map { value -> VersionedGraph.createObject("ContactPoint",buildJsonObject { put("kind","phone"); put("value",value); put("matching_hint",true); put("compat_table","identifiers") }) }
            base=GraphStore(base).commit(hints + hints.map { VersionedGraph.createEdge("has_contact_point",a,it.target) })
        }
        val separate=GraphStore(base).commit(listOf(VersionedGraph.createEdge("distinct_person",a,b)))
        val merge=GraphStore(base).commit(listOf(VersionedGraph.createEdge("same_person",a,b,buildJsonObject { put("preferred_person",a) })))
        val joined=GraphStore(separate).receive(merge.bundle)
        graph.store.installOffline(TransferManifest(type="snapshot",source=joined.bundle.collection,revision=1,graph=joined.bundle))
        graph
    }

    @Test fun repeatedPhoneEntriesCanBeCleanedWithoutAnsweringAnIdentityQuestion() {
        val graph=seed(sixEntries=true)
        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            MyPeopleTheme { Column(Modifier.verticalScroll(rememberScrollState())) {
                val person=state.records.people.entries.single()
                ContactDetails(person.value,person.key,graph) {}
            } }
        }
        compose.waitUntil(5000) { compose.onAllNodesWithText("Remove 4 repeated entries").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText(phoneDisplay("+442079460018")).assertExists()
        compose.onNodeWithText(phoneDisplay("+12025550101")).assertExists()
        compose.onNodeWithText("2079460018").assertDoesNotExist()
        compose.onNodeWithText("Show 2 unverified import hints").assertExists()
        compose.onNodeWithText("Remove 4 repeated entries").performScrollTo().assertIsEnabled().performClick()
        compose.onNodeWithText("2 distinct numbers · 6 saved entries").assertExists()
        compose.onNodeWithText("This does not confirm a merge or separate any contact records.").assertExists()
        compose.onNodeWithText("Remove repeated entries").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contactFields().size==4 }
        val after=graph.store.state.value.records.people.values.single()
        assertEquals(1,after.mergeDecisionConflicts().size)
        runBlocking {
            val preview=graph.store.contactPhonePreview(after)
            assertEquals(2,preview.numbers.size); assertEquals(2,preview.entries); assertEquals(2,preview.importHints.size)
        }
        assertTrue(after.contactCard().notes.contains("A original notes"))
        assertTrue(after.contactCard().notes.contains("B original notes"))
    }

    @Test fun reviewOffersPlainMergeDecisionAndCleanupInOneExplicitSave() {
        val graph=seed()
        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            MyPeopleTheme { ReviewScreen(state.records,graph) {} }
        }
        compose.onNodeWithText("Decisions (1)").performClick()
        compose.onNodeWithText("Earlier keep-separate decision").assertIsDisplayed()
        compose.onNodeWithText("Review earlier decision").performClick()
        compose.onNodeWithText("These details belong to one person").performScrollTo().performClick()
        compose.onNodeWithText("Also remove 1 duplicate phone",substring=true).performScrollTo().assertIsDisplayed()
        compose.onNodeWithText("Keep this contact").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contact_conflicts.isEmpty() }
        val person=graph.store.state.value.records.people.values.single()
        assertEquals(1,person.contactFields().size)
        assertTrue(person.contactCard().notes.contains("A original notes"))
        assertTrue(person.contactCard().notes.contains("B original notes"))
        compose.onNodeWithText("Decisions").assertExists()
        runBlocking {
            val restarted=Store(File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir,"memory")); restarted.initialize()
            assertTrue(restarted.state.value.records.people.values.single().contact_conflicts.isEmpty())
            assertEquals(1,restarted.state.value.records.people.values.single().contactFields().size)
        }
    }

    @Test fun cleanupCanBeDeclinedThenRunFromTheContactWithoutAnotherAgentTask() {
        val graph=seed()
        var showContact by mutableStateOf(false)
        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            MyPeopleTheme {
                if (showContact) Column(Modifier.verticalScroll(rememberScrollState())) {
                    val person=state.records.people.entries.single()
                    ContactDetails(person.value,person.key,graph) {}
                } else ReviewScreen(state.records,graph) {}
            }
        }
        compose.onNodeWithText("Decisions (1)").performClick()
        compose.onNodeWithText("Review earlier decision").performClick()
        compose.onNodeWithText("These details belong to one person").performScrollTo().performClick()
        compose.onNodeWithText("Also remove 1 duplicate phone",substring=true).performScrollTo().assertIsOn().performClick().assertIsOff()
        compose.onNodeWithText("Keep this contact").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contact_conflicts.isEmpty() }
        assertEquals(2,graph.store.state.value.records.people.values.single().contactFields().size)
        compose.runOnIdle { showContact=true }
        compose.onNodeWithText("Remove 1 repeated entry").performScrollTo().performClick()
        compose.onNodeWithText("Remove repeated entries").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contactFields().size==1 }
        assertTrue(graph.store.state.value.records.people.values.single().contactCard().notes.contains("A original notes"))
        assertTrue(graph.store.state.value.records.people.values.single().contactCard().notes.contains("B original notes"))
    }

    @Test fun restoringSeparateRecordsIsAnExplicitAlternativeAndDoesNotCleanPhones() {
        val graph=seed()
        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            MyPeopleTheme { ReviewScreen(state.records,graph) {} }
        }
        compose.onNodeWithText("Decisions (1)").performClick()
        compose.onNodeWithText("Review earlier decision").performClick()
        compose.onNodeWithText("These details belong to different people").performScrollTo().performClick()
        compose.onNodeWithText("Also remove",substring=true).assertDoesNotExist()
        compose.onNodeWithText("Restore 2 separate records").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.size==2 }
        val people=graph.store.state.value.records.people.values
        assertEquals(setOf("Case A","Case B"),people.map { it.name }.toSet())
        assertTrue(people.all { it.contactFields().size==1 && it.contact_conflicts.isEmpty() })
    }
}
