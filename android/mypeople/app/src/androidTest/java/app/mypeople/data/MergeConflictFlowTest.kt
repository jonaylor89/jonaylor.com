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
    private fun seed() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val graph = (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty()) { "Use an empty disposable store" }
        graph.settings.contactsEnabled = false
        val a=UUID.randomUUID().toString(); val b=UUID.randomUUID().toString()
        var base=GraphStore(GraphStore.empty()).saveCard(a,ContactCard("Case A",region="GB",notes="A original notes",fields=listOf(ContactField("phone","02079460018","Mobile"))))
        base=GraphStore(base).saveCard(b,ContactCard("Case B",region="GB",notes="B original notes",fields=listOf(ContactField("phone","+442079460018","Mobile"))))
        val separate=GraphStore(base).commit(listOf(VersionedGraph.createEdge("distinct_person",a,b)))
        val merge=GraphStore(base).commit(listOf(VersionedGraph.createEdge("same_person",a,b,buildJsonObject { put("preferred_person",a) })))
        val joined=GraphStore(separate).receive(merge.bundle)
        graph.store.installOffline(TransferManifest(type="snapshot",source=joined.bundle.collection,revision=1,graph=joined.bundle))
        graph
    }

    @Test fun reviewOffersPlainMergeDecisionAndCleanupInOneExplicitSave() {
        val graph=seed()
        compose.setContent {
            val state by graph.store.state.collectAsStateWithLifecycle()
            MyPeopleTheme { ReviewScreen(state.records,graph) {} }
        }
        compose.onNodeWithText("Conflicts (1)").performClick()
        compose.onNodeWithText("Merged records also marked as different people").assertIsDisplayed()
        compose.onNodeWithText("Resolve merge decision").performClick()
        compose.onNodeWithText("Keep one merged contact").performClick()
        compose.onNodeWithText("Also remove 1 duplicate phone",substring=true).assertIsDisplayed()
        compose.onNodeWithText("Keep merged contact").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contact_conflicts.isEmpty() }
        val person=graph.store.state.value.records.people.values.single()
        assertEquals(1,person.contactFields().size)
        assertTrue(person.contactCard().notes.contains("A original notes"))
        assertTrue(person.contactCard().notes.contains("B original notes"))
        compose.onNodeWithText("Conflicts").assertExists()
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
        compose.onNodeWithText("Conflicts (1)").performClick()
        compose.onNodeWithText("Resolve merge decision").performClick()
        compose.onNodeWithText("Keep one merged contact").performClick()
        compose.onNodeWithText("Also remove 1 duplicate phone",substring=true).assertIsOn().performClick().assertIsOff()
        compose.onNodeWithText("Keep merged contact").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.values.single().contact_conflicts.isEmpty() }
        assertEquals(2,graph.store.state.value.records.people.values.single().contactFields().size)
        compose.runOnIdle { showContact=true }
        compose.onNodeWithText("Remove 1 duplicate phone field").performScrollTo().performClick()
        compose.onNodeWithText("Remove duplicates").performClick()
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
        compose.onNodeWithText("Conflicts (1)").performClick()
        compose.onNodeWithText("Resolve merge decision").performClick()
        compose.onNodeWithText("Restore 2 separate contact records").performClick()
        compose.onNodeWithText("Also remove",substring=true).assertDoesNotExist()
        compose.onNodeWithText("Restore separate records").performClick()
        compose.waitUntil(5000) { graph.store.state.value.records.people.size==2 }
        val people=graph.store.state.value.records.people.values
        assertEquals(setOf("Case A","Case B"),people.map { it.name }.toSet())
        assertTrue(people.all { it.contactFields().size==1 && it.contact_conflicts.isEmpty() })
    }
}
