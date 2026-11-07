package app.mypeople.data

import java.io.File
import java.io.InputStream
import java.util.Base64

internal interface StoredBlobs : Map<String,String> { val blobDirectory: File }

/** A persisted inventory. Neither open nor editing scans/decodes every blob. Each
 * actual byte read/export still verifies the content-addressed hash. */
internal class DatabaseBlobs(private val database: IndexedGraphDatabase, private val sequence: Long) : AbstractMap<String,String>(), StoredBlobs {
    override val blobDirectory get() = database.blobDirectory
    override val size get() = database.scalar("SELECT count(*) FROM blob_catalog WHERE born<=?",listOf(sequence))!!.toInt()
    override fun containsKey(key: String) = database.scalar("SELECT 1 FROM blob_catalog WHERE hash=? AND born<=?",listOf(key,sequence)) != null
    override val keys: Set<String> by lazy { database.sql.query("SELECT hash FROM blob_catalog WHERE born<=? ORDER BY hash",listOf(sequence)).map { it[0]!! }.toSet() }
    override fun get(key: String): String? {
        if (!containsKey(key)) return null
        val bytes = File(blobDirectory,key).readBytes()
        require(GraphStore.digest(bytes) == key) { "Damaged graph blob" }
        return Base64.getEncoder().encodeToString(bytes)
    }
    override val entries: Set<Map.Entry<String,String>> get() = object : AbstractSet<Map.Entry<String,String>>() {
        override val size get() = this@DatabaseBlobs.size
        override fun iterator(): Iterator<Map.Entry<String,String>> = keys.asSequence().map { key -> object : Map.Entry<String,String> {
            override val key = key
            override val value get() = this@DatabaseBlobs[key]!!
            override fun equals(other: Any?) = other is Map.Entry<*,*> && key == other.key && value == other.value
            override fun hashCode() = key.hashCode() xor value.hashCode()
        } }.iterator()
    }
}
