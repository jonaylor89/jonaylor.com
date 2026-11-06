package app.mypeople.data

import java.io.File
import java.io.FileOutputStream
import java.io.InputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest
import java.util.Base64
import kotlinx.collections.immutable.*

/** Immutable lazy values: the graph owns every blob, but not every Base64 image
 * and message archive needs to occupy the phone heap at the same time. */
internal class GraphBlobs private constructor(private val sources: PersistentMap<String, Source>, private val directory: File? = null) : AbstractMap<String, String>() {
    private sealed interface Source {
        fun open(): InputStream
        data class Inline(val value: String) : Source { override fun open() = Base64.getDecoder().wrap(value.byteInputStream()) }
        data class Stored(val file: File) : Source { override fun open() = file.inputStream() }
    }
    override val keys: Set<String> get() = sources.keys
    override val size: Int get() = sources.size
    override fun containsKey(key: String) = sources.containsKey(key)
    override fun get(key: String): String? = when (val source = sources[key]) {
        null -> null
        is Source.Inline -> source.value
        is Source.Stored -> source.open().use { Base64.getEncoder().encodeToString(it.readBytes()) }
    }
    override val entries: Set<Map.Entry<String, String>> get() = object : AbstractSet<Map.Entry<String, String>>() {
        override val size get() = sources.size
        override fun iterator(): Iterator<Map.Entry<String, String>> = sources.keys.asSequence().map { key ->
            object : Map.Entry<String, String> {
                override val key = key
                override val value get() = this@GraphBlobs.get(key)!!
                override fun equals(other: Any?) = other is Map.Entry<*, *> && key == other.key && value == other.value
                override fun hashCode() = key.hashCode() xor value.hashCode()
            }
        }.iterator()
    }
    companion object {
        private val hashPattern = Regex("[0-9a-f]{64}")
        private fun refs(blobs: Map<String, String>): PersistentMap<String, Source> =
            if (blobs is GraphBlobs) blobs.sources else blobs.mapValues { Source.Inline(it.value) }.toPersistentHashMap()
        fun files(directory: File, hashes: Collection<String>): Map<String, String> {
            require(hashes.size <= 1_000_000 && hashes.toSet().size == hashes.size)
            return GraphBlobs(hashes.associateWith { hash ->
                require(hashPattern.matches(hash)) { "Invalid graph blob hash" }
                val file = File(directory, hash)
                require(file.isFile) { "Missing graph blob" }
                Source.Stored(file)
            }.toPersistentHashMap(), directory.absoluteFile)
        }
        fun merge(left: Map<String, String>, right: Map<String, String>): Map<String, String> {
            if (right.isEmpty()) return left
            if (left.isEmpty()) return right
            val root = (left as? GraphBlobs)?.directory?.takeIf { it == (right as? GraphBlobs)?.directory }
            return GraphBlobs(refs(left).putAll(refs(right)), root)
        }
        fun filter(blobs: Map<String, String>, keep: (String) -> Boolean): Map<String, String> =
            GraphBlobs(refs(blobs).filterKeys(keep).toPersistentHashMap(), (blobs as? GraphBlobs)?.directory)
        fun open(blobs: Map<String, String>, hash: String): InputStream =
            if (blobs is GraphBlobs) requireNotNull(blobs.sources[hash]).open()
            else Base64.getDecoder().wrap(requireNotNull(blobs[hash]).byteInputStream())
        private fun hex(bytes: ByteArray): String {
            val alphabet = "0123456789abcdef"
            return buildString(bytes.size * 2) { for (byte in bytes) {
                val value = byte.toInt() and 255
                append(alphabet[value ushr 4]); append(alphabet[value and 15])
            } }
        }
        fun verifiedHash(input: InputStream): String = verifiedHash(input, ByteArray(65536))
        fun verifiedHash(input: InputStream, buffer: ByteArray): String {
            val digest = MessageDigest.getInstance("SHA-256")
            while (true) { val n = input.read(buffer); if (n < 0) break; digest.update(buffer, 0, n) }
            return hex(digest.digest())
        }
        fun put(directory: File, hash: String, input: InputStream, limit: Long = 128L * 1024 * 1024): Long {
            require(hashPattern.matches(hash)) { "Invalid graph blob hash" }
            directory.mkdirs()
            val destination = File(directory, hash)
            if (destination.isFile && destination.length() <= limit && destination.inputStream().use(::verifiedHash) == hash) {
                val digest = MessageDigest.getInstance("SHA-256")
                val buffer = ByteArray(65536); var total = 0L
                while (true) {
                    val n = input.read(buffer); if (n < 0) break
                    total += n; require(total <= limit) { "Graph blob exceeds supported size" }
                    digest.update(buffer, 0, n)
                }
                require(hex(digest.digest()) == hash) { "Damaged graph blob" }
                return total
            }
            val temporary = File.createTempFile(".blob-", ".tmp", directory)
            try {
                val digest = MessageDigest.getInstance("SHA-256")
                var total = 0L
                FileOutputStream(temporary).use { out ->
                    val buffer = ByteArray(65536)
                    while (true) {
                        val n = input.read(buffer); if (n < 0) break
                        total += n; require(total <= limit) { "Graph blob exceeds supported size" }
                        digest.update(buffer, 0, n); out.write(buffer, 0, n)
                    }
                    require(hex(digest.digest()) == hash) { "Damaged graph blob" }
                    out.fd.sync()
                }
                Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
                return total
            } finally { temporary.delete() }
        }
        fun storedIn(blobs: Map<String, String>, directory: File) = blobs is GraphBlobs && blobs.directory == directory.absoluteFile
        fun syncDirectory(directory: File) {
            if (directory.isDirectory) java.nio.channels.FileChannel.open(directory.toPath(), java.nio.file.StandardOpenOption.READ).use { it.force(true) }
        }
        fun persist(blobs: Map<String, String>, directory: File): Map<String, String> {
            if (blobs is GraphBlobs && blobs.directory == directory.absoluteFile) return blobs
            for (hash in blobs.keys) {
                val source = (blobs as? GraphBlobs)?.sources?.get(hash)
                if (source is Source.Stored && source.file.absoluteFile == File(directory, hash).absoluteFile) continue
                open(blobs, hash).use { put(directory, hash, it) }
            }
            syncDirectory(directory)
            return files(directory, blobs.keys)
        }
    }
}
