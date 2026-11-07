package app.mypeople.data

import android.os.Build
import android.os.Looper
import androidx.compose.runtime.*
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import app.mypeople.ui.MyPeopleTheme
import app.mypeople.ui.PersonScreen
import java.io.File
import java.util.UUID
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Only an isolated synthetic index on a disposable emulator; never a personal installation. */
@RunWith(AndroidJUnit4::class)
class ContactDetailIndexTest {
    @get:Rule val compose = createComposeRule()

    @Test fun detailsReadOnlyTheirOwnerOffMainThreadAndRefreshWithoutBookScans() {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val graph = (context.applicationContext as MyPeopleApp).graph
        val directory = File(context.cacheDir, "synthetic-contact-detail-${UUID.randomUUID()}").apply { mkdirs() }
        val delegate = AndroidGraphSql(File(directory, "graph.sqlite"))
        val reads = AtomicInteger()
        val armed = AtomicBoolean(false)
        val traced = object : GraphSql by delegate {
            override fun query(sql: String, args: List<Any?>): List<List<String?>> {
                if (armed.get() && "FROM screen" in sql) {
                    check(Looper.myLooper() != Looper.getMainLooper()) { "Contact detail SQL ran on main thread" }
                    check("owner=?" in sql) { "Contact detail scanned other owners" }
                    reads.incrementAndGet()
                }
                return delegate.query(sql, args)
            }
        }
        val db = IndexedGraphDatabase(traced, File(directory, "blobs"))
        db.transaction {
            val event = json.encodeToString(Event(100, "note", "Unrelated synthetic note"))
            val profile = json.encodeToString(Profile(100, "test", "https://example.test/unrelated"))
            repeat(20000) { i ->
                insert(db, "event", "noise-$i", 100, event)
                insert(db, "profile", "noise-$i", 100, profile)
            }
            insert(db, "event", "selected-note", 42, json.encodeToString(Event(42, "note", "Selected person's note")))
            insert(db, "event", "other-note", 43, json.encodeToString(Event(43, "note", "Other person's note")))
            insert(db, "profile", "selected-link", 42, json.encodeToString(Profile(42, "Selected site", "https://example.test/selected", status = "confirmed")))
        }
        val people = mapOf(42 to Person("Selected QA", card = ContactCard("Selected QA")), 43 to Person("Other QA", card = ContactCard("Other QA")))
        var records by mutableStateOf(Records(people = people, events = db.viewMap("view", "event", 1), profiles = db.viewMap("view", "profile", 1)), referentialEqualityPolicy())
        var selected by mutableIntStateOf(42)
        var show by mutableStateOf(true)
        armed.set(true)
        val start = System.nanoTime()
        compose.setContent { MyPeopleTheme { if (show) PersonScreen(selected, StoreState(records = records, ready = true), graph) {} } }
        fun awaitNote(note: String) {
            compose.onNodeWithTag("person-list").performScrollToNode(hasText("Notes and facts"))
            compose.waitUntil(5000) { compose.onAllNodesWithText(note).fetchSemanticsNodes().isNotEmpty() }
            compose.onNodeWithTag("person-list").performScrollToNode(hasText(note))
            compose.onNodeWithText(note).assertIsDisplayed()
        }
        compose.onNodeWithText("Selected QA").assertIsDisplayed()
        awaitNote("Selected person's note")
        compose.onNodeWithTag("person-list").performScrollToNode(hasText("Selected site"))
        compose.onNodeWithText("Selected site").assertIsDisplayed()
        assertTrue("Must read only a bounded owner slice", reads.get() in 2..6)
        println("Synthetic 40003-row contact page including Compose/scroll assertions: ${(System.nanoTime() - start) / 1000000}ms; owner queries=${reads.get()}")

        // A committed new version refreshes the same person without comparing lazy maps.
        db.transaction {
            db.sql.execute("UPDATE screen SET died=2 WHERE kind='event' AND id='selected-note'")
            insert(db, "event", "selected-note", 42, json.encodeToString(Event(42, "note", "Updated person's note")), born = 2)
        }
        compose.runOnIdle { records = records.copy(events = db.viewMap("view", "event", 2), profiles = db.viewMap("view", "profile", 2)) }
        awaitNote("Updated person's note")
        compose.onNodeWithText("Selected person's note").assertDoesNotExist()

        // Different Records object and different owner must invalidate safely without Map.equals scans.
        compose.runOnIdle { records = records.copy(events = db.viewMap("view", "event", 2), profiles = db.viewMap("view", "profile", 2)); selected = 43 }
        awaitNote("Other person's note")
        compose.onNodeWithText("Selected person's note").assertDoesNotExist()
        compose.onNodeWithText("Selected site").assertDoesNotExist()
        assertTrue(reads.get() <= 18)
        compose.runOnIdle { show = false }
        compose.waitForIdle()
        db.close()
        directory.deleteRecursively()
    }

    private fun insert(db: IndexedGraphDatabase, kind: String, id: String, owner: Int, data: String, born: Int = 1) {
        db.sql.execute("INSERT INTO screen(scope,kind,id,owner,data,born) VALUES ('view',?,?,?,?,?)", listOf(kind, id, owner, data, born))
    }
}
