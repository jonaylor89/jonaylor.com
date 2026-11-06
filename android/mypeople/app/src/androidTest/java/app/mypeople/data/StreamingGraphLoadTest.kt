package app.mypeople.data

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** No synthetic large-book tests may run on a personal phone. */
@RunWith(AndroidJUnit4::class)
class StreamingGraphLoadTest {
    private val password = "synthetic-streaming-load-passphrase"
    private fun context() = InstrumentationRegistry.getInstrumentation().targetContext
    private fun guard(flag: String? = null) {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        if (flag != null) assumeTrue(args.getString(flag) == "true")
    }
    @Test fun importEditAndVerifyAll272MiB() = runBlocking {
        guard()
        val path = InstrumentationRegistry.getArguments().getString("myPeopleStreamingSynthetic")
        assumeTrue(path != null)
        check(path!!.startsWith("/data/local/tmp/mypeople-synthetic-"))
        val directory = File(context().cacheDir, "streaming-graph-qa")
        check(!directory.exists())
        val start = System.nanoTime()
        val memory = LargeArchive.read(File(path), password, context().cacheDir, File(directory, "graph-blobs")).memory!!
        val store = Store(directory)
        store.installOffline(memory)
        val loaded = (System.nanoTime() - start) / 1_000_000
        assertEquals(8, store.snapshot().graph!!.bundle.blobs.size)
        assertEquals(272L * 1024 * 1024, File(directory, "graph-blobs").listFiles()!!.sumOf { it.length() })
        // Even an original asset larger than the old card-size limit is kept
        // as a hash; an unrelated favorite edit must not read/Base64 the asset.
        val gs = GraphStore(store.snapshot().graph!!)
        val uid = store.state.value.records.people.values.single().contact_uid
        val hash = gs.state.bundle.blobs.keys.first()
        val asset = VersionedGraph.createObject("Asset", buildJsonObject { put("role", "contact_photo"); put("content", buildJsonObject { put("blob_hash", hash) }) })
        val next = gs.commit(listOf(asset, VersionedGraph.createEdge("has_asset", uid, asset.target)))
        store.installOffline(memory.copy(graph = next.bundle, revision = memory.revision + 1))
        val person = store.state.value.records.people.entries.single()
        assertEquals(hash, person.value.contactCard().photo_hash)
        assertEquals("", person.value.contactCard().photo)
        val editStart = System.nanoTime()
        store.saveContact(person.value.contactCard().copy(favorite = true), person.key)
        val edit = (System.nanoTime() - editStart) / 1_000_000
        assertTrue(edit < 250)
        assertTrue(File(directory, "store.bin").length() < 2 * 1024 * 1024)
        for (key in store.snapshot().graph!!.bundle.blobs.keys) {
            assertEquals(key, GraphBlobs.open(store.snapshot().graph!!.bundle.blobs, key).use(GraphBlobs::verifiedHash))
        }
        println("Synthetic streamed 272MiB: import=${loaded}ms edit=${edit}ms maxHeap=${Runtime.getRuntime().maxMemory()}")
    }
    @Test fun restartedProcessKeepsLargeGraphAndPhotoReference() = runBlocking {
        guard("myPeopleStreamingRestart")
        val store = Store(File(context().cacheDir, "streaming-graph-qa")); store.initialize()
        val card = store.state.value.records.people.values.single().contactCard()
        assertTrue(card.favorite); assertTrue(card.photo_hash.isNotEmpty()); assertTrue(card.photo.isEmpty())
        assertEquals(8, store.snapshot().graph!!.bundle.blobs.size)
    }
    @Test fun encryptedFileBackupKeepsAllBlobBytes() = runBlocking {
        guard("myPeopleStreamingBackup")
        val directory = File(context().cacheDir, "streaming-graph-qa")
        val store = Store(directory); store.initialize()
        File(context().cacheDir, "synthetic-stream-backup.sherloq").outputStream().use {
            LargeArchive.writeBackup(ContactBackup(state = store.snapshot()), emptyMap(), it, password, context().cacheDir, File(directory, "graph-blobs"))
        }
    }
    @Test fun freshProcessRestoresCompleteEncryptedFileBackup() = runBlocking {
        guard("myPeopleStreamingRestore")
        val directory = File(context().cacheDir, "streaming-graph-restored-qa")
        check(!directory.exists())
        val archive = LargeArchive.read(File(context().cacheDir, "synthetic-stream-backup.sherloq"), password, context().cacheDir, File(directory, "graph-blobs")).backup!!
        val store = Store(directory); store.restoreBackup(archive.state)
        assertEquals(8, store.snapshot().graph!!.bundle.blobs.size)
        assertEquals(272L * 1024 * 1024, File(directory, "graph-blobs").listFiles()!!.sumOf { it.length() })
        assertTrue(store.state.value.records.people.values.single().contactCard().favorite)
    }
}
