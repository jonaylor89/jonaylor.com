package app.mypeople.data

import android.app.Application
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.AppGraph
import app.mypeople.MyPeopleApp
import kotlinx.coroutines.runBlocking
import java.io.File
import app.mypeople.ui.MyPeople
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Fresh disposable emulator only. Deliberately leaves the store unopened to test the first frame. */
@RunWith(AndroidJUnit4::class)
class StartupNavigationTest {
    @get:Rule val compose = createComposeRule()
    @Test fun navigationAndSearchExistBeforeDiskLoadAndNavigationSurvivesCompletion() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val original = (context.applicationContext as MyPeopleApp).graph
        runBlocking { original.store.initialize() }
        check(original.store.state.value.records.people.isEmpty() && original.store.state.value.pending.isEmpty()) { "Use a fresh disposable emulator." }
        val synthetic = DiskState(records = Records(
            people = (1..3000).associateWith { Person("Person $it") },
            events = (1..7000).associate { it.toString() to Event(it % 3000 + 1, "job", "Synthetic event $it") }))
        val directory = File(context.filesDir, "memory").apply { mkdirs() }
        val binary = File(directory, "store.bin")
        val bytes = StoreCheckpoint.encode(synthetic)
        binary.writeBytes(bytes)
        StartupIndex(directory).save(synthetic.records)
        // A valid last-known read-only index must not turn corrupt authority into edit permission.
        binary.writeBytes(bytes.copyOf().also { it[20] = (it[20].toInt() xor 1).toByte() })
        val graph = AppGraph(context.applicationContext as Application, startMemoryImmediately = false)
        check(!graph.settings.configured && !graph.settings.contactsEnabled) { "Use a fresh disposable emulator." }
        assertFalse(graph.store.state.value.ready)
        compose.setContent { MyPeople(graph) }
        compose.onNodeWithContentDescription("Search people").assertIsDisplayed()
        compose.onNodeWithText("Opening your memory…").assertDoesNotExist()
        compose.onNodeWithText("No one found").assertDoesNotExist()
        compose.onNodeWithTag("nav-settings").assertIsEnabled().performClick()
        compose.onNodeWithText("Sync & storage").performScrollTo().assertIsDisplayed()
        assertFalse(graph.store.state.value.ready)
        graph.openMemory()
        compose.waitUntil(5000) { graph.store.state.value.lastError != null }
        assertFalse(graph.store.state.value.ready)
        compose.onNodeWithTag("nav-people").performClick()
        compose.onNodeWithText("Person 1").assertIsDisplayed()
        compose.onNodeWithContentDescription("Create contact").assertIsNotEnabled()
        compose.onNodeWithTag("nav-settings").performClick()
        binary.writeBytes(bytes)
        graph.openMemory()
        compose.waitUntil(5000) { graph.store.state.value.ready }
        assertEquals(3000, graph.store.state.value.records.people.size)
        assertEquals(7000, graph.store.state.value.records.events.size)
        compose.onNodeWithTag("settings-scroll").assertIsDisplayed() // do not reset the nav graph when ready changes
        compose.onNodeWithTag("nav-people").performClick()
        compose.onNodeWithContentDescription("Search people").assertIsDisplayed()
    }
}
