package com.parlo.app.model

/** A transparent starter schedule for explicit self-ratings, not an inferred knowledge score. */
object RetrievalSchedule {
    private val days = listOf(1, 3, 7, 14, 30, 60)
    const val DAY = 86_400_000L

    fun next(stage: Int, lastReviewedAt: Long?, remembered: Boolean, now: Long): Pair<Int, Long> {
        val current = stage.coerceIn(days.indices)
        val nextStage = when {
            !remembered -> 0
            lastReviewedAt == null -> 0
            now - lastReviewedAt < DAY -> current // Repeating today isn't delayed recall.
            else -> (current + 1).coerceAtMost(days.lastIndex)
        }
        return nextStage to now + days[nextStage] * DAY
    }
}
