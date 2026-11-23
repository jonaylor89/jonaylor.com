package com.paperclock.widget

import com.paperclock.data.AlarmEntity
import java.util.Calendar
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class WidgetScheduleTest {
    private fun monday(hour: Int, minute: Int) = Calendar.getInstance().apply {
        clear()
        set(2026, Calendar.JUNE, 1, hour, minute, 0)
    }

    private fun alarm(repeats: String = "") =
        AlarmEntity(hour = 7, minute = 0, repeatDays = repeats, soundKey = "beep_beep_beep")

    @Test fun beforeAlarmStillUsesToday() {
        val now = monday(6, 59)
        assertEquals(monday(7, 0).timeInMillis, nextOccurrence(alarm(), now).timeInMillis)
    }

    @Test fun firedOneShotMovesToTomorrow() {
        val now = monday(7, 0)
        val next = nextOccurrence(alarm(), now)
        assertTrue(next.timeInMillis > now.timeInMillis)
        assertEquals(2, next.get(Calendar.DAY_OF_MONTH))
        assertEquals(7, now.get(Calendar.HOUR_OF_DAY))
    }

    @Test fun firedWeeklyAlarmMovesToNextWeek() {
        val now = monday(7, 1)
        val next = nextOccurrence(alarm(Calendar.MONDAY.toString()), now)
        assertEquals(8, next.get(Calendar.DAY_OF_MONTH))
        assertTrue(next.timeInMillis > now.timeInMillis)
    }

    @Test fun weekdaysSkipTheWeekend() {
        val friday = monday(8, 0).apply { add(Calendar.DAY_OF_YEAR, 4) }
        val next = nextOccurrence(alarm("2,3,4,5,6"), friday)
        assertEquals(Calendar.MONDAY, next.get(Calendar.DAY_OF_WEEK))
        assertEquals(8, next.get(Calendar.DAY_OF_MONTH))
    }
}
