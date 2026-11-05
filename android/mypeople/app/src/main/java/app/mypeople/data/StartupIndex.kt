package app.mypeople.data

import java.io.*
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.security.MessageDigest

/** Tiny, disposable, read-only address-book index. It is NEVER used as edit/backup authority.
 * A committed checkpoint/journal signature binds it to the exact source state. A crash before
 * the index update or switching collections invalidates it rather than showing an older book.
 */
internal class StartupIndex(private val directory: File) {
    private val file = File(directory, "startup.idx")
    private val magic = "SHRQIDX1".toByteArray(Charsets.US_ASCII)
    private fun hash(bytes: ByteArray, size: Int = bytes.size) = MessageDigest.getInstance("SHA-256").run { update(bytes, 0, size); digest() }
    private fun signature(): ByteArray? {
        val checkpoint = File(directory, "store.bin")
        if (!checkpoint.isFile || checkpoint.length() < 32) return null
        val journal = File(directory, "store.journal")
        fun tail(path: File): ByteArray = if (path.length() < 32) ByteArray(32) else RandomAccessFile(path, "r").use { f ->
            f.seek(f.length() - 32); ByteArray(32).also(f::readFully)
        }
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out -> out.write(tail(checkpoint)); out.writeLong(journal.length()); out.write(tail(journal)) }
        return bytes.toByteArray()
    }
    private fun DataOutputStream.string(value: String) { val bytes = value.toByteArray(Charsets.UTF_8); require(bytes.size <= 1024 * 1024); writeInt(bytes.size); write(bytes) }
    private fun DataInputStream.string(): String { val size = readInt(); require(size in 0..(1024 * 1024) && size <= available()); return ByteArray(size).also(::readFully).toString(Charsets.UTF_8) }
    private fun DataInputStream.count(): Int = readInt().also { require(it in 0..100_000 && it <= available()) }
    private fun DataOutputStream.strings(values: List<String>) { writeInt(values.size); values.forEach { string(it) } }
    private fun DataInputStream.strings(): List<String> = List(count()) { string() }

    fun read(): Records? = runCatching {
        if (!file.isFile || file.length() !in 112L..(16L * 1024 * 1024)) return null
        val expected = signature() ?: return null
        val bytes = file.readBytes()
        require(hash(bytes, bytes.size - 32).contentEquals(bytes.copyOfRange(bytes.size - 32, bytes.size)))
        val input = DataInputStream(ByteArrayInputStream(bytes, 0, bytes.size - 32))
        require(ByteArray(8).also(input::readFully).contentEquals(magic))
        require(ByteArray(expected.size).also(input::readFully).contentEquals(expected))
        val people = LinkedHashMap<Int, Person>()
        repeat(input.count()) {
            val id = input.readInt(); val name = input.string(); val uid = input.string()
            val redirects = input.strings(); val aliases = input.strings()
            val photo = if (input.readBoolean()) input.string() else null
            val favorite = input.readBoolean(); val trash = input.readBoolean(); val closeness = input.readDouble(); val detail = input.string()
            require(id !in people)
            people[id] = Person(name, uid, redirects,
                ContactCard(name, fields = if (detail.isEmpty()) emptyList() else listOf(ContactField("preview", detail)), favorite = favorite),
                trashed = trash, aliases = aliases, photo = photo, closeness = closeness)
        }
        require(input.available() == 0)
        Records(people = people)
    }.getOrNull()

    fun save(records: Records) {
        val source = signature() ?: return
        require(records.people.size <= 100_000)
        val bytes = ByteArrayOutputStream()
        DataOutputStream(bytes).use { out ->
            out.write(magic); out.write(source); out.writeInt(records.people.size)
            for ((id, person) in records.people) {
                out.writeInt(id); out.string(person.name); out.string(person.contact_uid)
                out.strings(person.contact_aliases); out.strings(person.aliases)
                out.writeBoolean(person.photo != null); person.photo?.let { out.string(it) }
                out.writeBoolean(person.card?.favorite == true); out.writeBoolean(person.trashed); out.writeDouble(person.closeness)
                val detail = listOfNotNull(person.card?.title, person.card?.organization).filter { it.isNotBlank() }.joinToString(" · ")
                    .ifBlank { person.contactFields().firstOrNull()?.value.orEmpty() }
                out.string(detail.take(512))
            }
        }
        require(bytes.size() < 16 * 1024 * 1024)
        val data = bytes.toByteArray()
        directory.mkdirs()
        val tmp = File(directory, "startup.idx.tmp")
        FileOutputStream(tmp).use { stream -> stream.write(data); stream.write(hash(data)); stream.fd.sync() }
        Files.move(tmp.toPath(), file.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
    }
}
