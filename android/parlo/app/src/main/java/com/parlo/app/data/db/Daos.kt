package com.parlo.app.data.db

import androidx.room.Dao
import androidx.room.Delete
import androidx.room.Embedded
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Relation
import androidx.room.Transaction
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

data class SessionWithTurns(
    @Embedded val session: SessionEntity,
    @Relation(parentColumn = "id", entityColumn = "sessionId") val turns: List<TurnEntity>,
)

data class LanguageSession(val sessionId: Long, val language: String)

@Dao
interface SessionDao {
    @Query("SELECT DISTINCT t.sessionId, CASE WHEN t.language = '' THEN s.language ELSE t.language END AS language FROM turns t JOIN sessions s ON s.id = t.sessionId WHERE t.speaker = 'USER'")
    fun observeLanguageSessions(): Flow<List<LanguageSession>>

    @Insert
    suspend fun insertSession(session: SessionEntity): Long

    @Update
    suspend fun updateSession(session: SessionEntity)

    @Insert
    suspend fun insertTurn(turn: TurnEntity): Long

    @Query("SELECT * FROM sessions ORDER BY startedAt DESC")
    fun observeSessions(): Flow<List<SessionEntity>>

    @Query("SELECT * FROM sessions WHERE id = :id")
    suspend fun getSession(id: Long): SessionEntity?

    @Transaction
    @Query("SELECT * FROM sessions WHERE id = :id")
    fun observeSessionWithTurns(id: Long): Flow<SessionWithTurns?>

    @Query("SELECT * FROM turns WHERE sessionId = :sessionId ORDER BY id ASC")
    suspend fun getTurns(sessionId: Long): List<TurnEntity>

    @Query("SELECT * FROM turns WHERE sessionId = :sessionId AND id > :afterId AND speaker != 'SYSTEM' AND (language = :language COLLATE NOCASE OR (language = '' AND :language = (SELECT language FROM sessions WHERE id = :sessionId) COLLATE NOCASE)) ORDER BY id LIMIT :limit")
    suspend fun memoryTurns(sessionId: Long, language: String, afterId: Long, limit: Int): List<TurnEntity>

    @Query("SELECT DISTINCT CASE WHEN language = '' THEN (SELECT language FROM sessions WHERE id = :sessionId) ELSE language END FROM turns WHERE sessionId = :sessionId AND speaker != 'SYSTEM'")
    suspend fun languages(sessionId: Long): List<String>

    @Query("SELECT t.* FROM turns t JOIN sessions s ON s.id = t.sessionId WHERE s.remember = 1 AND t.speaker != 'SYSTEM' AND (t.language = :language COLLATE NOCASE OR (t.language = '' AND s.language = :language COLLATE NOCASE)) AND t.text LIKE :pattern ESCAPE '\\' ORDER BY t.id DESC LIMIT :limit")
    suspend fun searchHistory(language: String, pattern: String, limit: Int): List<TurnEntity>

    @Query("SELECT EXISTS(SELECT 1 FROM turns t JOIN sessions s ON s.id = t.sessionId WHERE s.remember = 1 AND t.speaker = 'USER' AND (t.language = :language COLLATE NOCASE OR (t.language = '' AND s.language = :language COLLATE NOCASE)))")
    suspend fun hasLearnerTurns(language: String): Boolean

    @Query("SELECT t.* FROM turns t JOIN sessions s ON s.id = t.sessionId WHERE s.remember = 1 AND t.speaker != 'SYSTEM' AND s.id != :excludingSession AND (t.language = :language COLLATE NOCASE OR (t.language = '' AND s.language = :language COLLATE NOCASE)) ORDER BY t.id DESC LIMIT :limit")
    suspend fun previousTurns(language: String, excludingSession: Long, limit: Int): List<TurnEntity>

    @Query("SELECT id FROM sessions WHERE remember = 1 AND EXISTS (SELECT 1 FROM turns WHERE sessionId = sessions.id AND speaker = 'USER') AND ((endedAt IS NOT NULL AND minedAt IS NULL) OR EXISTS (SELECT 1 FROM turns t WHERE t.sessionId = sessions.id AND t.speaker != 'SYSTEM' AND t.id > COALESCE((SELECT MAX(e.throughTurnId) FROM learning_episodes e WHERE e.sessionId = sessions.id AND (e.sourceLanguage = (CASE WHEN t.language = '' THEN sessions.language ELSE t.language END) COLLATE NOCASE OR e.language = LOWER(CASE WHEN t.language = '' THEN sessions.language ELSE t.language END))), 0))) ORDER BY startedAt LIMIT :limit")
    suspend fun pendingMemory(limit: Int): List<Long>

    @Query("UPDATE sessions SET remember = 0 WHERE id = :id")
    suspend fun forget(id: Long)

    @Query("DELETE FROM learning_episodes WHERE sessionId = :id")
    suspend fun deleteMemory(id: Long)

    @Query("DELETE FROM sessions WHERE id = :id")
    suspend fun deleteSession(id: Long)

    /** All sessions at process startup, or one specific session during service teardown. */
    @Query("UPDATE sessions SET interrupted = 1, endedAt = COALESCE((SELECT MAX(timestamp) FROM turns WHERE sessionId = sessions.id), startedAt), durationMs = MAX(0, COALESCE((SELECT MAX(timestamp) FROM turns WHERE sessionId = sessions.id), startedAt) - startedAt) WHERE endedAt IS NULL AND (:sessionId IS NULL OR id = :sessionId)")
    suspend fun recoverInterrupted(sessionId: Long? = null)

    @Query("DELETE FROM sessions WHERE endedAt IS NULL AND id NOT IN (SELECT DISTINCT sessionId FROM turns)")
    suspend fun deleteEmptyUnfinishedSessions()

    @Query("UPDATE sessions SET minedAt = :at WHERE id = :id")
    suspend fun markMined(id: Long, at: Long)

    @Query("UPDATE sessions SET focus = :focus, nextWalkTitle = :nextWalkTitle, nextWalkPrompt = :nextWalkPrompt WHERE id = :id")
    suspend fun saveReview(id: Long, focus: String?, nextWalkTitle: String?, nextWalkPrompt: String?)

    @Query("SELECT * FROM sessions WHERE language = :language COLLATE NOCASE AND remember = 1 AND minedAt IS NOT NULL ORDER BY startedAt DESC LIMIT 1")
    suspend fun latestReviewed(language: String): SessionEntity?
}

@Dao
interface VocabDao {
    @Insert
    suspend fun insert(vocab: VocabEntity): Long

    @Delete
    suspend fun delete(vocab: VocabEntity)

    @Query("SELECT * FROM vocab ORDER BY language ASC, savedAt DESC")
    fun observeAll(): Flow<List<VocabEntity>>

    @Query("SELECT COUNT(*) FROM vocab WHERE sessionId = :sessionId")
    suspend fun countForSession(sessionId: Long): Int

    @Query("SELECT * FROM vocab WHERE language = :language COLLATE NOCASE AND word = :word COLLATE NOCASE LIMIT 1")
    suspend fun find(language: String, word: String): VocabEntity?

    @Query("SELECT word FROM vocab WHERE language = :language COLLATE NOCASE AND (sessionId IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = vocab.sessionId AND s.remember = 1))")
    suspend fun wordsFor(language: String): List<String>

    @Query("SELECT word FROM vocab WHERE language = :language COLLATE NOCASE AND status = 'KEPT' ORDER BY savedAt DESC LIMIT :limit")
    suspend fun recentWords(language: String, limit: Int): List<String>

    @Query("UPDATE vocab SET status = :status WHERE id = :id")
    suspend fun setStatus(id: Long, status: String)

    @Query("UPDATE vocab SET status = 'KEPT' WHERE status = 'SUGGESTED'")
    suspend fun keepAllSuggested()

    @Query("DELETE FROM vocab WHERE status = 'SUGGESTED'")
    suspend fun deleteAllSuggested()
}
