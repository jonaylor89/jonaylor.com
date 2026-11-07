package app.mypeople.data

import android.content.Context
import java.io.File
import java.io.FileOutputStream
import java.util.UUID

/** Complete encrypted recovery stays on the device, outside the repo. Never print its key. */
internal fun verifiedMaintenanceRecovery(context: Context, state: DiskState, kind: String, plan: String): File {
    require(kind.matches(Regex("[a-z-]+")))
    val directory = File(context.filesDir, "maintenance-recovery/${System.currentTimeMillis()}-$kind-${UUID.randomUUID()}").apply { check(mkdirs()) }
    val key = java.util.Base64.getEncoder().encodeToString(ByteArray(32).also { java.security.SecureRandom().nextBytes(it) })
    maintenanceWrite(File(directory, "key"), key)
    maintenanceWrite(File(directory, "plan.json"), plan)
    val archive = File(directory, "before.sherloq")
    val blobs = File(context.filesDir, "memory/graph-blobs")
    val photos = File(context.filesDir, "offline-photos").listFiles().orEmpty()
        .filter { it.isFile && Regex("[0-9a-f]{64}").matches(it.name) }.associateBy { it.name }
    FileOutputStream(archive).use { file ->
        LargeArchive.writeBackup(ContactBackup(state = state, peopleFirst = Settings(context).peopleFirst), photos, file, key, context.cacheDir, blobs)
        file.fd.sync()
    }
    val verified = LargeArchive.read(archive, key, context.cacheDir, blobs).backup!!
    val expected = requireNotNull(state.graph).bundle
    val actual = requireNotNull(verified.state.graph).bundle
    require(actual.collection == expected.collection && actual.heads == expected.heads &&
        actual.commits.map { it.id } == expected.commits.map { it.id } &&
        actual.commits.sumOf { it.operations.size } == expected.commits.sumOf { it.operations.size } &&
        actual.blobs.keys == expected.blobs.keys && verified.state.pending == state.pending) { "Recovery verification failed" }
    GraphBlobs.syncDirectory(directory)
    return directory
}

internal fun maintenanceWrite(file: File, text: String) {
    FileOutputStream(file).use { it.write(text.toByteArray()); it.fd.sync() }
}
