package com.paperclock.ui

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.paperclock.data.AlarmEntity
import com.paperclock.data.AlarmWithGoalRow
import com.paperclock.data.ClockRepository
import com.paperclock.data.GoalEntity
import com.paperclock.alarm.AlarmScheduler
import com.paperclock.widget.WidgetUpdater
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import java.time.LocalDate

data class ClockUiState(val alarms: List<AlarmWithGoalRow> = emptyList(), val goals: List<GoalEntity> = emptyList())
class ClockViewModel(private val repository: ClockRepository, private val scheduler: AlarmScheduler) : ViewModel() {
    val state: StateFlow<ClockUiState> = combine(repository.alarms, repository.goals) { alarms, goals -> ClockUiState(alarms, goals) }.stateIn(viewModelScope, SharingStarted.WhileSubscribed(5_000), ClockUiState())
    fun saveAlarm(alarm: AlarmEntity) = viewModelScope.launch {
        val id = repository.saveAlarm(alarm)
        scheduler.reschedule(alarm.copy(id = id))
        WidgetUpdater.updateAll(scheduler.context)
    }
    fun toggle(alarm: AlarmEntity) = viewModelScope.launch {
        val changed = alarm.copy(enabled = !alarm.enabled)
        repository.saveAlarm(changed)
        if (changed.enabled) scheduler.schedule(changed) else scheduler.cancel(changed.id)
        WidgetUpdater.updateAll(scheduler.context)
    }
    fun deleteAlarm(alarm: AlarmEntity) = viewModelScope.launch {
        scheduler.cancel(alarm.id)
        repository.deleteAlarm(alarm)
        WidgetUpdater.updateAll(scheduler.context)
    }
    fun saveGoal(goal: GoalEntity, firstAlarm: AlarmEntity? = null) = viewModelScope.launch {
        val id = repository.saveGoal(goal)
        firstAlarm?.let { alarm -> val linked = alarm.copy(goalId = id); val alarmId = repository.saveAlarm(linked); scheduler.reschedule(linked.copy(id = alarmId)) }
        WidgetUpdater.updateAll(scheduler.context)
    }
    fun deleteGoal(goal: GoalEntity) = viewModelScope.launch {
        repository.deleteGoal(goal)
        WidgetUpdater.updateAll(scheduler.context)
    }
    fun canScheduleExact() = scheduler.canScheduleExact()
    class Factory(private val repository: ClockRepository, private val scheduler: AlarmScheduler) : ViewModelProvider.Factory { @Suppress("UNCHECKED_CAST") override fun <T : ViewModel> create(modelClass: Class<T>): T = ClockViewModel(repository, scheduler) as T }
}

data class GoalDraft(val title: String = "", val description: String = "", val date: LocalDate = LocalDate.now().plusDays(30), val alarm: AlarmEntity = AlarmEntity(hour = 6, minute = 0, soundKey = "beep_beep_beep"))
