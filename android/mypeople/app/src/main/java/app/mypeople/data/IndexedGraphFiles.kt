package app.mypeople.data

import android.os.Build
import java.io.File
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import java.util.UUID

/** Conversion publishes a fully committed directory atomically. Original checkpoint,
 * journal and immutable blobs are retained; a failed conversion never replaces them. */
internal object IndexedGraphFiles {
    fun supported() = Build.VERSION.SDK_INT >= 29
    fun directory(memory: File) = File(memory,"indexed-graph")
    fun exists(memory: File) = directory(memory).exists()
    fun open(memory: File): IndexedGraphDatabase {
        val dir = directory(memory)
        require(File(dir,"graph.sqlite").isFile) { "Incomplete indexed Store; recovery data was retained." }
        val db = IndexedGraphDatabase(AndroidGraphSql(File(dir,"graph.sqlite")),File(memory,"graph-blobs"))
        require(db.meta("ready") == "1") { "Incomplete indexed Store; recovery data was retained." }
        return db
    }
    fun create(memory: File, state: DiskState, view: Records): IndexedGraphDatabase {
        require(!exists(memory)); memory.mkdirs()
        val temporary = File(memory,".indexed-graph-${UUID.randomUUID()}")
        require(temporary.mkdir())
        try {
            IndexedGraphDatabase(AndroidGraphSql(File(temporary,"graph.sqlite")),File(memory,"graph-blobs")).use { db -> db.importState(state,view) }
            GraphBlobs.syncDirectory(temporary)
            Files.move(temporary.toPath(),directory(memory).toPath(),StandardCopyOption.ATOMIC_MOVE)
            GraphBlobs.syncDirectory(memory)
        } catch (error: Throwable) { temporary.deleteRecursively(); throw error }
        return open(memory)
    }
}
