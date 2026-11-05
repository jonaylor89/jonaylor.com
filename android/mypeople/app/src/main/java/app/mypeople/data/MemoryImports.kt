package app.mypeople.data

import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** One import or restore at a time, so that neither can overwrite the other's result. */
class MemoryImports(private val store: Store) {
    private val mutex = Mutex()
    suspend fun <T> exclusive(block: suspend () -> T): T = mutex.withLock { block() }
    suspend fun install(snapshot: TransferManifest) = exclusive { store.installOffline(snapshot) }
}
