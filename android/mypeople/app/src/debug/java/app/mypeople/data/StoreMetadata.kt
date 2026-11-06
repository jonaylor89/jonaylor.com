package app.mypeople.data

import java.io.DataInputStream
import java.io.File
import java.security.MessageDigest
import kotlinx.serialization.json.*

/** Read-only, aggregate-only diagnosis via dalvikvm/run-as. Never starts the app,
 * reduces history, repairs a journal, or prints identities, contents or payloads. */
object StoreMetadata {
    @JvmStatic fun main(args: Array<String>) {
        try {
            val directory = File(args.single())
            require(directory.name == "memory")
            val snapshot = StoreCheckpoint.snapshot(File(directory, "store.bin").readBytes())
            val state = snapshot.state
            var graph = state.graph != null
            var replica = state.replica.enabled
            var changes = state.replica.changes.size
            var frames = 0
            val journal = File(directory, "store.journal")
            if (journal.exists()) DataInputStream(journal.inputStream()).use { input ->
                while (input.available() > 0) {
                    val size = input.readInt()
                    require(size in 1..(128 * 1024 * 1024))
                    val bytes = ByteArray(size).also(input::readFully)
                    val checksum = ByteArray(32).also(input::readFully)
                    require(MessageDigest.getInstance("SHA-256").digest(bytes).contentEquals(checksum))
                    val patch = json.parseToJsonElement(bytes.toString(Charsets.UTF_8)).jsonObject
                    if (patch.getValue("journalSequence").jsonPrimitive.long <= state.journalSequence) continue
                    if ("graph_delta" in patch) graph = true
                    if ("graph" in patch) graph = patch["graph"] != JsonNull
                    (patch["replica"] as? JsonObject)?.get("enabled")?.jsonPrimitive?.boolean?.let { replica = it }
                    (patch["replica_changes"] as? JsonArray)?.let {
                        changes = (if (patch["replica_reset"]?.jsonPrimitive?.boolean == true) 0 else changes) + it.size
                    }
                    frames++
                }
            }
            println("StoreMetadata graph=$graph legacyReplica=$replica legacyChanges=$changes checkpointPeople=${state.records.people.size} cachedPeople=${snapshot.view?.people?.size ?: 0} pending=${state.pending.size} replayedFrames=$frames")
        } catch (error: Exception) {
            System.err.println("StoreMetadata read failed: ${error.javaClass.simpleName}")
            kotlin.system.exitProcess(1)
        }
    }
}
