package com.parlo.app.gemini

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Job
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.coroutines.coroutineContext

/**
 * Serialises tool side effects without suspending the socket's audio/event collector.
 * Owned and called on the service scope; cancellation never sends a stale tool response.
 */
class LiveToolDispatcher(
    private val scope: CoroutineScope,
    private val model: () -> String,
    private val handle: suspend (FunctionCall) -> FunctionResponse,
    private val respond: (FunctionResponse) -> Unit,
) {
    private val mutex = Mutex()
    private val jobs = mutableMapOf<Job, String?>()

    fun dispatch(calls: List<FunctionCall>) {
        // Capture capabilities now: reconnects may select another model before a tool finishes.
        val async = LiveModelCapabilities.supportsAsyncTools(model())
        calls.forEach { call ->
            lateinit var job: Job
            job = scope.launch(start = CoroutineStart.LAZY) {
                try {
                    mutex.withLock {
                        val response = try {
                            handle(call)
                        } catch (e: CancellationException) {
                            throw e
                        } catch (_: Exception) {
                            FunctionResponse(call.id, call.name, buildJsonObject { put("error", "Could not complete tool") })
                        }
                        coroutineContext.ensureActive()
                        respond(
                            if (async && call.name in LiveModelCapabilities.backgroundTools) {
                                response.copy(scheduling = "SILENT")
                            } else response,
                        )
                    }
                } finally {
                    jobs.remove(job)
                }
            }
            jobs[job] = call.id
            job.start()
        }
    }

    fun cancel(ids: List<String>) {
        jobs.filterValues { it in ids }.keys.toList().forEach { it.cancel() }
    }

    fun clear() {
        jobs.keys.toList().forEach { it.cancel() }
        jobs.clear()
    }
}
