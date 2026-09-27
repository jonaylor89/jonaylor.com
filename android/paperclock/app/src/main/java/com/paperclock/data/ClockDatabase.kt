package com.paperclock.data

import android.content.Context
import androidx.room.Dao
import androidx.room.Database
import androidx.room.Delete
import androidx.room.Embedded
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Relation
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.Transaction
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import androidx.room.Update
import kotlinx.coroutines.flow.Flow

@Dao
interface ClockDao {
    @Transaction @Query("SELECT * FROM alarms ORDER BY hour, minute") fun observeAlarms(): Flow<List<AlarmWithGoalRow>>
    @Transaction @Query("SELECT * FROM alarms WHERE id = :id") suspend fun alarmWithGoal(id: Long): AlarmWithGoalRow?
    @Transaction @Query("SELECT * FROM alarms ORDER BY hour, minute") suspend fun alarmsWithGoals(): List<AlarmWithGoalRow>
    @Query("SELECT * FROM alarms WHERE enabled = 1") suspend fun enabledAlarms(): List<AlarmEntity>
    @Query("SELECT * FROM goals ORDER BY targetDateEpochDay") fun observeGoals(): Flow<List<GoalEntity>>
    @Query("SELECT * FROM goals ORDER BY targetDateEpochDay") suspend fun goals(): List<GoalEntity>
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertAlarm(alarm: AlarmEntity): Long
    @Update suspend fun updateAlarm(alarm: AlarmEntity)
    @Delete suspend fun deleteAlarm(alarm: AlarmEntity)
    @Insert(onConflict = OnConflictStrategy.REPLACE) suspend fun insertGoal(goal: GoalEntity): Long
    @Update suspend fun updateGoal(goal: GoalEntity)
    @Delete suspend fun deleteGoal(goal: GoalEntity)
}

data class AlarmWithGoalRow(@Embedded val alarm: AlarmEntity, @Relation(parentColumn = "goalId", entityColumn = "id") val goal: GoalEntity?)

@Database(entities = [GoalEntity::class, AlarmEntity::class], version = 2, exportSchema = true)
abstract class ClockDatabase : RoomDatabase() {
    abstract fun dao(): ClockDao

    companion object {
        private val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("""
                    CREATE TABLE alarms_new (
                        id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
                        hour INTEGER NOT NULL,
                        minute INTEGER NOT NULL,
                        repeatDays TEXT NOT NULL,
                        label TEXT NOT NULL,
                        enabled INTEGER NOT NULL,
                        soundKey TEXT NOT NULL,
                        goalId INTEGER,
                        vibrate INTEGER NOT NULL,
                        FOREIGN KEY(goalId) REFERENCES goals(id) ON UPDATE NO ACTION ON DELETE SET NULL
                    )
                """.trimIndent())
                db.execSQL("""
                    INSERT INTO alarms_new (id, hour, minute, repeatDays, label, enabled, soundKey, goalId, vibrate)
                    SELECT id, hour, minute, repeatDays, label, enabled, soundKey, goalId, vibrate FROM alarms
                """.trimIndent())
                db.execSQL("DROP TABLE alarms")
                db.execSQL("ALTER TABLE alarms_new RENAME TO alarms")
                db.execSQL("CREATE INDEX IF NOT EXISTS index_alarms_goalId ON alarms(goalId)")
            }
        }

        fun create(context: Context) = Room.databaseBuilder(context, ClockDatabase::class.java, "paper-clock.db")
            .addMigrations(MIGRATION_1_2)
            .build()
    }
}
