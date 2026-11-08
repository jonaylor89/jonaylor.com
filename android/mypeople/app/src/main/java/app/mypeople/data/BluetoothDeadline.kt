package app.mypeople.data

import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong

/** Import is local durable work, not a stalled radio read. Keep it bounded but allow
 * large graph commits to finish; keepalive writes never extend this hard limit. */
internal class BluetoothDeadline(private val clock: () -> Long = System::nanoTime) {
    private val limit = AtomicLong(clock() + TimeUnit.SECONDS.toNanos(60))
    fun progress() { limit.set(clock() + TimeUnit.SECONDS.toNanos(60)) }
    fun waitingForMac() { limit.set(clock() + TimeUnit.MINUTES.toNanos(20)) }
    fun importing() { limit.set(clock() + TimeUnit.MINUTES.toNanos(20)) }
    fun confirming() { limit.set(clock() + TimeUnit.SECONDS.toNanos(15)) }
    fun expired() = clock() > limit.get()
}
