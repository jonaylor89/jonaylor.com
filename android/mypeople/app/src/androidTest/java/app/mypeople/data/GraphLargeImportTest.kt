package app.mypeople.data

import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
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
        val timings = mutableListOf<Pair<String, Long>>()
        val store = Store(directory, saveTiming = { stage, ms -> timings += stage to ms })
        store.initialize()
        store.installOffline(manifest)
        val loaded = (System.nanoTime() - started) / 1_000_000
        assertEquals(2600, store.state.value.records.people.size)
        assertEquals(329000, store.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
        val target = store.state.value.records.people.entries.first()
        val untouched = store.state.value.records.people.entries.last()
        val checkpoint = File(directory, "store.bin")
        val checkpointTime = checkpoint.lastModified()
        timings.clear()
        val editStart = System.nanoTime()
        store.saveContact(target.value.contactCard().copy(favorite = true), target.key)
        val edit = (System.nanoTime() - editStart) / 1_000_000
        println("Synthetic edit stages: $timings")
        assertTrue(store.state.value.records.people.getValue(target.key).contactCard().favorite)
        assertSame(untouched.value, store.state.value.records.people.getValue(untouched.key))
        assertEquals(checkpointTime, checkpoint.lastModified())
        assertTrue("Synthetic edit regressed to full-book latency: ${edit}ms", edit < 250)
        val repeated = (0 until 6).map { n ->
            val start = System.nanoTime()
            store.saveContact(store.state.value.records.people.getValue(target.key).contactCard().copy(favorite = n % 2 == 1), target.key)
            (System.nanoTime() - start) / 1_000_000
        }
        println("Synthetic repeated edits: ${repeated}ms journal=${File(directory, "store.journal").length()} bytes")
        assertTrue("Median edit must remain at least 10x below the prior ~750ms baseline", repeated.sorted()[repeated.size / 2] < 75)
        assertTrue("No edit should return to whole-book latency", repeated.all { it < 500 })
        assertEquals("Small edits must not trigger full-book checkpoints", checkpointTime, checkpoint.lastModified())
        assertTrue("Card edits must journal small deltas", File(directory, "store.journal").length() < 64 * 1024)
        for (kind in listOf("rename", "phone")) {
            val before = store.state.value.records.people.getValue(target.key).contactCard()
            val card = if (kind == "rename") before.copy(name = "Synthetic edited person")
                else before.copy(fields = before.fields + ContactField("phone", "+12025550199", "Synthetic"))
            val start = System.nanoTime()
            store.saveContact(card, target.key)
            val elapsed = (System.nanoTime() - start) / 1_000_000
            println("Synthetic identity edit $kind: ${elapsed}ms")
            assertTrue("Identity edit regressed: ${elapsed}ms", elapsed < 250)
        }
        for (kind in listOf("note", "rename")) {
            val start = System.nanoTime()
            store.enqueue(kind, buildJsonObject {
                put("person_id", target.key)
                put("contact_uid", target.value.contact_uid)
                put(if (kind == "note") "text" else "name", "Synthetic quick $kind")
            })
            val elapsed = (System.nanoTime() - start) / 1_000_000
            println("Synthetic quick action $kind: ${elapsed}ms")
            assertTrue("Quick action must reuse the current projection: ${elapsed}ms", elapsed < 250)
        }
        assertEquals(329000, store.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
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
        val start = System.nanoTime()
        val store = Store(directory)
        store.initialize()
        val ready = (System.nanoTime() - start) / 1_000_000
        assertNotNull("Editing must be ready without a lazy full reduction", store.snapshot().graph!!.bundle.reducer)
        assertTrue(store.snapshot().graph!!.bundle.blobsVerified)
        val target = store.state.value.records.people.entries.first { it.value.contactCard().favorite }
        val editStart = System.nanoTime()
        store.saveContact(target.value.contactCard().copy(favorite = false), target.key)
        val edit = (System.nanoTime() - editStart) / 1_000_000
        println("Synthetic fresh-process ready=${ready}ms firstEdit=${edit}ms")
        assertTrue("First save after restart must also be fast: ${edit}ms", edit < 250)
        store.saveContact(store.state.value.records.people.getValue(target.key).contactCard().copy(favorite = true), target.key)
        assertEquals(2600, store.state.value.records.people.size)
        assertEquals(329000, store.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
        assertTrue(store.state.value.records.people.values.any { it.contactCard().favorite })
        assertTrue(store.snapshot().graph!!.bundle.blobs.isNotEmpty())
    }
}
