package app.mypeople.data

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.*
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/** Explicit synthetic archive opt-in. Never accepts a personal-device target. */
@RunWith(AndroidJUnit4::class)
class GraphLargeImportTest {
    @Test fun allMessagesSurviveImportAndEdit() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("myPeopleDisposable") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish")) { "Load QA requires a disposable emulator." }
        assumeTrue(args.getString("myPeopleSyntheticGraph") != null)
        val archive = requireNotNull(args.getString("myPeopleSyntheticGraph"))
        check(archive.startsWith("/data/local/tmp/mypeople-synthetic-")) { "Only an explicitly synthetic load fixture is accepted." }
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "synthetic-large-graph-qa")
        check(!directory.exists()) { "Use a fresh synthetic load directory." }
        val started = System.nanoTime()
        val manifest = Transfer.unpack(Transfer.decrypt(File(archive).readBytes(), "synthetic-load-passphrase"))
        val store = Store(directory)
        store.initialize()
        store.installOffline(manifest)
        val loaded = (System.nanoTime() - started) / 1_000_000
        assertEquals(2600, store.state.value.records.people.size)
        assertEquals(329000, store.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
        val target = store.state.value.records.people.entries.first()
        val editStart = System.nanoTime()
        store.saveContact(target.value.contactCard().copy(favorite = true), target.key)
        val edit = (System.nanoTime() - editStart) / 1_000_000
        assertTrue(store.state.value.records.people.getValue(target.key).contactCard().favorite)
        assertEquals(manifest.graph!!.blobs, store.snapshot().graph!!.bundle.blobs)
        println("Synthetic graph 2600 people / 329000 messages: import=${loaded}ms edit=${edit}ms maxHeap=${Runtime.getRuntime().maxMemory()}")
    }

    @Test fun encryptedBackupRetainsCompleteLoadedBook() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("myPeopleDisposable") == "true" && args.getString("myPeopleGraphBackupOnly") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val store = Store(File(context.cacheDir, "synthetic-large-graph-qa"))
        store.initialize()
        val bytes = BackupArchive.encode(ContactBackup(state = store.snapshot()), emptyMap(), "synthetic-load-backup-passphrase")
        File(context.cacheDir, "synthetic-large-graph-backup.sherloq").writeBytes(bytes)
        assertTrue(bytes.isNotEmpty())
    }

    @Test fun freshProcessRestoresCompleteEncryptedBackup() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("myPeopleDisposable") == "true" && args.getString("myPeopleGraphRestoreOnly") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val file = File(context.cacheDir, "synthetic-large-graph-backup.sherloq")
        val backup = BackupArchive.decode(file.readBytes(), "synthetic-load-backup-passphrase").first
        val destination = File(context.cacheDir, "synthetic-large-restored-graph-qa")
        check(!destination.exists())
        val restored = Store(destination)
        restored.initialize()
        restored.restoreBackup(backup.state)
        assertEquals(2600, restored.state.value.records.people.size)
        assertEquals(329000, restored.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
        assertTrue(restored.state.value.records.people.values.any { it.contactCard().favorite })
    }

    /** Run in a second instrumentation process, not with two full books pinned in one heap. */
    @Test fun restartedProcessRetainsAllMessagesAndEdit() = runBlocking {
        val args = InstrumentationRegistry.getArguments()
        assumeTrue(args.getString("myPeopleDisposable") == "true" && args.getString("myPeopleGraphRestartOnly") == "true")
        check(Build.HARDWARE in setOf("ranchu", "goldfish"))
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        val directory = File(context.cacheDir, "synthetic-large-graph-qa")
        check(directory.isDirectory)
        val store = Store(directory)
        store.initialize()
        assertEquals(2600, store.state.value.records.people.size)
        assertEquals(329000, store.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
        assertTrue(store.state.value.records.people.values.any { it.contactCard().favorite })
        assertTrue(store.snapshot().graph!!.bundle.blobs.isNotEmpty())
    }
}
