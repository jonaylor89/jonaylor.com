package app.mypeople.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import java.io.File
import java.io.FileOutputStream
import java.io.RandomAccessFile
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

@Serializable
internal data class MirrorEntry(val rawId: Long, val exported: ContactCard, val local: ContactCard, val phoneFormat: Int = 0)
@Serializable
internal data class MirrorState(val entries: Map<String, MirrorEntry> = emptyMap(), val sequence: Long = 0)
@Serializable
private data class MirrorPatch(val sequence: Long, val upserts: Map<String, MirrorEntry>, val removed: List<String>)

/** Provider baseline transactions are per changed contact, not per entire photo-filled address book.
 * Callers serialize access with DeviceContacts' mutex. Old contacts-mirror.json files migrate on read.
 */
internal class ContactMirror(private val file: File) {
    private val log = File(file.parentFile, "contacts-mirror.journal")
    private var cached: MirrorState? = null
    private var frames = 0
    private fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes)
    fun load(): MirrorState {
        cached?.let { return it }
        var state = if (file.exists()) json.decodeFromString<MirrorState>(file.readText()) else MirrorState()
        if (log.exists()) RandomAccessFile(log, "rw").use { input ->
            while (input.filePointer < input.length()) {
                val start = input.filePointer
                if (input.length() - start < 4) { input.setLength(start); break }
                val size = input.readInt()
                require(size in 1..(128 * 1024 * 1024)) { "Damaged Android contacts baseline." }
                if (input.length() - input.filePointer < size + 32L) { input.setLength(start); break }
                val bytes = ByteArray(size); input.readFully(bytes)
                val checksum = ByteArray(32); input.readFully(checksum)
                require(hash(bytes).contentEquals(checksum)) { "Damaged Android contacts baseline." }
                val patch = json.decodeFromString<MirrorPatch>(bytes.toString(Charsets.UTF_8))
                if (patch.sequence > state.sequence) {
                    require(patch.sequence == state.sequence + 1) { "Missing Android contacts baseline transaction." }
                    state = MirrorState(state.entries - patch.removed.toSet() + patch.upserts, patch.sequence)
                }
                frames++
            }
        }
        cached = state
        return state
    }
    fun save(next: MirrorState) {
        val previous = load()
        if (next.entries == previous.entries) return
        val upserts = next.entries.filter { (uid, entry) -> previous.entries[uid] != entry }
        val removed = (previous.entries.keys - next.entries.keys).toList()
        val state = next.copy(sequence = previous.sequence + 1)
        val bytes = json.encodeToString(MirrorPatch(state.sequence, upserts, removed)).toByteArray()
        file.parentFile?.mkdirs()
        val start = log.length()
        try {
            FileOutputStream(log, true).use { stream ->
                val out = java.io.DataOutputStream(stream)
                out.writeInt(bytes.size); out.write(bytes); out.write(hash(bytes)); out.flush(); stream.fd.sync()
            }
        } catch (e: java.io.IOException) {
            RandomAccessFile(log, "rw").use { it.setLength(start); it.fd.sync() }; throw e
        }
        cached = state; frames++
        if (frames >= 256 || log.length() > 32L * 1024 * 1024) runCatching {
            val tmp = File(file.parentFile, "contacts-mirror.tmp")
            FileOutputStream(tmp).use { stream -> stream.write(json.encodeToString(state).toByteArray()); stream.fd.sync() }
            Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
            FileOutputStream(log).use { it.fd.sync() }; frames = 0
        }
    }
}
