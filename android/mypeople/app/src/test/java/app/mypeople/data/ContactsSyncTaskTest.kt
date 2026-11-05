package app.mypeople.data

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.awaitCancellation
import org.junit.Assert.*
import org.junit.Test
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

class ContactsSyncTaskTest {
    @Test fun `Android thread interruption cancels sync without an uncaught process crash`() {
        val started = CountDownLatch(1)
        val errors = AtomicInteger()
        val uncaught = AtomicReference<Throwable>()
        var interruptPreserved = false
        val thread = Thread {
            runContactsSyncTask({ errors.incrementAndGet() }, { errors.incrementAndGet() }) {
                started.countDown(); awaitCancellation()
            }
            interruptPreserved = Thread.currentThread().isInterrupted
        }
        thread.uncaughtExceptionHandler = Thread.UncaughtExceptionHandler { _, error -> uncaught.set(error) }
        thread.start()
        assertTrue(started.await(2, TimeUnit.SECONDS))
        thread.interrupt(); thread.join(2000)
        assertFalse(thread.isAlive)
        assertNull(uncaught.get()); assertEquals(0, errors.get()); assertTrue(interruptPreserved)
    }
    @Test fun `ordinary auth and IO errors are reported but cancellation is not an error`() {
        var auth = 0; var io = 0
        runContactsSyncTask({ auth++ }, { io++ }) { throw SecurityException() }
        runContactsSyncTask({ auth++ }, { io++ }) { throw java.io.IOException() }
        runContactsSyncTask({ auth++ }, { io++ }) { throw CancellationException() }
        assertEquals(1, auth); assertEquals(1, io)
    }
}
