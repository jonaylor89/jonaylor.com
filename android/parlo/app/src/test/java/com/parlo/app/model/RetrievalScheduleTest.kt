package com.parlo.app.model

import org.junit.Assert.assertEquals
import org.junit.Test

class RetrievalScheduleTest {
    @Test fun `introduced or repeated today is not treated as durable knowledge`() {
        assertEquals(0 to RetrievalSchedule.DAY, RetrievalSchedule.next(0, null, true, 0))
        assertEquals(2 to 7 * RetrievalSchedule.DAY + 1000, RetrievalSchedule.next(2, 0, true, 1000))
    }

    @Test fun `delayed retrieval extends intervals while difficulty brings practice forward`() {
        val day = RetrievalSchedule.DAY
        assertEquals(1 to 4 * day, RetrievalSchedule.next(0, 0, true, day))
        assertEquals(0 to 11 * day, RetrievalSchedule.next(4, 0, false, 10 * day))
        assertEquals(5 to 160 * day, RetrievalSchedule.next(5, 0, true, 100 * day))
    }
}
