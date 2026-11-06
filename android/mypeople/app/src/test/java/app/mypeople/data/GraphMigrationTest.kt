package app.mypeople.data

import java.io.File
import java.lang.reflect.InvocationTargetException
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.*
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

class GraphMigrationTest {
    @get:Rule val temporary = TemporaryFolder()
    private val password = "synthetic-wifi-migration-passphrase"
    private fun fixture() = json.parseToJsonElement(javaClass.getResource("/python-legacy-graph-handoff.json")!!.readText()).jsonObject
    private fun prepare(directory: File, context: File) = GraphMigration::class.java.getDeclaredMethod("prepare", File::class.java, File::class.java).apply { isAccessible = true }.invoke(GraphMigration, directory, context)
    private fun finish(directory: File, context: File, archive: File, key: File, commit: Boolean) = GraphMigration::class.java.getDeclaredMethod("finish", File::class.java, File::class.java, File::class.java, File::class.java, Boolean::class.javaPrimitiveType).apply { isAccessible = true }.invoke(GraphMigration, directory, context, archive, key, commit)
    @Test fun `WiFi maintenance verifies before committing and archives the complete old outbox`() = runBlocking {
        val data = fixture()
        val legacy = json.decodeFromJsonElement<DiskState>(data.getValue("legacy"))
        val reply = json.decodeFromJsonElement<TransferManifest>(data.getValue("reply"))
        val directory = temporary.newFolder()
        val store = Store(directory); store.restoreBackup(legacy)
        val context = File(temporary.newFolder(), "context.json")
        val archive = temporary.newFile("synthetic-migration.sherloq")
        val key = temporary.newFile("synthetic-passphrase").apply { writeText(password) }
        archive.outputStream().use { LargeArchive.writeMemory(reply, it, password, temporary.root) }
        prepare(directory, context)
        val fingerprint = StoreJournal(directory).fingerprint()
        finish(directory, context, archive, key, false)
        assertEquals(fingerprint, StoreJournal(directory).fingerprint())
        assertNull(StoreJournal(directory).load().graph)
        finish(directory, context, archive, key, true)
        val disk = StoreJournal(directory).load()
        assertNotNull(disk.graph); assertTrue(disk.pending.isEmpty()); assertTrue(disk.replica.changes.isEmpty())
        val gs = GraphStore(disk.graph!!)
        val original = gs.graph.objects.keys.single { gs.text(it, "system") == "mypeople-android-pre-graph" }
        val hash = gs.graph.value(original, "original")!!.jsonObject.text("blob_hash")
        val old = GraphBlobs.open(disk.graph!!.bundle.blobs, hash).use { StoreCheckpoint.decode(it.readBytes()) }
        assertEquals(legacy.replica.changes, old.replica.changes)
        assertEquals(6, old.pending.size)
        val restarted = Store(directory); restarted.initialize()
        assertEquals("Synthetic phone note 5", restarted.state.value.records.people.getValue(1).contactCard().notes)
        assertEquals(1, restarted.state.value.records.people.values.sumOf { p -> p.channels.sumOf { it.count } })
    }
    @Test fun `missing receipts and intervening edits never replace the old Store`() = runBlocking {
        val data = fixture()
        val directory = temporary.newFolder()
        Store(directory).restoreBackup(json.decodeFromJsonElement(data.getValue("legacy")))
        val reply = json.decodeFromJsonElement<TransferManifest>(data.getValue("reply")).copy(results = emptyList())
        val context = File(temporary.newFolder(), "context.json")
        prepare(directory, context)
        val before = StoreJournal(directory).fingerprint()
        val archive = temporary.newFile("unacknowledged.sherloq")
        archive.outputStream().use { LargeArchive.writeMemory(reply, it, password, temporary.root) }
        val key = temporary.newFile("synthetic-key").apply { writeText(password) }
        try { finish(directory, context, archive, key, true); fail("Pending edits were discarded") } catch (_: InvocationTargetException) { }
        assertEquals(before, StoreJournal(directory).fingerprint())
        assertEquals(6, StoreJournal(directory).load().pending.size)
        val journal = StoreJournal(directory); val old = journal.load()
        journal.save(old, old.copy(lastSync = "synthetic intervening write"))
        val changed = journal.fingerprint()
        try { finish(directory, context, archive, key, true); fail("Stale context was accepted") } catch (_: InvocationTargetException) { }
        assertEquals(changed, journal.fingerprint())
    }
}
