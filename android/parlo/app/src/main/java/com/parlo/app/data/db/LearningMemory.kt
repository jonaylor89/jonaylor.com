package com.parlo.app.data.db

import androidx.room.Dao
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.PrimaryKey
import androidx.room.Query
import kotlinx.coroutines.flow.Flow

/** Only explicit learner preferences belong here; model inferences remain source-linked episodes. */
@kotlinx.serialization.Serializable
@Entity(tableName = "learner_profiles")
data class LearnerProfileEntity(
    @PrimaryKey val language: String,
    val goal: String = "",
)

/** Rebuildable, bounded summaries of ORIGINAL turns, never summaries of summaries. */
@kotlinx.serialization.Serializable
@Entity(
    tableName = "learning_episodes",
    foreignKeys = [ForeignKey(entity = SessionEntity::class, parentColumns = ["id"], childColumns = ["sessionId"], onDelete = ForeignKey.CASCADE)],
    indices = [Index("sessionId"), Index(value = ["sessionId", "language", "throughTurnId"], unique = true), Index("language")],
)
data class LearningEpisodeEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: Long,
    val language: String,
    /** Original label avoids relying on SQLite's ASCII-only LOWER for custom language names. */
    val sourceLanguage: String = "",
    val fromTurnId: Long,
    val throughTurnId: Long,
    val occurredAt: Long,
    val summary: String,
    val demonstrated: String = "",
    val practise: String = "",
    val nextStep: String = "",
)

@Dao
interface LearningDao {
    @Query("SELECT * FROM learner_profiles ORDER BY language")
    fun observeProfiles(): Flow<List<LearnerProfileEntity>>

    @Query("SELECT * FROM learner_profiles WHERE language = :language")
    suspend fun profile(language: String): LearnerProfileEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun saveProfile(profile: LearnerProfileEntity)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertEpisode(episode: LearningEpisodeEntity)

    @Query("SELECT * FROM learning_episodes WHERE language = :language ORDER BY occurredAt DESC, throughTurnId DESC LIMIT :limit")
    suspend fun recent(language: String, limit: Int): List<LearningEpisodeEntity>

    @Query("SELECT * FROM learning_episodes WHERE language = :language ORDER BY occurredAt DESC, throughTurnId DESC LIMIT 30")
    fun observeEpisodes(language: String): Flow<List<LearningEpisodeEntity>>

    @Query("SELECT * FROM learning_episodes WHERE language = :language AND practise != '' AND occurredAt < :before ORDER BY occurredAt DESC LIMIT 2")
    suspend fun olderPractice(language: String, before: Long): List<LearningEpisodeEntity>

    @Query("SELECT e.* FROM learning_episodes e JOIN sessions s ON s.id = e.sessionId WHERE s.remember = 1 AND e.language = :language AND (e.summary LIKE :pattern ESCAPE '\\' OR e.demonstrated LIKE :pattern ESCAPE '\\' OR e.practise LIKE :pattern ESCAPE '\\') ORDER BY e.occurredAt DESC LIMIT 3")
    suspend fun searchEpisodes(language: String, pattern: String): List<LearningEpisodeEntity>

    @Query("SELECT COALESCE(MAX(throughTurnId), 0) FROM learning_episodes WHERE sessionId = :sessionId AND language = :language")
    suspend fun cursor(sessionId: Long, language: String): Long

    @Query("SELECT * FROM vocab WHERE id = :id")
    suspend fun vocabItem(id: Long): VocabEntity?

    @Query("UPDATE vocab SET reviewStage = :stage, lastReviewedAt = :at, nextReviewAt = :due WHERE id = :id")
    suspend fun recordReview(id: Long, stage: Int, at: Long, due: Long)

    @Query("SELECT * FROM vocab WHERE language = :language COLLATE NOCASE AND status = 'KEPT' AND nextReviewAt <= :now AND (sessionId IS NULL OR EXISTS (SELECT 1 FROM sessions s WHERE s.id = vocab.sessionId AND s.remember = 1)) ORDER BY CASE WHEN lastReviewedAt IS NULL THEN 1 ELSE 0 END, nextReviewAt, savedAt DESC LIMIT :limit")
    suspend fun dueWords(language: String, now: Long, limit: Int): List<VocabEntity>
}
