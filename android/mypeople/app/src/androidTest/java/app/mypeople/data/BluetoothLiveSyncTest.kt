package app.mypeople.data

import android.Manifest
import android.content.pm.PackageManager
import androidx.core.content.ContextCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import app.mypeople.MyPeopleApp
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File

/** Explicit opt-in verification of a USER-REQUESTED live sync, not a synthetic/destructive test.
 * Requires myPeopleLiveSync=true plus the current QR in app-private live-sync-offer.json.
 * Credentials never go through instrumentation arguments, intents, logs, or public storage.
 * Uses normal BluetoothMemory/Store paths; never clears data or changes contacts itself.
 */
@RunWith(AndroidJUnit4::class)
class BluetoothLiveSyncTest {
    @Test fun pairedLiveSyncCompletesWithDigestAcknowledgment() = runBlocking {
        assumeTrue(InstrumentationRegistry.getArguments().getString("myPeopleLiveSync") == "true")
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.filesDir, "live-sync-offer.json")
        check(file.isFile) { "Provide the private current offer explicitly." }
        var phase = "preflight"
        try {
            val offer = BluetoothOffer.parse(file.readText())
            val graph = (context.applicationContext as MyPeopleApp).graph
            graph.store.initialize()
            check(graph.store.state.value.offlineSource == offer.source) { "Live verification is restricted to the already-paired collection." }
            check(android.os.Build.VERSION.SDK_INT < 31 || ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED) { "Approve Nearby devices access normally first." }
            val queued = graph.store.state.value.pending.size
            val result = graph.bluetooth.sync(offer) { next ->
                if (phase != next.phase.name) { phase = next.phase.name; println("Live Bluetooth phase: $phase") }
            }
            assertTrue(result.bidirectional)
            assertTrue("The Mac must confirm the exact imported snapshot digest", result.peerConfirmed)
            assertEquals(offer.source, graph.store.state.value.offlineSource)
            assertTrue("Replicated contact history must be active", graph.store.state.value.replicatedContacts)
            println("Live sync verified: queuedBefore=$queued; remaining=${graph.store.state.value.pending.size}; replicated=${graph.store.state.value.replicatedContacts}; peerConfirmed=${result.peerConfirmed}")
            Unit
        } catch (error: Exception) {
            File(context.filesDir, "live-sync-failure.txt").writeText("$phase: ${error.javaClass.name}: ${error.message}")
            throw AssertionError("Live sync failed during $phase; detailed error kept app-private")
        } finally {
            file.delete()
        }
    }
}
