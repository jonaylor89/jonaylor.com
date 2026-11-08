package app.mypeople.data

import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class BluetoothDeadlineTest {
    @Test fun durableImportCanExceedTwoMinutesButStillHasAHardDeadline() {
        var now=0L
        val deadline=BluetoothDeadline { now }
        deadline.importing()
        now=TimeUnit.SECONDS.toNanos(192)
        assertFalse(deadline.expired())
        now=TimeUnit.MINUTES.toNanos(20)+1
        assertTrue(deadline.expired())
    }
    @Test fun stalledRadioAndFinalConfirmationStillTimeoutPromptly() {
        var now=0L
        val deadline=BluetoothDeadline { now }
        now=TimeUnit.SECONDS.toNanos(61)
        assertTrue(deadline.expired())
        deadline.progress()
        assertFalse(deadline.expired())
        deadline.confirming()
        now+=TimeUnit.SECONDS.toNanos(16)
        assertTrue(deadline.expired())
    }
}
