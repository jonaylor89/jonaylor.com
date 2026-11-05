package app.mypeople.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.runBlocking

/** Android cancels AbstractThreadedSyncAdapter by interrupting its thread.
 * runBlocking throws that InterruptedException OUTSIDE its coroutine body. Catching
 * only inside the body kills the whole app, including its foreground activity.
 */
internal fun runContactsSyncTask(authFailure: () -> Unit, ioFailure: () -> Unit, task: suspend () -> Unit) {
    try {
        runBlocking { task() }
    } catch (_: InterruptedException) {
        Thread.currentThread().interrupt()
    } catch (_: CancellationException) {
        // Cancellation is neither a failed sync nor a process-level crash.
    } catch (_: SecurityException) {
        authFailure()
    } catch (_: Exception) {
        ioFailure()
    }
}
