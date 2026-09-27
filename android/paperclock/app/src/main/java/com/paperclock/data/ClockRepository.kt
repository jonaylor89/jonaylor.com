package com.paperclock.data

import kotlinx.coroutines.flow.Flow

class ClockRepository(private val dao: ClockDao) {
    val alarms: Flow<List<AlarmWithGoalRow>> = dao.observeAlarms()
    val goals: Flow<List<GoalEntity>> = dao.observeGoals()
    suspend fun alarm(id: Long) = dao.alarmWithGoal(id)
    suspend fun widgetAlarms() = dao.alarmsWithGoals()
    suspend fun widgetGoals() = dao.goals()
    suspend fun enabledAlarms() = dao.enabledAlarms()
    suspend fun saveAlarm(alarm: AlarmEntity): Long = if (alarm.id == 0L) dao.insertAlarm(alarm) else { dao.updateAlarm(alarm); alarm.id }
    suspend fun deleteAlarm(alarm: AlarmEntity) = dao.deleteAlarm(alarm)
    suspend fun saveGoal(goal: GoalEntity): Long = if (goal.id == 0L) dao.insertGoal(goal) else { dao.updateGoal(goal); goal.id }
    suspend fun deleteGoal(goal: GoalEntity) = dao.deleteGoal(goal)
}
