package app.mypeople.data

import kotlinx.serialization.json.*
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** Small, checksummed, fsynced transactions over typed binary checkpoints.
 * The old store.json is read once for migration and retained untouched for recovery.
 * Only an incomplete final frame is recoverable; a damaged complete frame is never discarded.
 */
internal class StoreJournal(private val directory: File) {
    private val checkpoint = File(directory, "store.json")
    private val journal = File(directory, "store.journal")
    private val binary = File(directory, "store.bin")
    private var sequence = 0L
    private var frames = 0
    var cachedRecords: Records? = null
        private set
    private var supportsBlobRefs = false
    var checkpointWritten = false
        private set
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)

    fun load(): DiskState {
        supportsBlobRefs = binary.isFile && java.io.DataInputStream(binary.inputStream()).use { it.skipBytes(8); it.readInt() >= 8 }
        val migrate = !binary.exists() && checkpoint.exists()
        var state = when {
            binary.exists() -> StoreCheckpoint.snapshot(binary, File(directory, "graph-blobs")).also { cachedRecords = it.view }.state
            checkpoint.exists() -> json.decodeFromString<DiskState>(checkpoint.readText())
            else -> DiskState()
        }
        sequence = state.journalSequence
        if (journal.exists()) RandomAccessFile(journal, "rw").use { file ->
            while (file.filePointer < file.length()) {
                val start = file.filePointer
                if (file.length() - start < 4) { file.setLength(start); break }
                val size = file.readInt()
                require(size in 1..(128 * 1024 * 1024)) { "Damaged local transaction length." }
                if (file.length() - file.filePointer < size + 32L) { file.setLength(start); break }
                val bytes = ByteArray(size); file.readFully(bytes)
                val digest = ByteArray(32); file.readFully(digest)
                require(hash(bytes).contentEquals(digest)) { "Damaged local transaction." }
                val patch = json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
                val next = patch.getValue("journalSequence").jsonPrimitive.long
                if (next > sequence) {
                    require(next == sequence + 1) { "Missing local transaction." }
                    if (patch.keys.any { it in setOf("records", "pending", "replica", "graph", "graph_delta") }) cachedRecords = null
                    val meta = patch["replica"]?.jsonObject
                    var replica = state.replica
                    if (meta != null) {
                        val old = if (patch["replica_reset"]?.jsonPrimitive?.boolean == true) emptyList() else replica.changes
                        val additions = patch["replica_changes"]?.let { json.decodeFromJsonElement<List<ContactChange>>(it) }.orEmpty()
                        replica = replica.copy(
                            enabled = meta["enabled"]?.jsonPrimitive?.boolean ?: replica.enabled,
                            changes = if (additions.isEmpty() && old === replica.changes) old else old + additions,
                            remoteHeads = meta["remoteHeads"]?.let { json.decodeFromJsonElement(it) } ?: replica.remoteHeads,
                            localIds = meta["localIds"]?.let { json.decodeFromJsonElement(it) } ?: replica.localIds,
                            recordHashes = meta["recordHashes"]?.let { json.decodeFromJsonElement(it) } ?: replica.recordHashes,
                            publisher = if ("publisher" in meta) meta["publisher"]?.jsonPrimitive?.contentOrNull else replica.publisher)
                    }
                    fun nullable(key: String, fallback: String?): String? = if (key in patch) patch[key]?.jsonPrimitive?.contentOrNull else fallback
                    state = state.copy(
                        records = patch["records"]?.let { json.decodeFromJsonElement(it) } ?: state.records,
                        pending = patch["pending"]?.let { json.decodeFromJsonElement(it) } ?: state.pending,
                        failedEdits = patch["failedEdits"]?.let { json.decodeFromJsonElement(it) } ?: state.failedEdits,
                        notices = patch["notices"]?.let { json.decodeFromJsonElement(it) } ?: state.notices,
                        replica = replica, journalSequence = next,
                        graph = if ("graph_delta" in patch) {
                            val delta = json.decodeFromJsonElement<GraphState>(patch.getValue("graph_delta"))
                            val base = if (patch["graph_reset"]?.jsonPrimitive?.boolean == true) null else state.graph
                            val blobs = patch["graph_blob_files"]?.let { GraphBlobs.files(File(directory, "graph-blobs"), json.decodeFromJsonElement<List<String>>(it)) } ?: delta.bundle.blobs
                            delta.copy(
                                bundle = delta.bundle.copy(commits = base?.bundle?.commits.orEmpty() + delta.bundle.commits, blobs = GraphBlobs.merge(base?.bundle?.blobs.orEmpty(), blobs)),
                                localIds = if (patch["graph_ids_delta"]?.jsonPrimitive?.boolean == true) base?.localIds.orEmpty() + delta.localIds else delta.localIds,
                            )
                        } else if ("graph" in patch) patch["graph"]?.takeUnless { it == JsonNull }?.let { json.decodeFromJsonElement<GraphState>(it) } else state.graph,
                        cursor = patch["cursor"]?.jsonPrimitive?.long ?: state.cursor,
                        nextLocalId = patch["nextLocalId"]?.jsonPrimitive?.int ?: state.nextLocalId,
                        offlineRevision = patch["offlineRevision"]?.jsonPrimitive?.long ?: state.offlineRevision,
                        offlineSource = nullable("offlineSource", state.offlineSource),
                        lastSync = nullable("lastSync", state.lastSync), lastError = nullable("lastError", state.lastError))
                    sequence = next
                }
                frames++
            }
        }
        // Decode the legacy JSON only once. Keep it intact as recovery evidence;
        // store.bin + subsequent journal frames become the authoritative local state.
        if (migrate) runCatching { checkpoint(state) }
        return state
    }

    fun cacheView(state: DiskState, view: Records) {
        if (!binary.exists() && !checkpoint.exists() && journal.length() == 0L) return
        checkpoint(state, view)
        cachedRecords = view; checkpointWritten = false
    }

    fun fingerprint(): String {
        val digest = MessageDigest.getInstance("SHA-256")
        for (file in listOf(checkpoint, binary, journal)) {
            digest.update(file.name.toByteArray())
            if (file.isFile) file.inputStream().use { input ->
                val buffer = ByteArray(65536)
                while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }
    fun preserveMigration() = preserveRecovery("pre-wifi-graph-${fingerprint().take(16)}")
    /** Maintenance-only commit while the app is stopped. Reject any intervening
     * store write both before encoding and immediately before atomic rename. */
    fun commitMigration(next: DiskState, view: Records, previousSequence: Long, expected: String) {
        require(fingerprint() == expected) { "Phone changed during migration; nothing was replaced." }
        preserveMigration()
        sequence = previousSequence + 1
        checkpoint(next, view) { require(fingerprint() == expected) { "Phone changed during migration; nothing was replaced." } }
    }
    private fun checkpoint(state: DiskState, view: Records? = null, beforeCommit: () -> Unit = {}) {
        // Version 8 can refer to app-private blob files. Retain the previous
        // self-contained store before its first format upgrade, never overwrite it.
        if (binary.isFile && java.io.DataInputStream(binary.inputStream()).use { it.skipBytes(8); it.readInt() < 8 }) preserveRecovery("pre-blob-storage-backup")
        directory.mkdirs()
        val temp = File(directory, "store.bin.tmp")
        FileOutputStream(temp).use { stream ->
            StoreCheckpoint.write(state.copy(journalSequence = sequence), java.io.BufferedOutputStream(stream, 65536), view, blobDirectory = File(directory, "graph-blobs"))
            stream.fd.sync()
        }
        beforeCommit()
        Files.move(temp.toPath(), binary.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        supportsBlobRefs = true
        // Old frames can be replayed idempotently if killed between rename and truncation.
        // The rename is the commit point. A failed cleanup must not report a committed
        // direct checkpoint as a failed edit; old frames are skipped by sequence on read.
        runCatching { FileOutputStream(journal).use { it.fd.sync() }; frames = 0 }
        checkpointWritten = true
    }

    fun preserveGraphJoin(collection: String) {
        java.util.UUID.fromString(collection)
        preserveRecovery("pre-graph-join-$collection")
    }
    private fun preservePreGraph() = preserveRecovery("pre-graph-backup")
    private fun preserveRecovery(name: String) {
        val sources = listOf(checkpoint, binary, journal).filter { it.exists() }
        if (sources.isEmpty()) return
        val backup = File(directory, name)
        if (backup.exists()) {
            require(File(backup, "complete").isFile) { "The pre-graph recovery copy is incomplete. Original files have not been replaced." }
            return
        }
        val temporary = File(directory, ".pre-graph-${java.util.UUID.randomUUID()}")
        require(temporary.mkdir()) { "Could not prepare pre-graph recovery copy." }
        try {
            sources.forEach { source ->
                FileOutputStream(File(temporary, source.name)).use { output -> source.inputStream().use { it.copyTo(output) }; output.fd.sync() }
            }
            FileOutputStream(File(temporary, "complete")).use { output -> output.write("Pre-graph checkpoint and journal. Retained for recovery; never overwritten.\n".toByteArray()); output.fd.sync() }
            Files.move(temporary.toPath(), backup.toPath(), StandardCopyOption.ATOMIC_MOVE)
        } catch (error: Exception) {
            // Leave originals untouched. Only our uncommitted temporary recovery copy is disposable.
            temporary.deleteRecursively()
            throw error
        }
    }

    fun save(previous: DiskState, next: DiskState) {
        checkpointWritten = false
        directory.mkdirs()
        if (previous.graph == null && next.graph != null) preservePreGraph()
        // Dense legacy DAGs can have a megabyte-sized parent array shared by hundreds
        // of changes. Do not expand that into a giant JSON tree/string just to journal
        // an import: the typed checkpoint interns these arrays and commits atomically.
        var newEdges = 0L
        if (previous.replica.changes !== next.replica.changes) {
            val old = previous.replica.changes.map { it.id }.toSet()
            newEdges += next.replica.changes.filterNot { it.id in old }.sumOf { it.parents.size.toLong() }
        }
        if (previous.records.contactChanges !== next.records.contactChanges) {
            newEdges += next.records.contactChanges.filterKeys { it !in previous.records.contactChanges }.values.sumOf { it.parents.size.toLong() }
        }
        val oldGraphIds = previous.graph?.bundle?.commits.orEmpty().map { it.id }.toSet()
        val graphOperations = next.graph?.bundle?.commits.orEmpty().filterNot { it.id in oldGraphIds }.sumOf { it.operations.size.toLong() }
        if (newEdges > 4096 || graphOperations > 4096 || (next.graph != null && (previous.graph == null || !supportsBlobRefs))) {
            val before = sequence
            sequence++
            try { checkpoint(next) } catch (error: Exception) { sequence = before; throw error }
            return
        }
        // Avoid serializing the whole address book for an outbox/status/notice update.
        val patch = buildJsonObject {
            put("journalSequence", sequence + 1)
            if (previous.records !== next.records) put("records", json.encodeToJsonElement(next.records))
            if (previous.graph !== next.graph) {
                val graph = next.graph
                if (graph == null) put("graph", JsonNull)
                else {
                    val old = previous.graph
                    val ids = old?.bundle?.commits.orEmpty().map { it.id }.toSet()
                    val reset = old == null || old.bundle.collection != graph.bundle.collection || !graph.bundle.commits.map { it.id }.containsAll(ids) ||
                        old.localIds.any { (uid, id) -> graph.localIds[uid] != id }
                    put("graph_reset", reset)
                    // Do not repeat the entire native identity index in each tiny
                    // edit frame (which otherwise forces a full checkpoint every
                    // few saves on a large book). Old frames still carry full ids.
                    put("graph_ids_delta", !reset)
                    val blobs = if (reset) graph.bundle.blobs else if (graph.bundle.blobs === old!!.bundle.blobs) emptyMap() else GraphBlobs.filter(graph.bundle.blobs) { it !in old.bundle.blobs }
                    val external = GraphBlobs.storedIn(graph.bundle.blobs, File(directory, "graph-blobs"))
                    if (external) put("graph_blob_files", json.encodeToJsonElement(blobs.keys.toList()))
                    put("graph_delta", json.encodeToJsonElement(graph.copy(
                        localIds = if (reset) graph.localIds else graph.localIds.filterKeys { it !in old!!.localIds },
                        bundle = graph.bundle.copy(commits = if (reset) graph.bundle.commits else graph.bundle.commits.filterNot { it.id in ids }, blobs = if (external) emptyMap() else blobs))))
                }
            }
            if (previous.pending !== next.pending) put("pending", json.encodeToJsonElement(next.pending))
            if (previous.failedEdits !== next.failedEdits) put("failedEdits", json.encodeToJsonElement(next.failedEdits))
            if (previous.notices !== next.notices) put("notices", json.encodeToJsonElement(next.notices))
            if (previous.replica !== next.replica) {
                put("replica", buildJsonObject {
                    put("enabled", next.replica.enabled)
                    put("publisher", next.replica.publisher?.let(::JsonPrimitive) ?: JsonNull)
                    if (previous.replica.remoteHeads !== next.replica.remoteHeads) put("remoteHeads", json.encodeToJsonElement(next.replica.remoteHeads))
                    if (previous.replica.localIds !== next.replica.localIds) put("localIds", json.encodeToJsonElement(next.replica.localIds))
                    if (previous.replica.recordHashes !== next.replica.recordHashes) put("recordHashes", json.encodeToJsonElement(next.replica.recordHashes))
                })
                val oldIds = previous.replica.changes.map { it.id }.toSet()
                val newIds = next.replica.changes.map { it.id }.toSet()
                val reset = !newIds.containsAll(oldIds)
                put("replica_reset", reset)
                put("replica_changes", json.encodeToJsonElement(if (reset) next.replica.changes else next.replica.changes.filterNot { it.id in oldIds }))
            }
            put("cursor", next.cursor); put("nextLocalId", next.nextLocalId)
            put("lastSync", next.lastSync?.let(::JsonPrimitive) ?: JsonNull)
            put("lastError", next.lastError?.let(::JsonPrimitive) ?: JsonNull)
            put("offlineSource", next.offlineSource?.let(::JsonPrimitive) ?: JsonNull)
            put("offlineRevision", next.offlineRevision)
        }
        val bytes = patch.toString().toByteArray(Charsets.UTF_8)
        val start = journal.length()
        try {
            FileOutputStream(journal, true).use { stream ->
                val out = java.io.DataOutputStream(stream)
                out.writeInt(bytes.size); out.write(bytes); out.write(hash(bytes)); out.flush(); stream.fd.sync()
            }
        } catch (e: java.io.IOException) {
            RandomAccessFile(journal, "rw").use { it.setLength(start); it.fd.sync() }
            throw e
        }
        sequence++; frames++
        // Checkpoint only after a sizeable journal, never on every contact edit.
        // A failed checkpoint is harmless: the durable transaction above is sufficient.
        if (frames >= 256 || journal.length() > 256L * 1024) runCatching { checkpoint(next) }
    }
}
