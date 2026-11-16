package app.mypeople.data

import android.graphics.Bitmap
import android.graphics.Color
import android.os.Build
import androidx.compose.runtime.*
import androidx.compose.ui.graphics.asAndroidBitmap
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.*
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import app.mypeople.ui.MyPeopleTheme
import app.mypeople.ui.PersonScreen
import java.io.ByteArrayOutputStream
import java.io.File
import java.util.Base64
import java.util.UUID
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Never seeds or opens a personal installation; explicit fresh-emulator opt-in only. */
@RunWith(AndroidJUnit4::class)
class PhotoChooserFlowTest {
    @get:Rule val compose = createComposeRule()

    @Test fun selectCancelAutomaticAndLargeTextWorkOffline() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val app = (context.applicationContext as MyPeopleApp).graph
        app.store.initialize()
        check(app.store.state.value.records.people.isEmpty()) { "Use a fresh disposable app store." }
        check(!app.settings.contactsEnabled) { "Use a disposable installation with Contacts integration off." }
        val uid = UUID.randomUUID().toString()
        var state = GraphStore(GraphStore.empty()).saveCard(uid, ContactCard("Synthetic Photo Person"))
        for ((source, color) in listOf("groupme" to Color.rgb(45, 115, 90), "whatsapp" to Color.rgb(170, 100, 65))) {
            val bitmap = Bitmap.createBitmap(128, 128, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(color)
            val bytes = ByteArrayOutputStream().also { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }.toByteArray()
            bitmap.recycle()
            val hash = GraphStore.digest(bytes)
            val asset = VersionedGraph.createObject("Asset", buildJsonObject {
                put("role", "profile_photo"); put("source", source); put("source_identity", "synthetic-user")
                put("width", 128); put("height", 128); put("content", buildJsonObject { put("blob_hash", hash) })
            })
            state = GraphStore(state).commit(listOf(asset, VersionedGraph.createEdge("has_asset", uid, asset.target)), mapOf(hash to Base64.getEncoder().encodeToString(bytes)))
        }
        app.store.installOffline(TransferManifest(type = "snapshot", source = state.bundle.collection, revision = 1, graph = state.bundle))
        val id = app.store.state.value.records.people.keys.single()
        var largeText by mutableStateOf(false)
        compose.setContent {
            val current by app.store.state.collectAsStateWithLifecycle()
            val density = LocalDensity.current
            CompositionLocalProvider(LocalDensity provides Density(density.density, if (largeText) 2f else 1f)) {
                MyPeopleTheme { PersonScreen(id, current, app) {} }
            }
        }
        compose.onNodeWithTag("contact-photos").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithContentDescription("GroupMe photo").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Add photo").performClick()
        compose.onNodeWithText("Take photo").assertIsDisplayed()
        compose.onNodeWithText("Choose photo").assertIsDisplayed()
        androidx.test.espresso.Espresso.pressBack()
        compose.onNodeWithContentDescription("GroupMe photo").performClick()
        compose.onNodeWithText("Save").assertIsDisplayed().performClick()
        compose.waitUntil(5000) { runBlocking { app.store.photoChoices(uid).preferred.isNotEmpty() } }
        val preferred = app.store.photoChoices(uid).preferred
        assertEquals("groupme", app.store.photoChoices(uid).candidates.single { it.id == preferred }.source)
        compose.onNodeWithTag("contact-photos").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("Automatic").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Automatic").performClick()
        compose.onNodeWithText("Cancel").performClick()
        compose.waitForIdle()
        assertEquals(preferred, app.store.photoChoices(uid).preferred)
        compose.runOnIdle { largeText = true }
        compose.onNodeWithTag("contact-photos").performClick()
        compose.waitUntil(5000) { compose.onAllNodesWithText("Automatic").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Automatic").performScrollTo().performClick()
        compose.onNodeWithText("Save").assertIsDisplayed()
        val screenshot = compose.onNodeWithText("Save").onParent().onParent().captureToImage().asAndroidBitmap()
        File(context.cacheDir, "photo-chooser-large.png").outputStream().use { screenshot.compress(Bitmap.CompressFormat.PNG, 100, it) }
        screenshot.recycle()
        compose.onNodeWithText("Save").performClick()
        compose.waitUntil(5000) { runBlocking { app.store.photoChoices(uid).automatic } }
        assertEquals(2, app.store.photoChoices(uid).candidates.size)
        val directory = File(context.filesDir, "memory")
        val heads = app.store.snapshot().graph!!.bundle.heads
        // Simulate an old APK's stale materialized avatar. Upgrade must rebuild
        // it without a domain commit or requiring another sync/import.
        val expectedHash = app.store.state.value.records.people.getValue(id).photo
        val oldHash = app.store.photoChoices(uid).candidates.first { it.hash != expectedHash }.hash
        IndexedGraphFiles.open(directory).use { database ->
            database.transaction {
                val disk = database.readState()
                val old = database.readRecords("view")
                val stale = old.copy(people = old.people.mapValues { (_, p) -> p.copy(photo = oldHash, card = p.contactCard().copy(photo_hash = oldHash)) })
                database.save(disk, disk, stale, old)
                database.putMeta("photo_policy", "0")
            }
        }
        val restarted = Store(directory)
        restarted.initialize()
        assertTrue(restarted.photoChoices(uid).automatic)
        assertEquals(2, restarted.photoChoices(uid).candidates.size)
        assertEquals(expectedHash, restarted.state.value.records.people.getValue(id).photo)
        assertEquals(heads, restarted.snapshot().graph!!.bundle.heads)
    }
}
