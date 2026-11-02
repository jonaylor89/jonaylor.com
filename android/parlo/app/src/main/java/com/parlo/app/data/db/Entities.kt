package com.parlo.app.data.db

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@kotlinx.serialization.Serializable
@Entity(tableName = "sessions")
data class SessionEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val startedAt: Long,
    val endedAt: Long? = null,
    @ColumnInfo(defaultValue = "0") val interrupted: Boolean = false,
    val language: String,
    val dialect: String,
    val level: String,
    val scenario: String,
    val correctionStyle: String,
    val durationMs: Long = 0,
    val recap: String? = null,
    /** Opt out of both retrieval and derived learning memory without deleting the transcript. */
    @ColumnInfo(defaultValue = "1") val remember: Boolean = true,
    /** When the transcript was mined for vocab; null until the post-walk pass has run. */
    @ColumnInfo(defaultValue = "NULL") val minedAt: Long? = null,
    /** From the post-walk review: one thing to work on, and the tutor's suggested next walk. */
    @ColumnInfo(defaultValue = "NULL") val focus: String? = null,
    @ColumnInfo(defaultValue = "NULL") val nextWalkTitle: String? = null,
    @ColumnInfo(defaultValue = "NULL") val nextWalkPrompt: String? = null,
)

@kotlinx.serialization.Serializable
@Entity(
    tableName = "turns",
    foreignKeys = [ForeignKey(
        entity = SessionEntity::class,
        parentColumns = ["id"],
        childColumns = ["sessionId"],
        onDelete = ForeignKey.CASCADE,
    )],
    indices = [Index("sessionId")],
)
data class TurnEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val sessionId: Long,
    val speaker: String,
    val text: String,
    val timestamp: Long,
    /** Empty on pre-v4 transcripts; resolved to the session language when reading. */
    @ColumnInfo(defaultValue = "''") val language: String = "",
)

@kotlinx.serialization.Serializable
@Entity(tableName = "vocab", indices = [Index("language")])
data class VocabEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val word: String,
    val translation: String,
    val exampleSentence: String,
    val language: String,
    val savedAt: Long,
    val sessionId: Long? = null,
    /** [VocabSource] name. */
    @ColumnInfo(defaultValue = "MANUAL") val source: String = VocabSource.MANUAL.name,
    /** [VocabStatus] name. */
    @ColumnInfo(defaultValue = "KEPT") val status: String = VocabStatus.KEPT.name,
    /** Why the tutor/miner picked it up, e.g. "You asked what it means". */
    @ColumnInfo(defaultValue = "") val reason: String = "",
    /** Self-reported retrieval practice, not inferred proficiency or a mastery score. */
    @ColumnInfo(defaultValue = "0") val reviewStage: Int = 0,
    @ColumnInfo(defaultValue = "NULL") val lastReviewedAt: Long? = null,
    @ColumnInfo(defaultValue = "0") val nextReviewAt: Long = 0,
) {
    val isSuggested: Boolean get() = status == VocabStatus.SUGGESTED.name
}

enum class VocabSource { MANUAL, TUTOR, MINED }

enum class VocabStatus { KEPT, SUGGESTED }
