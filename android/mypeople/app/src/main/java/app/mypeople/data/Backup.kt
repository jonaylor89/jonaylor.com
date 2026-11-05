package app.mypeople.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.encodeToString
import okhttp3.Request
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.security.MessageDigest
import java.util.zip.ZipEntry
import java.util.zip.ZipInputStream
import java.util.zip.ZipOutputStream

@Serializable
data class ContactBackup(val format: Int = 1, val state: DiskState, val serverOrigin: String = "", val peopleFirst: Boolean = true)

/** Authenticated, versioned, bounded full phone backup. No OAuth/device/transfer secrets. */
object BackupArchive {
    fun hash(bytes: ByteArray) = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    fun encode(backup: ContactBackup, photos: Map<String, ByteArray>, passphrase: String): ByteArray {
        val manifest = json.encodeToString(backup).toByteArray()
        require(manifest.size <= 64 * 1024 * 1024 && photos.size <= 10000 && backup.state.pending.size <= 10000) { "Backup exceeds supported recovery limits." }
        require(manifest.size.toLong() + photos.values.sumOf { it.size.toLong() } <= 256 * 1024 * 1024) { "Backup is too large." }
        val out = ByteArrayOutputStream()
        ZipOutputStream(out).use { zip ->
            zip.putNextEntry(ZipEntry("backup.json")); zip.write(manifest); zip.closeEntry()
            for ((hash, bytes) in photos) {
                require(hash(bytes) == hash && bytes.size <= 10 * 1024 * 1024) { "Damaged photo." }
                zip.putNextEntry(ZipEntry("photos/$hash")); zip.write(bytes); zip.closeEntry()
            }
        }
        require(out.size() <= Transfer.MAX_FILE) { "Backup is too large." }
        return Transfer.encrypt(out.toByteArray(), passphrase)
    }
    fun decode(bytes: ByteArray, passphrase: String): Pair<ContactBackup, Map<String, ByteArray>> {
        val photos = mutableMapOf<String, ByteArray>(); var backup: ContactBackup? = null
        var total = 0L; val names = mutableSetOf<String>()
        ZipInputStream(ByteArrayInputStream(Transfer.decrypt(bytes, passphrase))).use { zip ->
            while (true) {
                val e = zip.nextEntry ?: break
                require(names.add(e.name) && names.size <= 10001 && !e.isDirectory) { "Invalid backup archive." }
                require(e.name == "backup.json" || Regex("photos/[a-f0-9]{64}").matches(e.name)) { "Unsafe backup path." }
                val data = Transfer.readLimited(zip, if (e.name == "backup.json") 64 * 1024 * 1024 else 10 * 1024 * 1024)
                total += data.size; require(total <= 256 * 1024 * 1024) { "Backup is too large." }
                if (e.name == "backup.json") backup = json.decodeFromString<ContactBackup>(data.toString(Charsets.UTF_8))
                else { val h = e.name.substringAfter('/'); require(hash(data) == h) { "Damaged photo." }; photos[h] = data }
            }
        }
        val b = requireNotNull(backup) { "Not a full MyPeople backup." }
        require(b.format == 1 && b.state.pending.size <= 10000 && b.state.records.people.size <= 100000) { "Unsupported backup." }
        require(b.serverOrigin.isEmpty() || validateServerUrl(b.serverOrigin) == null) { "Invalid backup origin." }
        b.state.records.people.values.forEach { it.card?.validate() }
        if (b.state.replica.enabled) ContactHistory(b.state.replica.changes)
        require(b.state.replica.localIds.values.all { it < 0 } && b.state.replica.localIds.values.distinct().size == b.state.replica.localIds.size) { "Invalid replica identity map." }
        b.state.pending.forEach { require(it.kind in opKinds); java.util.UUID.fromString(it.client_id) }
        require(b.state.records.people.values.mapNotNull { it.photo }.all { it in photos }) { "Backup is missing photos." }
        return b to photos
    }
}

class Backups(private val context: Context, private val graph: app.mypeople.AppGraph) {
    suspend fun export(uri: Uri, passphrase: String) = withContext(Dispatchers.IO) {
        val disk = graph.store.snapshot(); val photos = mutableMapOf<String, ByteArray>()
        for (hash in disk.records.people.values.mapNotNull { it.photo }.distinct()) {
            require(Regex("[a-f0-9]{64}").matches(hash)) { "Invalid photo reference." }
            val file = graph.offline.photo(hash)
            val cached = if (!file.exists()) graph.imageLoader.diskCache?.openSnapshot(graph.api.photoUrl(hash))?.use { snapshot -> File(snapshot.data.toString()).inputStream().use { Transfer.readLimited(it, 10 * 1024 * 1024) } } else null
            val bytes = if (file.exists()) file.inputStream().use { Transfer.readLimited(it, 10 * 1024 * 1024) } else if (cached != null && BackupArchive.hash(cached) == hash) cached else {
                require(graph.settings.configured) { "Connect to the photo server before making a full backup." }
                graph.client.newCall(Request.Builder().url(graph.api.photoUrl(hash)).build()).execute().use { response ->
                    require(response.isSuccessful) { "A photo could not be backed up. Try again online." }
                    Transfer.readLimited(response.body.byteStream(), 10 * 1024 * 1024)
                }
            }
            require(BackupArchive.hash(bytes) == hash) { "Damaged cached photo." }; photos[hash] = bytes
            if (!file.exists()) graph.offline.savePhoto(hash, bytes)
        }
        val bytes = BackupArchive.encode(ContactBackup(state = disk, serverOrigin = graph.settings.serverUrl, peopleFirst = graph.settings.peopleFirst), photos, passphrase)
        requireNotNull(context.contentResolver.openOutputStream(uri, "wt")) { "Could not open backup destination." }.use { it.write(bytes) }
    }
    suspend fun restore(uri: Uri, passphrase: String) = graph.sync.exclusive {
        graph.deviceContacts.exclusive {
        withContext(Dispatchers.IO) {
            val bytes = requireNotNull(context.contentResolver.openInputStream(uri)).use { Transfer.readLimited(it, Transfer.MAX_FILE) }
            val (backup, photos) = BackupArchive.decode(bytes, passphrase)
            // Validate the whole archive first. Content-addressed files are harmless if a later disk write fails.
            photos.forEach { (hash, data) -> graph.offline.savePhoto(hash, data) }
            require(graph.store.snapshot().pending.isEmpty()) { "Sync pending edits before restoring." }
            graph.settings.prepareRestore(backup.serverOrigin, backup.peopleFirst)
            graph.store.restoreBackup(backup.state)
        }
        }
    }
}
