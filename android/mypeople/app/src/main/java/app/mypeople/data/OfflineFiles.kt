package app.mypeople.data

import android.content.Context
import android.net.Uri
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.FileOutputStream
import java.nio.file.Files
import java.nio.file.StandardCopyOption

class OfflineFiles(private val context: Context, private val store: Store, private val imports: MemoryImports, private val settings: Settings) {
    private val photos = File(context.filesDir, "offline-photos")
    fun photo(hash: String): File {
        require(Regex("[0-9a-f]{64}").matches(hash)) { "Invalid photo reference." }
        return File(photos, hash)
    }
    fun savePhoto(hash: String, bytes: ByteArray) {
        require(BackupArchive.hash(bytes) == hash) { "Damaged photo." }
        photos.mkdirs(); atomicWrite(photo(hash), bytes)
    }

    suspend fun importMemory(uri: Uri, password: String, expectedSource: String? = null) = withContext(Dispatchers.IO) {
        val encrypted = context.contentResolver.openInputStream(uri)?.use { Transfer.readLimited(it, Transfer.MAX_FILE) }
            ?: throw IllegalArgumentException("Couldn’t open that memory file.")
        fun timed(stage: String, start: Long) {
            if (context.applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0)
                android.util.Log.i("MyPeopleBluetooth", "$stage=${(System.nanoTime() - start) / 1_000_000}ms")
        }
        var start = System.nanoTime()
        val plain = Transfer.decrypt(encrypted, password)
        timed("decrypt", start); start = System.nanoTime()
        val snapshot = Transfer.unpack(plain) { hash, bytes ->
            photos.mkdirs()
            val destination = File(photos, hash)
            if (!destination.exists()) atomicWrite(destination, bytes)
        }
        timed("archive", start)
        require(expectedSource == null || snapshot.source == expectedSource) { "This memory doesn’t match the Mac in the QR." }
        start = System.nanoTime()
        imports.install(snapshot)
        timed("commit", start)
        // App-private, excluded from backups, never saved UI state.
        // Retaining this lets tomorrow's edits use the same Mac's transfer key.
        settings.transferPassword = password
    }

    suspend fun bluetoothEdits(source: String, password: String, publisher: String? = null): ByteArray = withContext(Dispatchers.IO) {
        // Export is a read, not an acknowledgment: even sent edits stay durable.
        Transfer.encrypt(Transfer.pack(withPhotos(store.bluetoothEdits(source, publisher))), password)
    }

    suspend fun editsFile(): File = withContext(Dispatchers.IO) {
        val password = settings.transferPassword
        require(password.isNotEmpty()) { "Import a memory file to pair this phone with your Mac first." }
        val manifest = withPhotos(store.exportOffline())
        val directory = File(context.cacheDir, "transfers").apply { mkdirs() }
        directory.listFiles()?.filter { it.lastModified() < System.currentTimeMillis() - 86_400_000 }?.forEach { it.delete() }
        val destination = File(directory, "MyPeople-edits-${System.currentTimeMillis()}.sherloq")
        atomicWrite(destination, Transfer.encrypt(Transfer.pack(manifest), password))
        destination
    }

    private fun withPhotos(manifest: TransferManifest): TransferManifest = manifest.copy(photo_hashes = photos.listFiles().orEmpty().filter { it.isFile && Regex("[a-f0-9]{64}").matches(it.name) }.map { it.name }.sorted())

    private fun atomicWrite(destination: File, bytes: ByteArray) {
        val temp = File.createTempFile(".transfer-", ".tmp", destination.parentFile)
        try {
            FileOutputStream(temp).use { stream -> stream.write(bytes); stream.fd.sync() }
            Files.move(temp.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { temp.delete() }
    }
}
