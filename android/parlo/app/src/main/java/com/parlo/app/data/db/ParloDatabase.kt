package com.parlo.app.data.db

import android.content.Context
import androidx.room.AutoMigration
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [SessionEntity::class, TurnEntity::class, VocabEntity::class, LearnerProfileEntity::class, LearningEpisodeEntity::class],
    version = 4,
    exportSchema = true,
    autoMigrations = [AutoMigration(from = 1, to = 2), AutoMigration(from = 2, to = 3), AutoMigration(from = 3, to = 4)],
)
abstract class ParloDatabase : RoomDatabase() {
    abstract fun sessionDao(): SessionDao
    abstract fun vocabDao(): VocabDao
    abstract fun learningDao(): LearningDao
    abstract fun archiveDao(): ArchiveDao

    companion object {
        fun build(context: Context): ParloDatabase =
            Room.databaseBuilder(context, ParloDatabase::class.java, "parlo.db")
                .build()
    }
}
