package app.mypeople.data

import android.content.Context
import androidx.work.*
import kotlinx.coroutines.*
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.HttpUrl.Companion.toHttpUrlOrNull
import java.io.IOException
import java.util.concurrent.TimeUnit

fun validateServerUrl(raw: String): String? {
    val url = raw.trim().toHttpUrlOrNull() ?: return "Enter a valid HTTPS server URL."
    if (url.scheme != "https" && !(url.scheme == "http" && url.host == "10.0.2.2")) return "Use HTTPS. HTTP is only allowed for 10.0.2.2 in the emulator."
    if (url.username.isNotEmpty() || url.password.isNotEmpty() || url.query != null || url.fragment != null || url.encodedPath != "/") return "Use only the server origin, without a path, credentials, query or fragment."
    return null
}

class Sync(private val settings: Settings, private val api: Api, private val store: Store, private val scope: CoroutineScope) {
    private val mutex = Mutex()
    private var debounce: Job? = null
    fun afterEdit() {
        debounce?.cancel()
        // Cancel only the delay, never an in-flight sync or disk write.
        debounce = scope.launch { delay(650); scope.launch { run() } }
    }
    fun now() { scope.launch { run() } }
    suspend fun <T> exclusive(block: suspend () -> T): T = mutex.withLock { block() }
    suspend fun configure(url: String, token: String) = mutex.withLock {
        validateServerUrl(url)?.let { throw IllegalArgumentException(it) }
        require(token.isNotBlank() && !token.any { it == '\n' || it == '\r' }) { "Enter this phone's device token." }
        if (settings.serverUrl != url.trim().trimEnd('/') || store.state.value.offlineSource != null) store.reset()
        settings.serverUrl = url
        settings.token = token
    }
    suspend fun importOffline(snapshot: TransferManifest) = mutex.withLock {
        store.installOffline(snapshot)
    }
    suspend fun run(): Boolean = mutex.withLock {
        if (!settings.configured) return@withLock true
        try {
            store.initialize()
            if (store.state.value.offlineSource != null) return@withLock true
            store.busy(true)
            withContext(Dispatchers.IO) {
                for (batch in store.unsent().chunked(1)) {
                    val ack = api.sendOps(batch)
                    // Terminal acks are handled through changes, alongside the server view.
                    store.sent(ack.map { it.client_id }.toSet())
                }
                pullChanges(store.cursor(), { api.changes(it) }, { store.receive(it) })
            }
            store.succeeded()
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Do not persist response bodies, URLs with credentials, or record contents.
            store.error(when (e) {
                is ApiException -> e.message ?: "Sync failed."
                is IOException -> "Couldn't reach the server. Check your connection and Tailscale. Edits are saved on this phone."
                else -> "Couldn't read or save sync data. Your outbox has been kept; try again."
            })
            false
        } finally {
            withContext(NonCancellable) { runCatching { store.busy(false) } }
        }
    }
}

class SyncWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {
    override suspend fun doWork(): Result {
        val graph = (applicationContext as app.mypeople.MyPeopleApp).graph
        return if (graph.sync.run()) Result.success() else Result.retry()
    }
    companion object {
        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()
            WorkManager.getInstance(context).enqueueUniquePeriodicWork("sherloq-sync", ExistingPeriodicWorkPolicy.KEEP, request)
        }
    }
}
