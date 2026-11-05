package app.mypeople.data

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File

/** Opt-in local diagnostic replay on PRIVATE COPIES only. Never logs contact data or keys.
 * Set MYPEOPLE_SYNC_DIAGNOSTICS to a private directory with phone/{store.bin,store.journal}
 * and peer.json. The export feeds the Python replay; reply.sherloq tests the return import.
 */
class PrivateBluetoothSyncTest {
    private val fullJson = Json(json) { encodeDefaults = true }
    private fun root(): File {
        val path = System.getenv("MYPEOPLE_SYNC_DIAGNOSTICS")
        assumeTrue(!path.isNullOrBlank())
        return File(path!!)
    }
    @Test fun exportPrivatePhoneEdits() = runBlocking {
        val root = root(); val peer = json.parseToJsonElement(File(root, "peer.json").readText()).jsonObject
        val store = Store(File(root, "phone")); store.initialize()
        val photos = File(root, "photo-hashes.txt").takeIf { it.exists() }?.readLines().orEmpty().filter { Regex("[a-f0-9]{64}").matches(it) }
        val manifest = store.bluetoothEdits(peer.text("source"), peer.text("publisher")).copy(photo_hashes = photos)
        File(root, "phone-edits.json").writeText(fullJson.encodeToString(TransferManifest.serializer(), manifest))
        println("Private diagnostic: people=${store.state.value.records.people.size}; queued=${manifest.ops.size}; kinds=${manifest.ops.groupingBy { it.kind }.eachCount()}; replicated=${store.state.value.replicatedContacts}; sameCollection=${store.state.value.offlineSource == peer.text("source")}")
    }
    @Test fun importPrivateMacReply() = runBlocking {
        val root = root(); val reply = File(root, "reply.sherloq"); assumeTrue(reply.exists())
        val password = File(System.getProperty("user.home"), ".mypeople/transfer.key").readText().trimEnd('\r', '\n')
        val store = Store(File(root, "phone")); store.initialize()
        val before = store.snapshot()
        var stage = "decode"
        try {
            val snapshot = Transfer.unpack(Transfer.decrypt(reply.readBytes(), password))
            stage = "install"
            store.installOffline(snapshot)
            File(root, "reply-result.txt").writeText("success; remaining=${store.state.value.pending.size}; failed=${store.state.value.failedEdits.size}; replicated=${store.state.value.replicatedContacts}")
            println("Private reply replay succeeded: remaining=${store.state.value.pending.size}; failed=${store.state.value.failedEdits.size}; replicated=${store.state.value.replicatedContacts}")
        } catch (e: Exception) {
            File(root, "reply-result.txt").writeText("$stage: ${e.javaClass.name}: ${e.message}")
            assertTrue("Rejected reply must leave queued edits intact", before.pending == store.snapshot().pending)
            throw AssertionError("Private reply replay failed at $stage (${e.javaClass.simpleName}); details kept in private diagnostic file")
        }
    }
}
