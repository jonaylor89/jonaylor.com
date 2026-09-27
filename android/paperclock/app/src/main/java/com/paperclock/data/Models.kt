package com.paperclock.data

import androidx.room.Entity
import androidx.room.ForeignKey
import androidx.room.Index
import androidx.room.PrimaryKey

@Entity(tableName = "goals")
data class GoalEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val title: String,
    val targetDateEpochDay: Long,
    val description: String = "",
    val createdAtMillis: Long = System.currentTimeMillis()
)

@Entity(tableName = "alarms", foreignKeys = [ForeignKey(entity = GoalEntity::class, parentColumns = ["id"], childColumns = ["goalId"], onDelete = ForeignKey.SET_NULL)], indices = [Index("goalId")])
data class AlarmEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val hour: Int,
    val minute: Int,
    val repeatDays: String = "",
    val label: String = "",
    val enabled: Boolean = true,
    val soundKey: String,
    val goalId: Long? = null,
    val vibrate: Boolean = false
)

data class AlarmWithGoal(val alarm: AlarmEntity, val goal: GoalEntity?)
