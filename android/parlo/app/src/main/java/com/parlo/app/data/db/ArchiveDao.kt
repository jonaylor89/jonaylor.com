package com.parlo.app.data.db

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query

/** Logical snapshots avoid copying an open WAL database or exporting credentials. */
@Dao
interface ArchiveDao {
    @Query("SELECT * FROM sessions ORDER BY id") suspend fun sessions(): List<SessionEntity>
    @Query("SELECT * FROM turns ORDER BY id") suspend fun turns(): List<TurnEntity>
    @Query("SELECT * FROM vocab ORDER BY id") suspend fun vocab(): List<VocabEntity>
    @Query("SELECT * FROM learner_profiles") suspend fun profiles(): List<LearnerProfileEntity>
    @Query("SELECT * FROM learning_episodes ORDER BY id") suspend fun episodes(): List<LearningEpisodeEntity>
    @Query("DELETE FROM sessions") suspend fun clearSessions()
    @Query("DELETE FROM vocab") suspend fun clearVocab()
    @Query("DELETE FROM learner_profiles") suspend fun clearProfiles()
    @Insert suspend fun insertSessions(rows: List<SessionEntity>)
    @Insert suspend fun insertTurns(rows: List<TurnEntity>)
    @Insert suspend fun insertVocab(rows: List<VocabEntity>)
    @Insert suspend fun insertProfiles(rows: List<LearnerProfileEntity>)
    @Insert suspend fun insertEpisodes(rows: List<LearningEpisodeEntity>)
}
