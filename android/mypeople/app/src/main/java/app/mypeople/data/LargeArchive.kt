package app.mypeople.data

import java.io.*
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.*

@Serializable
internal data class LargeArchiveMetadata(
    val format: Int = 2,
    val kind: String,
    val memory: TransferManifest? = null,
    val peopleFirst: Boolean = true,
    val blob_hashes: List<String> = emptyList(),
    val photo_hashes: List<String> = emptyList(),
)
internal data class LargeArchiveResult(val memory: TransferManifest? = null, val backup: ContactBackup? = null)

/** Complete file archive, independent of Bluetooth frame limits. Blobs are raw
 * binary entries, not Base64 copies in a giant JSON document. All authentication,
 * inventory checks and blob hashes succeed before any Store transaction. */
@OptIn(ExperimentalSerializationApi::class)
internal object LargeArchive {
    const val MAX_METADATA = 128L * 1024 * 1024
    private val hash = Regex("[0-9a-f]{64}")
    fun isStreaming(file: File) = file.inputStream().use { input ->
        val header = ByteArray(8)
        try { DataInputStream(input).readFully(header); header.contentEquals(ChunkedCrypto.magic) } catch (_: EOFException) { false }
    }
    private class Limited(input: InputStream, private val limit: Long) : FilterInputStream(input) {
        var count = 0L
        override fun read(): Int = super.read().also { if (it >= 0) { count++; require(count <= limit) { "Archive entry exceeds its size limit." } } }
        override fun read(b: ByteArray, off: Int, len: Int): Int = `in`.read(b, off, len).also { if (it > 0) { count += it; require(count <= limit) { "Archive entry exceeds its size limit." } } }
    }
    fun copyLimited(input: InputStream, output: OutputStream, limit: Long = ChunkedCrypto.MAX_BYTES + 1024 * 1024, expected: String? = null): Long {
        val source = Limited(input, limit)
        val digest = java.security.MessageDigest.getInstance("SHA-256")
        val buffer = ByteArray(65536)
        while (true) { val n = source.read(buffer); if (n < 0) break; if (expected != null) digest.update(buffer, 0, n); output.write(buffer, 0, n) }
        if (expected != null) require(digest.digest().joinToString("") { "%02x".format(it) } == expected) { "Damaged graph blob" }
        return source.count
    }
    fun read(file: File, password: String, temporaryDirectory: File, blobDirectory: File, photo: (String, ByteArray) -> Unit = { _, _ -> }): LargeArchiveResult {
        temporaryDirectory.mkdirs()
        val plain = File.createTempFile(".authenticated-", ".zip", temporaryDirectory)
        try {
            file.inputStream().buffered().use { input -> plain.outputStream().buffered().use { ChunkedCrypto.decrypt(input, it, password) } }
            return unpack(plain, blobDirectory, photo)
        } finally { plain.delete() }
    }
    fun unpack(file: File, blobDirectory: File, photo: (String, ByteArray) -> Unit = { _, _ -> }): LargeArchiveResult {
        val stateFile = File.createTempFile(".state-", ".bin", file.absoluteFile.parentFile)
        return try { unpackState(file, blobDirectory, photo, stateFile) } finally { stateFile.delete() }
    }
    private fun unpackState(file: File, blobDirectory: File, photo: (String, ByteArray) -> Unit, stateFile: File): LargeArchiveResult {
        var metadata: LargeArchiveMetadata? = null
        var hasState = false
        val names = mutableSetOf<String>(); val blobs = mutableSetOf<String>(); val photos = mutableSetOf<String>()
        var total = 0L
        var expectedBlobs = emptySet<String>(); var expectedPhotos = emptySet<String>()
        ZipInputStream(file.inputStream().buffered()).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                require(!entry.isDirectory && names.add(entry.name) && names.size <= 1_010_002) { "Invalid streaming archive entries." }
                if (metadata == null) {
                    require(entry.name == "metadata.json") { "Streaming metadata must come first." }
                    val limited = Limited(zip, MAX_METADATA)
                    metadata = GraphAtoms.decoding { json.decodeFromStream<LargeArchiveMetadata>(limited) }
                    total += limited.count
                    val m = metadata!!
                    require(m.format == 2 && m.kind in setOf("memory", "backup")) { "Unsupported streaming archive." }
                    require(m.blob_hashes.size <= 1_000_000 && m.blob_hashes.toSet().size == m.blob_hashes.size && m.blob_hashes.all(hash::matches)) { "Invalid graph blob inventory." }
                    require(m.photo_hashes.size <= 10000 && m.photo_hashes.toSet().size == m.photo_hashes.size && m.photo_hashes.all(hash::matches)) { "Invalid photo inventory." }
                    require((m.kind == "memory") == (m.memory != null))
                    expectedBlobs = m.blob_hashes.toSet(); expectedPhotos = m.photo_hashes.toSet()
                    require(m.memory?.graph?.blobs.isNullOrEmpty()) { "Inline graph blobs are not permitted in file format 2." }
                } else if (entry.name == "state.bin") {
                    require(metadata!!.kind == "backup") { "Unexpected backup state." }
                    total += stateFile.outputStream().buffered().use { copyLimited(zip, it, 256L * 1024 * 1024) }
                    hasState = true
                } else if (entry.name.startsWith("blobs/")) {
                    val id = entry.name.removePrefix("blobs/")
                    require(hash.matches(id) && id in expectedBlobs) { "Unexpected graph blob entry." }
                    total += GraphBlobs.put(blobDirectory, id, zip)
                    blobs += id
                } else if (entry.name.startsWith("photos/")) {
                    val id = entry.name.removePrefix("photos/")
                    require(hash.matches(id) && id in expectedPhotos) { "Unexpected photo entry." }
                    val bytes = Transfer.readLimited(zip, 10 * 1024 * 1024)
                    total += bytes.size
                    require(BackupArchive.hash(bytes) == id) { "Damaged photo." }
                    photo(id, bytes); photos += id
                } else throw IllegalArgumentException("Unexpected streaming archive path.")
                require(total <= ChunkedCrypto.MAX_BYTES) { "Streaming archive exceeds the safe size limit." }
                zip.closeEntry()
            }
        }
        val m = requireNotNull(metadata)
        require(blobs == m.blob_hashes.toSet() && photos == m.photo_hashes.toSet()) { "Incomplete streaming archive; nothing was committed." }
        GraphBlobs.syncDirectory(blobDirectory)
        val values = GraphBlobs.files(blobDirectory, m.blob_hashes)
        if (m.kind == "memory") {
            require(!hasState)
            val memory = requireNotNull(m.memory)
            val graph = requireNotNull(memory.graph) { "A streaming memory must contain a complete graph." }
            val result = memory.copy(graph = graph.copy(blobs = values))
            Transfer.validate(result)
            verifiedBundle(result.graph!!)
            GraphStore(GraphState(result.graph!!))
            return LargeArchiveResult(memory = result)
        }
        require(hasState) { "Missing backup state." }
        val disk = StoreCheckpoint.snapshot(stateFile, blobDirectory).state
        require(disk.graph?.bundle?.blobs?.keys.orEmpty() == blobs) { "Backup graph inventory does not match its state." }
        disk.graph?.let { verifiedBundle(it.bundle); GraphStore(it) }
        if (disk.replica.enabled) ContactHistory(disk.replica.changes)
        disk.records.people.values.forEach { it.card?.validate() }
        require(disk.pending.size <= 10000 && disk.pending.all { it.kind in opKinds }) { "Invalid backup requests." }
        return LargeArchiveResult(backup = ContactBackup(state = disk, peopleFirst = m.peopleFirst))
    }
    private fun verifiedBundle(bundle: GraphBundle) {
        // The archive reader already authenticated and hashed every raw entry.
        // Validate graph syntax/causality and references without rereading all files.
        val reduced = VersionedGraph(bundle.commits)
        GraphStore.verifyReferences(reduced.ordered, bundle.blobs.keys)
        bundle.reducer = reduced; bundle.blobsVerified = true
    }
    fun writeMemory(memory: TransferManifest, output: OutputStream, password: String, temporaryDirectory: File) {
        val graph = requireNotNull(memory.graph)
        val metadata = LargeArchiveMetadata(kind = "memory", memory = memory.copy(graph = graph.copy(blobs = emptyMap())), blob_hashes = graph.blobs.keys.sorted())
        write(metadata, graph.blobs, emptyMap(), output, password, temporaryDirectory) { }
    }
    fun writeBackup(backup: ContactBackup, photos: Map<String, File>, output: OutputStream, password: String, temporaryDirectory: File, blobDirectory: File) {
        val blobs = backup.state.graph?.bundle?.blobs.orEmpty()
        val metadata = LargeArchiveMetadata(kind = "backup", peopleFirst = backup.peopleFirst, blob_hashes = blobs.keys.sorted(), photo_hashes = photos.keys.sorted())
        write(metadata, blobs, photos, output, password, temporaryDirectory) { zip ->
            zip.putNextEntry(ZipEntry("state.bin"))
            StoreCheckpoint.write(backup.state, zip, blobDirectory = blobDirectory)
            zip.closeEntry()
        }
    }
    private fun write(metadata: LargeArchiveMetadata, blobs: Map<String, String>, photos: Map<String, File>, output: OutputStream, password: String, temporaryDirectory: File, extra: (ZipOutputStream) -> Unit) {
        temporaryDirectory.mkdirs()
        val plain = File.createTempFile(".archive-", ".zip", temporaryDirectory)
        try {
            ZipOutputStream(plain.outputStream().buffered()).use { zip ->
                zip.putNextEntry(ZipEntry("metadata.json")); json.encodeToStream(metadata, zip); zip.closeEntry()
                extra(zip)
                for (id in metadata.blob_hashes) {
                    require(hash.matches(id)); zip.putNextEntry(ZipEntry("blobs/$id"))
                    GraphBlobs.open(blobs, id).use { copyLimited(it, zip, 128L * 1024 * 1024, id) }; zip.closeEntry()
                }
                for ((id, file) in photos) {
                    require(hash.matches(id)); require(file.inputStream().use(GraphBlobs::verifiedHash) == id)
                    zip.putNextEntry(ZipEntry("photos/$id")); file.inputStream().use { copyLimited(it, zip, 10L * 1024 * 1024) }; zip.closeEntry()
                }
            }
            plain.inputStream().buffered().use { ChunkedCrypto.encrypt(it, output, password) }
        } finally { plain.delete() }
    }
}
