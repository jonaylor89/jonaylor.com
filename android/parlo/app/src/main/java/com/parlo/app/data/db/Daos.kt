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

@Dao
interface SessionDao {
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

    @Query("SELECT * FROM turns WHERE sessionId = :sessionId ORDER BY timestamp ASC")
    suspend fun getTurns(sessionId: Long): List<TurnEntity>

    @Query("DELETE FROM sessions WHERE id = :id")
    suspend fun deleteSession(id: Long)

    @Query("DELETE FROM sessions WHERE endedAt IS NULL AND id NOT IN (SELECT DISTINCT sessionId FROM turns)")
    suspend fun deleteEmptyUnfinishedSessions()

    @Query("UPDATE sessions SET minedAt = :at WHERE id = :id")
    suspend fun markMined(id: Long, at: Long)

    @Query("UPDATE sessions SET focus = :focus, nextWalkTitle = :nextWalkTitle, nextWalkPrompt = :nextWalkPrompt WHERE id = :id")
    suspend fun saveReview(id: Long, focus: String?, nextWalkTitle: String?, nextWalkPrompt: String?)

    @Query("SELECT * FROM sessions WHERE language = :language COLLATE NOCASE AND focus IS NOT NULL AND focus != '' ORDER BY startedAt DESC LIMIT 1")
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

    @Query("SELECT word FROM vocab WHERE language = :language COLLATE NOCASE")
    suspend fun wordsFor(language: String): List<String>

    @Query("SELECT word FROM vocab WHERE language = :language COLLATE NOCASE ORDER BY savedAt DESC LIMIT :limit")
    suspend fun recentWords(language: String, limit: Int): List<String>

    @Query("UPDATE vocab SET status = :status WHERE id = :id")
    suspend fun setStatus(id: Long, status: String)

    @Query("UPDATE vocab SET status = 'KEPT' WHERE status = 'SUGGESTED'")
    suspend fun keepAllSuggested()

    @Query("DELETE FROM vocab WHERE status = 'SUGGESTED'")
    suspend fun deleteAllSuggested()
}
