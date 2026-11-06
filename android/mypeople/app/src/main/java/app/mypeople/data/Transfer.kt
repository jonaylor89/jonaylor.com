package app.mypeople.data

import kotlinx.serialization.Serializable
import kotlinx.serialization.json.jsonObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.security.MessageDigest
import java.security.SecureRandom
import java.util.UUID
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream
import javax.crypto.Cipher
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.PBEKeySpec
import javax.crypto.spec.SecretKeySpec

@Serializable
data class TransferManifest(
    val format: Int = 1,
    val type: String,
    val source: String,
    val revision: Long = 0,
    val created_at: String = "",
    val records: List<RecordChange> = emptyList(),
    val results: List<OpState> = emptyList(),
    val ops: List<PendingOp> = emptyList(),
    val publisher: String? = null,
    val contact_version: Int = 0,
    val contact_history: List<ContactChange> = emptyList(),
    val contact_heads: List<String> = emptyList(),
    val base_revision: Long? = null,
    val record_hashes: Map<String, String> = emptyMap(),
    val photo_hashes: List<String> = emptyList(),
    val contact_wire: Int = 1,
    val graph: GraphBundle? = null,
)

/** Portable format shared with Python transfer.py. No credentials in filenames or Intents. */
object Transfer {
    private val magic = "SHERLOQ1".toByteArray(Charsets.US_ASCII)
    const val MAX_FILE = 128 * 1024 * 1024
    private const val MAX_EXPANDED = 256 * 1024 * 1024
    private val photoName = Regex("photos/([0-9a-f]{64})")

    fun readLimited(input: InputStream, limit: Int): ByteArray {
        val out = ByteArrayOutputStream()
        val buffer = ByteArray(16384)
        while (true) {
            val n = input.read(buffer)
            if (n < 0) break
            require(out.size().toLong() + n <= limit) { "Transfer exceeds the safe size limit." }
            out.write(buffer, 0, n)
        }
        return out.toByteArray()
    }

    private fun key(password: String, salt: ByteArray): SecretKeySpec {
        require(password.length >= 12 && password.all { it.code < 128 }) { "Enter the transfer passphrase from your Mac (at least 12 characters)." }
        val spec = PBEKeySpec(password.toCharArray(), salt, 200_000, 256)
        return try { SecretKeySpec(SecretKeyFactory.getInstance("PBKDF2WithHmacSHA256").generateSecret(spec).encoded, "AES") }
        finally { spec.clearPassword() }
    }

    fun encrypt(plain: ByteArray, password: String): ByteArray {
        val random = SecureRandom()
        val salt = ByteArray(16).also(random::nextBytes)
        val nonce = ByteArray(12).also(random::nextBytes)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key(password, salt), GCMParameterSpec(128, nonce))
        cipher.updateAAD(magic)
        return (magic + salt + nonce + cipher.doFinal(plain)).also { require(it.size <= MAX_FILE) { "Transfer is too large." } }
    }

    fun decrypt(encrypted: ByteArray, password: String): ByteArray {
        require(encrypted.size in 52..MAX_FILE && encrypted.copyOfRange(0, 8).contentEquals(magic)) { "Not a supported MyPeople transfer file." }
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key(password, encrypted.copyOfRange(8, 24)), GCMParameterSpec(128, encrypted.copyOfRange(24, 36)))
        cipher.updateAAD(magic)
        return try { cipher.doFinal(encrypted, 36, encrypted.size - 36) }
        catch (_: javax.crypto.AEADBadTagException) { throw IllegalArgumentException("Incorrect transfer passphrase or damaged file.") }
    }

    fun unpack(plain: ByteArray, photo: (String, ByteArray) -> Unit = { _, _ -> }): TransferManifest {
        var manifest: TransferManifest? = null
        var graph: GraphBundle? = null
        var total = 0L
        val names = mutableSetOf<String>()
        ZipInputStream(ByteArrayInputStream(plain)).use { zip ->
            while (true) {
                val entry = zip.nextEntry ?: break
                require(names.add(entry.name) && names.size <= 10_000 && !entry.isDirectory) { "Invalid transfer archive." }
                val match = photoName.matchEntire(entry.name)
                require(entry.name in setOf("manifest.json", "graph.json") || match != null) { "Unexpected file in transfer archive." }
                val bytes = readLimited(zip, if (entry.name == "graph.json") MAX_EXPANDED else if (match != null) 10 * 1024 * 1024 else 32 * 1024 * 1024)
                total += bytes.size
                require(total <= MAX_EXPANDED) { "Transfer exceeds the safe size limit." }
                if (entry.name == "graph.json") graph = VersionedGraph.wire.decodeFromString<GraphBundle>(bytes.toString(Charsets.UTF_8))
                else if (match == null) manifest = ContactWire.decode(json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject)
                else {
                    val hash = match.groupValues[1]
                    val actual = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
                    require(actual == hash) { "A photo is damaged." }
                    photo(hash, bytes)
                }
            }
        }
        val result = requireNotNull(manifest) { "No memory manifest in this file." }
        require(result.graph == null) { "Graph must be stored in graph.json" }
        return result.copy(graph = graph).also { validate(it) }
    }

    fun validate(manifest: TransferManifest) {
        require(manifest.format == 1 && manifest.type in setOf("snapshot", "edits")) { "Unsupported transfer format." }
        UUID.fromString(manifest.source)
        manifest.graph?.let { bundle ->
            UUID.fromString(bundle.collection)
            require(bundle.heads.distinct().size == bundle.heads.size)
            bundle.heads.forEach { UUID.fromString(it) }
            // Delta ancestry is validated atomically with the durable local graph on receive.
            require(bundle.commits.all { it.collection == bundle.collection })
        }
        manifest.publisher?.let { UUID.fromString(it) }
        require(manifest.records.size <= 100_000 && manifest.ops.size <= 10_000 && manifest.results.size <= 100_000) { "Transfer contains too many records." }
        require(manifest.records.map { it.kind to it.id }.toSet().size == manifest.records.size) { "Duplicate records in transfer." }
        require(manifest.records.all { it.kind in setOf("person", "event", "profile", "moment", "dupes") && (it.data != null || manifest.base_revision != null) }) { "Invalid snapshot records." }
        require(manifest.contact_version in 0..1 && manifest.contact_history.size <= 100_000 && manifest.contact_heads.size <= 100_000) { "Unsupported contact history." }
        require(manifest.record_hashes.size <= 100_000 && manifest.photo_hashes.size <= 10000) { "Invalid sync inventory." }
        require(manifest.results.all { it.status == "done" || it.status == "failed" }) { "Invalid edit receipt." }
        if (manifest.type == "snapshot") {
            require(manifest.revision > 0) { "Invalid memory revision." }
            Records().applyChanges(manifest.records) // Validate every record before touching the store.
        }
    }

    fun pack(manifest: TransferManifest): ByteArray {
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry("manifest.json"))
            val bytes = ContactWire.encode(manifest.copy(graph = null)).toString().toByteArray(Charsets.UTF_8)
            require(bytes.size <= 32 * 1024 * 1024) { "Transfer manifest exceeds 32 MiB. Contact history has not been truncated." }
            zip.write(bytes)
            zip.closeEntry()
            manifest.graph?.let { graph ->
                zip.putNextEntry(ZipEntry("graph.json"))
                val graphBytes = VersionedGraph.wire.encodeToString(GraphBundle.serializer(), graph).toByteArray(Charsets.UTF_8)
                require(graphBytes.size.toLong() + bytes.size <= MAX_EXPANDED) { "Graph transfer too large; nothing has been truncated." }
                zip.write(graphBytes); zip.closeEntry()
            }
        }
        return out.toByteArray()
    }
}
