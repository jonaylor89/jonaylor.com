package app.mypeople.data

import java.io.File
import java.io.FileOutputStream
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
private data class MigrationContext(
    val fingerprint: String,
    val sequence: Long,
    val source: String,
    val publisher: String?,
    val revision: Long,
    val nextLocalId: Int,
    val people: Map<String, Int>,
    val pending: List<PendingOp>,
    val failedEdits: List<PendingOp>,
    val notices: List<Notice>,
    val original: String,
)

/** Explicit maintenance command, never a fixture or an auto-start component.
 * Run only with the normal app stopped. Preparation and graph loading are in
 * separate processes so two complete data models never occupy the phone heap.
 * Output is aggregate-only; a failed preflight never replaces the old Store. */
object GraphMigration {
    @JvmStatic fun main(args: Array<String>) {
        try {
            when (args.firstOrNull()) {
                "check" -> checkReady(File(args[1]))
                "backup" -> backup(File(args[1]), File(args[2]), File(args[3]))
                "verify-backup" -> verifyBackup(File(args[1]), File(args[2]), File(args[3]))
                "prepare" -> prepare(File(args[1]), File(args[2]))
                "verify", "commit" -> finish(File(args[1]), File(args[2]), File(args[3]), File(args[4]), args[0] == "commit")
                else -> throw IllegalArgumentException("Expected prepare, verify or commit")
            }
        } catch (error: Throwable) {
            // Never print parser exceptions or stack traces containing payloads.
            System.err.println("GraphMigration failed: ${error.javaClass.simpleName}; the previous Store remains recoverable.")
            kotlin.system.exitProcess(1)
        }
    }
    private fun checkReady(directory: File) = kotlinx.coroutines.runBlocking {
        val start = System.nanoTime()
        println("CHECK START maxHeap=${Runtime.getRuntime().maxMemory()}")
        val store = Store(directory, startupTiming = { stage, elapsed -> println("STARTUP $stage elapsedMs=$elapsed") }); store.initialize()
        val disk = store.snapshot(); val records = store.state.value.records
        System.gc()
        val runtime = Runtime.getRuntime()
        println("READY graph=${disk.graph != null} people=${records.people.size} messages=${records.people.values.sumOf { p -> p.channels.sumOf { it.count } }} pending=${disk.pending.size} failed=${disk.failedEdits.size} elapsedMs=${(System.nanoTime() - start) / 1_000_000} liveHeap=${runtime.totalMemory() - runtime.freeMemory()} maxHeap=${runtime.maxMemory()}")
    }
    private fun backup(directory: File, destination: File, passwordFile: File) {
        require(!destination.exists())
        val journal = StoreJournal(directory); journal.preserveMigration()
        val disk = journal.load()
        val photos = File(directory.parentFile, "offline-photos").listFiles().orEmpty()
            .filter { it.isFile && Regex("[0-9a-f]{64}").matches(it.name) }.associateBy { it.name }
        FileOutputStream(destination).use { file ->
            val out = java.io.BufferedOutputStream(file)
            LargeArchive.writeBackup(ContactBackup(state = disk), photos, out, passwordFile.readText().trim(), destination.parentFile, File(directory, "graph-blobs"))
            out.flush(); file.fd.sync()
        }
        GraphBlobs.syncDirectory(destination.parentFile)
        println("BACKUP WRITTEN bytes=${destination.length()} pending=${disk.pending.size}")
    }
    private fun verifyBackup(directory: File, archive: File, passwordFile: File) {
        val backup = requireNotNull(LargeArchive.read(archive, passwordFile.readText().trim(), archive.parentFile, File(directory, "graph-blobs")).backup)
        println("BACKUP VERIFIED graph=${backup.state.graph != null} pending=${backup.state.pending.size} legacyChanges=${backup.state.replica.changes.size}")
    }
    private fun prepare(directory: File, destination: File) {
        require(!destination.exists()) { "A fresh migration context is required" }
        val journal = StoreJournal(directory)
        journal.preserveMigration()
        val disk = journal.load()
        require(disk.graph == null) { "This store already uses graph storage" }
        val source = requireNotNull(disk.offlineSource)
        val history = ContactHistory(disk.replica.changes)
        val view = history.project(optimistic(disk.records, disk.pending), disk.replica.localIds)
        val root = File(directory, "graph-blobs").apply { mkdirs() }
        val original = File.createTempFile(".pre-graph-", ".bin", root)
        val digest = try {
            FileOutputStream(original).use { out -> StoreCheckpoint.write(disk, out, formatVersion = 7); out.fd.sync() }
            val id = original.inputStream().use(GraphBlobs::verifiedHash)
            original.inputStream().use { GraphBlobs.put(root, id, it) }
            id
        } finally { original.delete() }
        GraphBlobs.syncDirectory(root)
        val context = MigrationContext(journal.fingerprint(), disk.journalSequence, source, disk.replica.publisher, disk.offlineRevision,
            disk.nextLocalId, view.people.map { (id, p) -> p.contact_uid to id }.toMap(), disk.pending, disk.failedEdits, disk.notices, digest)
        destination.parentFile?.mkdirs()
        FileOutputStream(destination).use { out -> out.write(json.encodeToString(MigrationContext.serializer(), context).toByteArray()); out.fd.sync() }
        println("PREPARED people=${view.people.size} pending=${disk.pending.size} legacyChanges=${disk.replica.changes.size}")
    }
    private fun normalized(change: ContactChange) = change.copy(adds = change.adds.mapValues { (key, values) ->
        if (key == "fields") values.map { json.encodeToJsonElement(json.decodeFromJsonElement<ContactField>(it)) } else values
    })
    private fun finish(directory: File, contextFile: File, archive: File, passwordFile: File, commit: Boolean) {
        val context = json.decodeFromString<MigrationContext>(contextFile.readText())
        val journal = StoreJournal(directory)
        require(journal.fingerprint() == context.fingerprint)
        val blobDirectory = File(directory, "graph-blobs")
        val snapshot = requireNotNull(LargeArchive.read(archive, passwordFile.readText().trim(), contextFile.parentFile, blobDirectory).memory)
        println("ARCHIVE VERIFIED commits=${snapshot.graph?.commits?.size ?: 0} blobs=${snapshot.graph?.blobs?.size ?: 0}")
        require(snapshot.type == "snapshot" && snapshot.source == context.source && snapshot.publisher == context.publisher && snapshot.revision >= context.revision)
        val results = snapshot.results.associateBy { it.client_id }
        val failed = context.failedEdits.toMutableList()
        val notices = context.notices.toMutableList()
        for ((index, op) in context.pending.withIndex()) {
            val receipt = requireNotNull(results[op.client_id]) { "Pending edit has not been acknowledged by the Mac" }
            require(receipt.kind == op.kind)
            val same = if (op.kind == "contact_change") normalized(json.decodeFromJsonElement<ContactChange>(receipt.payload)) == normalized(json.decodeFromJsonElement<ContactChange>(op.payload)) else receipt.payload == op.payload
            if (!same) println("RECEIPT CHECK FAILED index=$index payloadMatched=false")
            require(same) { "Edit receipt does not match the phone payload" }
            require(receipt.status in setOf("done", "failed"))
            if (receipt.status == "failed") { failed += op; notices += Notice(message = receipt.message ?: "A legacy request needs review; its payload was retained.") }
        }
        println("RECEIPTS VERIFIED count=${context.pending.size}")
        val incoming = requireNotNull(snapshot.graph)
        val initial = GraphStore(GraphState(incoming))
        val ids = mutableMapOf<String, Int>(); val used = mutableSetOf<Int>()
        for ((root, members) in initial.graph.components().groups) {
            val preferred = context.people[root] ?: members.mapNotNull { context.people[it] }.minOrNull() ?: initial.text(root, "legacy_id").toIntOrNull()
            if (preferred != null && used.add(preferred)) ids[root] = preferred
        }
        var state = GraphStore(initial.state.copy(localIds = ids)).indexed()
        val original = VersionedGraph.createObject("SourceRecord", buildJsonObject {
            put("system", "mypeople-android-pre-graph"); put("format", "checkpoint-v7")
            put("original", buildJsonObject { put("blob_hash", context.original) })
        })
        state = GraphStore(state).commit(listOf(original), GraphBlobs.files(blobDirectory, listOf(context.original)))
        state = state.copy(remoteHeads = incoming.heads)
        val received = Records().applyChanges(snapshot.records)
        val derived = Records(people = received.people.mapValues { (_, p) -> Person("", contact_uid = p.contact_uid,
            contact_aliases = p.contact_aliases, category = p.category, closeness = p.closeness, cadence_days = p.cadence_days,
            trend = p.trend, days_365 = p.days_365, muted = p.muted) })
        val projected = GraphStore(state).project(derived = derived)
        val next = DiskState(graph = state, records = derived, nextLocalId = minOf(context.nextLocalId, (state.localIds.values.minOrNull() ?: 0) - 1),
            failedEdits = failed, notices = notices, offlineSource = snapshot.source, offlineRevision = snapshot.revision,
            replica = ReplicaState(publisher = snapshot.publisher), lastSync = Instant.now().toString())
        require(journal.fingerprint() == context.fingerprint)
        if (commit) journal.commitMigration(next, projected, context.sequence, context.fingerprint)
        val messages = projected.people.values.sumOf { p -> p.channels.sumOf { it.count } }
        println("${if (commit) "COMMITTED" else "VERIFIED"} graph=true people=${projected.people.size} messages=$messages blobs=${state.bundle.blobs.size} acknowledged=${context.pending.size} retainedFailed=${failed.size} maxHeap=${Runtime.getRuntime().maxMemory()}")
    }
}
