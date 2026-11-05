package app.mypeople.data

import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.StateRestorationTester
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.AppGraph
import app.mypeople.MyPeopleApp
import app.mypeople.ui.PeopleScreen
import app.mypeople.ui.MyPeople
import app.mypeople.ui.MyPeopleTheme
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.encodeToJsonElement
import org.junit.After
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.time.LocalDate

/** Opt-in: -e myPeopleDisposable true. Never seed a personal phone or existing cache. */
@RunWith(AndroidJUnit4::class)
class PeopleNavigationTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var graph: AppGraph
    private var seeded = false
    private val firstName = "A Person 000"
    private val firstNumber = "+15550000000"
    private val lastNumber = "+15550000099"
    private fun records(): Records {
        val names = ('A'..'Z').flatMap { letter -> List(40) { "$letter Person ${it.toString().padStart(3, '0')}" } } + List(100) { "+1555${it.toString().padStart(7, '0')}" }
        return Records(people = names.mapIndexed { i, name -> i + 1 to Person(name) }.toMap())
    }
    @Before fun disposableOnly() = runBlocking {
        assumeTrue("Use an explicitly opted-in disposable emulator", InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        graph = (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        val disk = graph.store.snapshot()
        check(disk.records.people.isEmpty() && disk.pending.isEmpty() && !graph.settings.configured) { "Refusing to seed an existing installation." }
    }
    @After fun clearSyntheticCache() = runBlocking { if (seeded) graph.store.restoreBackup(DiskState()); Unit }

    private fun screenshot(name: String) {
        val file = java.io.File(InstrumentationRegistry.getInstrumentation().targetContext.cacheDir, name)
        file.outputStream().use { compose.onRoot().captureToImage().asAndroidBitmap().compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }

    @Test fun jumpButtonsLetterChooserAndScrubKeepSearchInReach() {
        compose.setContent { MyPeopleTheme { PeopleScreen(records(), graph) { } } }
        compose.onNodeWithText(firstName).assertIsDisplayed()
        screenshot("people-fast-scroll-top.png")
        compose.onNodeWithContentDescription("Jump to bottom").performClick()
        compose.onNodeWithText(lastNumber).assertIsDisplayed()
        compose.onNodeWithContentDescription("Search people").assertIsDisplayed()
        compose.onNodeWithContentDescription("Choose a letter").performClick()
        compose.onNodeWithTag("people-letter-grid").performScrollToIndex(25)
        compose.onNodeWithContentDescription("Jump to Z, 40 contacts").performClick()
        compose.onNodeWithText("Z Person 000").assertIsDisplayed()
        compose.onNodeWithTag("people-fast-scroll").performTouchInput {
            down(Offset(centerX, 1f))
            moveTo(Offset(centerX, height - 1f), delayMillis = 300)
            up()
        }
        compose.onNodeWithText(firstNumber).assertIsDisplayed()
        compose.onNodeWithTag("people-fast-scroll").performSemanticsAction(SemanticsActions.SetProgress) { it(12f) }
        compose.onNodeWithText("M Person 000").assertIsDisplayed()
        compose.onNodeWithContentDescription("Jump to top").performClick()
        compose.onNodeWithText(firstName).assertIsDisplayed()
        compose.onNodeWithContentDescription("Jump to bottom").performClick()
        compose.onNodeWithContentDescription("Search people").performTextInput("Z Person")
        compose.onNodeWithText("Z Person 000").assertIsDisplayed()
    }

    @Test fun largeTextKeepsLetterChooserAndJumpButtonsUsable() {
        compose.setContent {
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, 2f)) {
                MyPeopleTheme { PeopleScreen(records(), graph) { } }
            }
        }
        compose.onNodeWithText(firstName).assertIsDisplayed()
        compose.onNodeWithContentDescription("Jump to bottom").performClick()
        compose.onNodeWithText(lastNumber).assertIsDisplayed()
        compose.onNodeWithContentDescription("Search people").assertIsDisplayed()
        screenshot("people-fast-scroll-large-text.png")
        compose.onNodeWithContentDescription("Choose a letter").performClick()
        compose.onNodeWithTag("people-letter-grid").performScrollToIndex(25)
        compose.onNodeWithContentDescription("Jump to Z, 40 contacts").performClick()
        compose.onNodeWithText("Z Person 000").assertIsDisplayed()
    }

    @Test fun restoredPositionIsNotResetByAnAlreadyConsumedDoubleTap() {
        val request = mutableLongStateOf(0)
        val restoration = StateRestorationTester(compose)
        restoration.setContent { MyPeopleTheme { PeopleScreen(records(), graph, scrollToTopRequest = request.longValue) { } } }
        compose.onNodeWithContentDescription("Jump to bottom").performClick()
        compose.onNodeWithText(lastNumber).assertIsDisplayed()
        compose.runOnIdle { request.longValue = 1 }
        compose.onNodeWithText(firstName).assertIsDisplayed()
        compose.onNodeWithContentDescription("Jump to bottom").performClick()
        restoration.emulateSavedInstanceStateRestore()
        compose.onNodeWithText(lastNumber).assertIsDisplayed()
        compose.runOnIdle { request.longValue = 2 }
        compose.onNodeWithText(firstName).assertIsDisplayed()
    }

    @Test fun singleTapRestoresAndDoubleTapReturnsEveryTabToTop() = runBlocking {
        val records = records()
        val today = LocalDate.now().toString()
        val changes = records.people.map { (id, person) -> RecordChange("person", id.toString(), json.encodeToJsonElement(person)) } +
            (1..60).map { RecordChange("event", it.toString(), json.encodeToJsonElement(Event(1, "job", "News $it", source = "imessage", said_at = today, created_at = today))) } +
            (1..60).map { RecordChange("profile", it.toString(), json.encodeToJsonElement(Profile(1, "example", "https://example.org/$it", title = "Profile $it"))) }
        seeded = true
        graph.settings.peopleFirst = true
        graph.store.receive(Changes(1, false, changes, emptyList()))
        compose.setContent { MyPeople(graph) }
        compose.onNodeWithText(firstName).assertIsDisplayed()
        screenshot("people-full-app-top.png")
        compose.onNodeWithContentDescription("Jump to bottom").performClick()
        screenshot("people-full-app-bottom.png")
        compose.onNodeWithText(lastNumber).assertIsDisplayed()
        compose.onNodeWithTag("nav-home").performClick()
        Thread.sleep(350)
        compose.onNodeWithTag("nav-people").performClick()
        compose.onNodeWithText(lastNumber).assertIsDisplayed()
        Thread.sleep(350)
        compose.onNodeWithTag("nav-people").performTouchInput { doubleClick() }
        compose.onNodeWithText(firstName).assertIsDisplayed()
        compose.onNodeWithText(firstName).performClick()
        compose.onNodeWithTag("nav-people").performTouchInput { doubleClick() }
        compose.onNodeWithText(firstName).assertIsDisplayed()
        compose.onNodeWithContentDescription("Search people").assertIsDisplayed()
        compose.onNodeWithTag("nav-home").performClick()
        compose.onNodeWithText("Feed").performClick()
        compose.onNodeWithTag("home-list").performScrollToIndex(40)
        compose.onNodeWithText("Keep people close.").assertIsNotDisplayed()
        compose.onNodeWithTag("nav-home").performTouchInput { doubleClick() }
        compose.onNodeWithText("Keep people close.").assertIsDisplayed()
        compose.onNodeWithTag("nav-review").performClick()
        compose.onNodeWithTag("review-list").performScrollToIndex(30)
        compose.onNodeWithText("A second look").assertIsNotDisplayed()
        compose.onNodeWithTag("nav-review").performTouchInput { doubleClick() }
        compose.onNodeWithText("A second look").assertIsDisplayed()
        // Settings sit behind the account button, not in the navigation bar.
        compose.onNodeWithTag("nav-settings").performClick()
        compose.onNodeWithText("MyPeople · a little memory goes a long way").performScrollTo()
        compose.onNodeWithText("On your terms").assertIsNotDisplayed()
        compose.onNodeWithContentDescription("Back").performClick()
        compose.onNodeWithTag("nav-settings").assertIsDisplayed()
        Unit
    }
}
