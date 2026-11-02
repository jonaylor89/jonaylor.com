package com.parlo.app.data

import androidx.room.withTransaction
import kotlinx.coroutines.sync.withLock
import com.parlo.app.data.db.LearnerProfileEntity
import com.parlo.app.data.db.LearningEpisodeEntity
import com.parlo.app.data.db.ParloDatabase
import com.parlo.app.data.db.TurnEntity
import com.parlo.app.gemini.MemoryAnalyzer
import com.parlo.app.model.WalkMemory
import java.time.Instant
import java.time.ZoneOffset
import java.util.Locale

/** Persistent memory belongs to the application, not a model session or a growing prompt. */
class LearningRepository(private val db: ParloDatabase) {
    private val dao = db.learningDao()
    internal val maintenance = kotlinx.coroutines.sync.Mutex()
    val profiles = dao.observeProfiles()
    fun episodes(language: String) = dao.observeEpisodes(key(language))

    suspend fun setGoal(language: String, goal: String) =
        dao.saveProfile(LearnerProfileEntity(key(language), goal.trim().take(500)))

    suspend fun memory(language: String, excludingSession: Long = 0): WalkMemory {
        val k = key(language)
        val recent = dao.recent(k, 4)
        val older = dao.olderPractice(k, System.currentTimeMillis() - 7 * 86_400_000L)
        val turns = db.sessionDao().previousTurns(language, excludingSession, 6).reversed()
        return WalkMemory(
            language = language,
            focus = db.sessionDao().latestReviewed(language)?.focus.orEmpty(),
            reviewWords = dao.dueWords(language, System.currentTimeMillis(), 6).map { it.word },
            goal = dao.profile(k)?.goal.orEmpty(),
            episodes = (recent + older).distinctBy { it.id }.map(::episodeText),
            recentConversation = turns.map(::turnText),
            returning = db.sessionDao().hasLearnerTurns(language),
            nextStep = recent.firstOrNull()?.nextStep.orEmpty(),
        )
    }

    suspend fun recordReview(id: Long, remembered: Boolean, at: Long = System.currentTimeMillis()) = db.withTransaction {
        val item = dao.vocabItem(id) ?: return@withTransaction
        if (item.isSuggested) return@withTransaction
        val (stage, due) = com.parlo.app.model.RetrievalSchedule.next(item.reviewStage, item.lastReviewedAt, remembered, at)
        dao.recordReview(id, stage, at, due)
    }

    /** Phrase search deliberately treats %, _ and backslashes literally; result/context budgets are fixed. */
    suspend fun search(language: String, query: String): List<String> {
        val phrase = query.trim().take(120)
        if (phrase.length < 2) return emptyList()
        val pattern = "%" + phrase.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"
        val transcriptMatches = db.sessionDao().searchHistory(language, pattern, 6).map { t ->
            val at = t.text.indexOf(phrase, ignoreCase = true).coerceAtLeast(0)
            val start = (at - 250).coerceAtLeast(0)
            turnText(t.copy(text = (if (start > 0) "…" else "") + t.text.drop(start).take(850)))
        }
        val episodeMatches = dao.searchEpisodes(key(language), pattern).map(::episodeText)
        return (transcriptMatches + episodeMatches).take(6)
    }

    /** A transactional opt-out also prevents in-flight analysis from recreating deleted memory. */
    suspend fun forgetSession(id: Long) = db.withTransaction {
        db.sessionDao().forget(id)
        db.sessionDao().deleteMemory(id)
    }

    /** Idempotent checkpoints from original turns. Each network call and transaction has bounded input. */
    suspend fun consolidate(sessionId: Long, apiKey: String, analyzer: MemoryAnalyzer) {
        maintenance.withLock { consolidateLocked(sessionId, apiKey, analyzer) }
    }

    private suspend fun consolidateLocked(sessionId: Long, apiKey: String, analyzer: MemoryAnalyzer) {
        val session = db.sessionDao().getSession(sessionId) ?: return
        if (!session.remember) return
        for (language in db.sessionDao().languages(sessionId)) {
            val k = key(language)
            while (true) {
                val after = dao.cursor(sessionId, k)
                val candidates = db.sessionDao().memoryTurns(sessionId, language, after, 20)
                if (candidates.isEmpty()) break
                // Keep a call under ~24k characters, but always make progress on an oversized turn.
                val chunk = candidates.runningFold(emptyList<TurnEntity>()) { acc, t -> acc + t }
                    .drop(1).takeWhile { it.size == 1 || it.sumOf { t -> t.text.take(2400).length } <= 24_000 }
                    .last()
                val analysis = analyzer.analyze(apiKey, language, chunk)
                db.withTransaction {
                    if (db.sessionDao().getSession(sessionId)?.remember == true) {
                        dao.insertEpisode(LearningEpisodeEntity(
                            sessionId = sessionId, language = k, sourceLanguage = language,
                            fromTurnId = chunk.first().id, throughTurnId = chunk.last().id,
                            occurredAt = chunk.last().timestamp,
                            summary = analysis.summary, demonstrated = analysis.demonstrated,
                            practise = analysis.practise, nextStep = analysis.nextStep,
                        ))
                    }
                }
                if (db.sessionDao().getSession(sessionId)?.remember != true) return
            }
        }
    }

    companion object {
        fun key(language: String) = language.trim().lowercase(Locale.ROOT)
        fun date(at: Long): String = Instant.ofEpochMilli(at).atZone(ZoneOffset.UTC).toLocalDate().toString()
        fun turnText(t: TurnEntity) = "${date(t.timestamp)} [session ${t.sessionId}, turn ${t.id}] ${t.speaker}: ${t.text.take(900)}"
        fun episodeText(e: LearningEpisodeEntity) = buildString {
            append("${date(e.occurredAt)} [session ${e.sessionId}, turns ${e.fromTurnId}–${e.throughTurnId}]: ${e.summary}")
            if (e.demonstrated.isNotBlank()) append(" Observed: ${e.demonstrated}")
            if (e.practise.isNotBlank()) append(" Possible practice: ${e.practise}")
        }
    }
}
