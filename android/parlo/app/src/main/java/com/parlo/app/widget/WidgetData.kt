package com.parlo.app.widget

import com.parlo.app.data.db.SessionEntity
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.data.db.VocabStatus
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LiveSessionState
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId

/** Everything the home-screen widgets show. Only stored counts and dates; nothing estimated. */
data class WidgetData(
    val next: NextWalk = NextWalk(),
    val live: LiveWalk? = null,
    val reviewWords: List<ReviewWord> = emptyList(),
    val week: List<WeekDay> = emptyList(),
    /** A walk can start straight from the widget (key, model and a finished first walk). */
    val canStartDirect: Boolean = false,
    val dynamicColor: Boolean = false,
)

data class NextWalk(val title: String = "Your first walk", val subtitle: String = "", val suggested: Boolean = false)

data class LiveWalk(val startedAtMs: Long, val words: Int, val muted: Boolean, val connecting: Boolean, val ending: Boolean)

data class ReviewWord(val id: Long, val word: String, val translation: String, val example: String)

data class WeekDay(val date: LocalDate, val minutes: Int, val walks: Int, val words: Int)

object WidgetDataBuilder {
    fun build(
        sessions: List<SessionEntity>,
        vocab: List<VocabEntity>,
        live: LiveSessionState,
        language: String,
        hasKey: Boolean,
        hasModel: Boolean,
        dynamicColor: Boolean,
        now: Long = System.currentTimeMillis(),
        zone: ZoneId = ZoneId.systemDefault(),
    ): WidgetData {
        val finished = sessions.filter { it.endedAt != null }
        return WidgetData(
            next = nextWalk(finished, language),
            live = liveWalk(live),
            reviewWords = vocab.filter { it.status == VocabStatus.KEPT.name }.sortedByDescending { it.savedAt }
                .map { ReviewWord(it.id, it.word, it.translation, it.exampleSentence) },
            week = week(finished, vocab, now, zone),
            canStartDirect = hasKey && hasModel && finished.isNotEmpty(),
            dynamicColor = dynamicColor,
        )
    }

    fun nextWalk(finished: List<SessionEntity>, language: String): NextWalk {
        if (finished.isEmpty()) return NextWalk(subtitle = "Your tutor asks what you want to learn")
        val last = finished.maxBy { it.startedAt }
        val title = last.nextWalkTitle?.takeIf { it.isNotBlank() }
        return if (title != null) NextWalk(title, last.focus.orEmpty().let { if (it.isBlank()) language else "Practise: $it" }, suggested = true)
        else NextWalk("Free conversation", language)
    }

    fun liveWalk(s: LiveSessionState): LiveWalk? {
        if (!s.isActive) return null
        return LiveWalk(
            startedAtMs = s.sessionStartMs,
            words = s.caughtWords.size,
            muted = s.muted,
            connecting = s.connection == ConnectionState.CONNECTING,
            ending = s.connection == ConnectionState.ENDING || s.recapInProgress,
        )
    }

    /** The last 7 days, oldest first. */
    fun week(finished: List<SessionEntity>, vocab: List<VocabEntity>, now: Long, zone: ZoneId): List<WeekDay> {
        val today = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
        fun day(ms: Long) = Instant.ofEpochMilli(ms).atZone(zone).toLocalDate()
        val byDay = finished.groupBy { day(it.startedAt) }
        val wordsByDay = vocab.filter { it.status == VocabStatus.KEPT.name }.groupingBy { day(it.savedAt) }.eachCount()
        return (6 downTo 0).map { back ->
            val d = today.minusDays(back.toLong())
            val walks = byDay[d].orEmpty()
            WeekDay(d, (walks.sumOf { it.durationMs } / 60_000L).toInt(), walks.size, wordsByDay[d] ?: 0)
        }
    }
}
