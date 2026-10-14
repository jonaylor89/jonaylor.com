package com.parlo.app.widget

import com.parlo.app.data.db.SessionEntity
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.data.db.VocabStatus
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LiveSessionState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.LocalDate
import java.time.ZoneOffset

class WidgetDataTest {
    private val zone = ZoneOffset.UTC
    private val now = LocalDate.of(2026, 10, 14).atTime(18, 0).toInstant(zone).toEpochMilli()
    private fun daysAgo(d: Long) = now - d * 86_400_000L

    private fun session(start: Long, minutes: Long, title: String? = null, focus: String? = null) = SessionEntity(
        startedAt = start, endedAt = start + minutes * 60_000, language = "Spanish", dialect = "", level = "Beginner",
        scenario = "", correctionStyle = "", durationMs = minutes * 60_000, nextWalkTitle = title, focus = focus,
    )

    private fun word(id: Long, at: Long, status: VocabStatus = VocabStatus.KEPT) =
        VocabEntity(id = id, word = "w$id", translation = "t$id", exampleSentence = "", language = "Spanish", savedAt = at, status = status.name)

    @Test fun `first run has no suggestion and cannot start from the widget`() {
        val d = WidgetDataBuilder.build(emptyList(), emptyList(), LiveSessionState(), "Spanish", hasKey = true, hasModel = true, dynamicColor = false, now = now, zone = zone)
        assertEquals("Your first walk", d.next.title)
        assertFalse(d.next.suggested)
        assertFalse(d.canStartDirect)
    }

    @Test fun `suggestion comes from the latest finished walk`() {
        val s = listOf(session(daysAgo(2), 10, "Old"), session(daysAgo(1), 12, "Haggling at the market", "fui vs ha ido"))
        val d = WidgetDataBuilder.build(s, emptyList(), LiveSessionState(), "Spanish", true, true, false, now, zone)
        assertEquals("Haggling at the market", d.next.title)
        assertEquals("Practise: fui vs ha ido", d.next.subtitle)
        assertTrue(d.canStartDirect)
    }

    @Test fun `needs key and model to start directly`() {
        val s = listOf(session(daysAgo(1), 5))
        assertFalse(WidgetDataBuilder.build(s, emptyList(), LiveSessionState(), "Spanish", false, true, false, now, zone).canStartDirect)
        assertFalse(WidgetDataBuilder.build(s, emptyList(), LiveSessionState(), "Spanish", true, false, false, now, zone).canStartDirect)
    }

    @Test fun `week counts only real minutes walks and kept words`() {
        val s = listOf(session(daysAgo(0), 12), session(daysAgo(0), 3), session(daysAgo(3), 20), session(daysAgo(9), 30))
        val v = listOf(word(1, daysAgo(0)), word(2, daysAgo(0)), word(3, daysAgo(3), VocabStatus.SUGGESTED))
        val week = WidgetDataBuilder.week(s, v, now, zone)
        assertEquals(7, week.size)
        assertEquals(LocalDate.of(2026, 10, 14), week.last().date)
        assertEquals(15, week.last().minutes); assertEquals(2, week.last().walks); assertEquals(2, week.last().words)
        assertEquals(20, week[3].minutes); assertEquals(0, week[3].words)
        assertEquals(35, week.sumOf { it.minutes })
    }

    @Test fun `live walk only while active`() {
        assertNull(WidgetDataBuilder.liveWalk(LiveSessionState()))
        val live = WidgetDataBuilder.liveWalk(LiveSessionState(connection = ConnectionState.CONNECTED, sessionStartMs = 5, muted = true, caughtWords = listOf("a", "b")))!!
        assertEquals(2, live.words); assertTrue(live.muted); assertFalse(live.connecting)
    }

    @Test fun `review rotates through kept words newest first`() {
        val words = WidgetDataBuilder.build(emptyList(), listOf(word(1, 1), word(2, 3), word(3, 2, VocabStatus.SUGGESTED)), LiveSessionState(), "Spanish", true, true, false, now, zone).reviewWords
        assertEquals(listOf(2L, 1L), words.map { it.id })
        assertEquals(2L, ReviewWordWidget.current(words, null)?.id)
        assertEquals(2L, ReviewWordWidget.current(words, 99)?.id)
        assertEquals(1L, ReviewWordWidget.next(words, 2)?.id)
        assertEquals(2L, ReviewWordWidget.next(words, 1)?.id)
    }
}
