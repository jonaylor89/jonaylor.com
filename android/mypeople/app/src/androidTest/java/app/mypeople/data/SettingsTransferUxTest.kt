package app.mypeople.data

import android.content.res.Configuration
import android.graphics.Bitmap
import androidx.compose.material3.Surface
import androidx.compose.runtime.*
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.AppGraph
import app.mypeople.MyPeopleApp
import app.mypeople.ui.*
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Synthetic render states only, guarded even though no store mutations are needed. */
@RunWith(AndroidJUnit4::class)
class SettingsTransferUxTest {
    @get:Rule val compose = createComposeRule()
    private lateinit var graph: AppGraph

    @Before fun disposableOnly() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true" && android.os.Build.HARDWARE in setOf("ranchu", "goldfish"))
        graph = (InstrumentationRegistry.getInstrumentation().targetContext.applicationContext as MyPeopleApp).graph
        graph.store.initialize()
        check(graph.store.state.value.records.people.isEmpty() && graph.store.state.value.pending.isEmpty()) { "Use a fresh disposable installation." }
    }

    private fun capture(name: String) {
        compose.waitForIdle()
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.waitForIdleSync()
        Thread.sleep(350) // Include native dialog/IME window transitions, not only Compose idleness.
        val file = File(instrumentation.targetContext.getExternalFilesDir(null), "settings-qa/$name.png")
        file.parentFile!!.mkdirs()
        instrumentation.uiAutomation.takeScreenshot().let { bitmap ->
            file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
            bitmap.recycle()
        }
    }

    @Test fun syncFirstAndInfrequentToolsDisclosedWithoutLosingSafeguards() {
        var state by mutableStateOf(StoreState(ready = true))
        var dark by mutableStateOf(false)
        compose.setContent {
            val config = Configuration(LocalConfiguration.current).apply { uiMode = if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO }
            CompositionLocalProvider(LocalConfiguration provides config) {
                MyPeopleTheme { Surface { SettingsScreen(graph, state, feedback = {}) } }
            }
        }
        compose.onNodeWithText("Scan Mac QR").assertIsDisplayed().assertIsEnabled()
        compose.onNodeWithText("On your terms").assertDoesNotExist()
        compose.onNodeWithText("Create encrypted phone backup").assertDoesNotExist()
        compose.onNodeWithText("Import memory file").assertDoesNotExist()
        capture("settings-light")
        compose.runOnIdle { dark = true }
        capture("settings-dark")
        compose.onNodeWithText("Where do I find the QR?").performClick()
        compose.onNodeWithText("uv run --extra bluetooth mypeople transfer qr").assertIsDisplayed()
        capture("qr-help")
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Transfer files").performScrollTo().performClick()
        compose.onNodeWithText("Import memory file").performScrollTo().assertIsEnabled()
        compose.onNodeWithText("Share queued edits").performScrollTo().assertIsNotEnabled()
        compose.onNodeWithText("Transfer files").performScrollTo().performClick()
        compose.onNodeWithText("Import memory file").assertDoesNotExist()
        compose.onNodeWithText("Backup & restore").performScrollTo().performClick()
        compose.onNodeWithText("Restore encrypted phone backup").performScrollTo().assertIsEnabled()
        compose.runOnIdle { state = state.copy(pending = listOf(PendingOp("synthetic", "rename", JsonObject(emptyMap())))) }
        compose.onNodeWithText("Restore encrypted phone backup").assertIsNotEnabled()
        compose.onNodeWithText("Create encrypted phone backup").assertIsEnabled()
        capture("backup-queued")
        compose.onNodeWithText("Create encrypted phone backup").performClick()
        compose.onNodeWithText("Choose destination").assertIsNotEnabled()
        compose.onNodeWithText("Backup passphrase").performScrollTo().performTextInput("synthetic-passphrase")
        compose.onNodeWithText("Choose destination").assertIsEnabled()
        capture("backup-keyboard")
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { state = state.copy(ready = false, lastError = "Couldn’t open saved memory. Try again.") }
        compose.onNodeWithText("Retry opening memory").performScrollTo().assertIsEnabled()
        compose.onNodeWithText("Scan Mac QR").assertIsNotEnabled()
        capture("settings-error")
    }

    @Test fun scannerKeepsHelpAndCancelReachable() {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.uiAutomation.executeShellCommand("pm grant ${instrumentation.targetContext.packageName} android.permission.CAMERA").use { descriptor ->
            android.os.ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes() }
        }
        var cancelled = false
        var cameraError = false
        compose.setContent { MyPeopleTheme {
            QrCamera(onScanned = { error("The emulator scene must not contain a transfer QR") }, onClose = { cancelled = true }, onError = { cameraError = true })
        } }
        compose.onNodeWithText("Scan Mac QR").assertIsDisplayed()
        compose.waitUntil(20_000) { cameraError || compose.onAllNodesWithText("Opening camera…").fetchSemanticsNodes().isEmpty() }
        compose.runOnIdle { assertFalse(cameraError) }
        capture("qr-scanner")
        compose.onNodeWithText("Where do I find the QR?").performClick()
        compose.onNodeWithText("Open a QR on your Mac").assertIsDisplayed()
        compose.onNodeWithText("Done").performClick()
        compose.onNodeWithText("Open a QR on your Mac").assertDoesNotExist()
        compose.onNodeWithText("Cancel").assertIsDisplayed().performClick()
        compose.runOnIdle { assertTrue(cancelled); assertFalse(cameraError) }
    }

    @Test fun currentAndLegacyQrConfirmationAndEveryTransferPhase() {
        var version by mutableIntStateOf(3)
        var foreign by mutableStateOf(false)
        var receiving by mutableStateOf(false)
        var progress by mutableStateOf(BluetoothProgress(BluetoothPhase.CONNECTING))
        var confirmed = 0
        var cancelled = 0
        var permissionError by mutableStateOf<String?>(null)
        var permissionsOpened = false
        compose.setContent { MyPeopleTheme {
            SyncConfirmation("QA Mac", version, 2, foreign, receiving, progress, { confirmed++ }, { cancelled++ }, error = permissionError, onPermissions = if (permissionError != null) ({ permissionsOpened = true }) else null)
        } }
        compose.onNodeWithText("Sync with Mac").assertIsEnabled().performClick()
        compose.runOnIdle { assertEquals(1, confirmed); foreign = true }
        compose.onNodeWithText("Sync with Mac").assertIsNotEnabled()
        capture("qr-foreign-queue")
        compose.runOnIdle { foreign = false; permissionError = "Nearby devices access is needed." }
        compose.onNodeWithText("App permissions").performScrollTo().performClick()
        compose.runOnIdle { assertTrue(permissionsOpened) }
        capture("qr-permission-denied")
        compose.runOnIdle { permissionError = null; version = 1 }
        compose.onNodeWithText("Receive memory").assertIsEnabled()
        compose.onNodeWithText("This older QR", substring = true).assertExists()
        compose.runOnIdle { version = 3 }
        capture("qr-confirmation")
        for (phase in BluetoothPhase.entries) {
            compose.runOnIdle { receiving = true; progress = BluetoothProgress(phase, 1, 2) }
            compose.onNodeWithText("Sync with Mac").assertDoesNotExist()
            val button = compose.onNodeWithText("Cancel transfer")
            if (phase in setOf(BluetoothPhase.IMPORTING, BluetoothPhase.CONFIRMING)) button.assertIsNotEnabled()
            else button.assertIsEnabled()
            capture("qr-${phase.name.lowercase()}")
        }
        compose.runOnIdle { receiving = false }
        compose.onNodeWithText("Cancel").performClick()
        compose.runOnIdle { assertEquals(1, cancelled) }
    }
}
