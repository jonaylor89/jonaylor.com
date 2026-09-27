package com.paperclock.widget

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.SystemClock
import android.view.View
import android.widget.RemoteViews
import com.paperclock.MainActivity
import com.paperclock.PaperClockApp
import com.paperclock.R
import com.paperclock.data.AlarmEntity
import com.paperclock.data.AlarmWithGoalRow
import com.paperclock.data.GoalEntity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.Calendar
import java.util.Locale
import kotlin.math.roundToInt

/** Keeps Paper Clock's three home-screen surfaces in sync with the offline database. */
object WidgetUpdater {
    suspend fun updateAll(context: Context) {
        val app = context.applicationContext as PaperClockApp
        val rows = app.container.repository.widgetAlarms()
        val goals = app.container.repository.widgetGoals()
        val manager = AppWidgetManager.getInstance(context)

        updateNextReason(context, manager, rows)
        updateQuickAlarm(context, manager)
        updateGoalCountdown(context, manager, rows, goals)
        updateGoalFocus(context, manager, goals)
    }

    private fun updateNextReason(context: Context, manager: AppWidgetManager, rows: List<AlarmWithGoalRow>) {
        val ids = manager.getAppWidgetIds(ComponentName(context, NextReasonWidgetProvider::class.java))
        if (ids.isEmpty()) return
        val next = rows.filter { it.alarm.enabled }.minByOrNull { nextOccurrence(it.alarm).timeInMillis }
            ?: rows.minByOrNull { nextOccurrence(it.alarm).timeInMillis }
        val views = RemoteViews(context.packageName, R.layout.widget_next_reason)
        views.setOnClickPendingIntent(R.id.widget_next_root, openApp(context))

        if (next == null) {
            views.setTextViewText(R.id.widget_next_time, context.getString(R.string.widget_no_alarm))
            views.setTextViewText(R.id.widget_next_reason, context.getString(R.string.widget_set_an_alarm))
            views.setViewVisibility(R.id.widget_next_countdown, View.GONE)
            views.setTextViewText(R.id.widget_next_schedule, context.getString(R.string.widget_ready_when_you_are))
            views.setTextViewText(R.id.widget_next_toggle, context.getString(R.string.widget_set))
            views.setOnClickPendingIntent(R.id.widget_next_toggle, newAlarm(context))
        } else {
            val alarm = next.alarm
            views.setTextViewText(R.id.widget_next_time, formatTime(alarm))
            views.setTextViewText(R.id.widget_next_reason, (next.goal?.title ?: alarm.label.ifBlank { context.getString(R.string.widget_alarm) }).uppercase(Locale.getDefault()))
            views.setTextViewText(R.id.widget_next_schedule, if (alarm.enabled) repeatLabel(alarm.repeatDays) else context.getString(R.string.widget_alarm_off))
            views.setViewVisibility(R.id.widget_next_countdown, if (alarm.enabled) View.VISIBLE else View.GONE)
            if (alarm.enabled) {
                val until = (nextOccurrence(alarm).timeInMillis - System.currentTimeMillis()).coerceAtLeast(0L)
                views.setChronometer(R.id.widget_next_countdown, SystemClock.elapsedRealtime() + until, context.getString(R.string.widget_countdown_format), true)
                views.setChronometerCountDown(R.id.widget_next_countdown, true)
            }
            views.setTextViewText(R.id.widget_next_toggle, if (alarm.enabled) context.getString(R.string.widget_on) else context.getString(R.string.widget_off))
            views.setOnClickPendingIntent(R.id.widget_next_toggle, toggleAlarm(context, alarm.id))
        }
        manager.updateAppWidget(ids, views)
    }

    private fun updateQuickAlarm(context: Context, manager: AppWidgetManager) {
        val ids = manager.getAppWidgetIds(ComponentName(context, QuickAlarmWidgetProvider::class.java))
        if (ids.isEmpty()) return
        val views = RemoteViews(context.packageName, R.layout.widget_quick_alarm)
        views.setOnClickPendingIntent(R.id.widget_quick_root, newAlarm(context))
        manager.updateAppWidget(ids, views)
    }

    private fun updateGoalCountdown(context: Context, manager: AppWidgetManager, rows: List<AlarmWithGoalRow>, goals: List<GoalEntity>) {
        val ids = manager.getAppWidgetIds(ComponentName(context, GoalCountdownWidgetProvider::class.java))
        if (ids.isEmpty()) return
        val today = LocalDate.now().toEpochDay()
        val goal = goals.filter { it.targetDateEpochDay >= today }.minByOrNull { it.targetDateEpochDay }
            ?: goals.maxByOrNull { it.targetDateEpochDay }
        val views = RemoteViews(context.packageName, R.layout.widget_goal_countdown)
        views.setOnClickPendingIntent(R.id.widget_goal_root, openGoals(context))

        if (goal == null) {
            views.setTextViewText(R.id.widget_goal_title, context.getString(R.string.widget_no_goal))
            views.setTextViewText(R.id.widget_goal_days, context.getString(R.string.widget_make_a_reason))
            views.setTextViewText(R.id.widget_goal_target, context.getString(R.string.widget_link_an_alarm))
            views.setViewVisibility(R.id.widget_goal_progress, View.GONE)
            views.setTextViewText(R.id.widget_goal_linked, context.getString(R.string.widget_goals))
        } else {
            val remaining = ChronoUnit.DAYS.between(LocalDate.now(), LocalDate.ofEpochDay(goal.targetDateEpochDay))
            val linked = rows.count { it.alarm.goalId == goal.id }
            val createdDate = Instant.ofEpochMilli(goal.createdAtMillis).atZone(ZoneId.systemDefault()).toLocalDate()
            val total = (goal.targetDateEpochDay - createdDate.toEpochDay()).coerceAtLeast(1)
            val complete = ((1f - remaining.toFloat() / total) * 100).roundToInt().coerceIn(0, 100)
            views.setTextViewText(R.id.widget_goal_title, goal.title.uppercase(Locale.getDefault()))
            views.setTextViewText(R.id.widget_goal_days, countdownText(remaining))
            views.setTextViewText(R.id.widget_goal_target, context.getString(R.string.widget_target_date, LocalDate.ofEpochDay(goal.targetDateEpochDay).toString()))
            views.setViewVisibility(R.id.widget_goal_progress, View.VISIBLE)
            views.setProgressBar(R.id.widget_goal_progress, 100, complete, false)
            views.setTextViewText(R.id.widget_goal_linked, context.resources.getQuantityString(R.plurals.widget_linked_alarms, linked, linked))
        }
        manager.updateAppWidget(ids, views)
    }

    private fun updateGoalFocus(context: Context, manager: AppWidgetManager, goals: List<GoalEntity>) {
        val ids = manager.getAppWidgetIds(ComponentName(context, GoalFocusWidgetProvider::class.java))
        if (ids.isEmpty()) return
        val today = LocalDate.now().toEpochDay()
        val goal = goals.filter { it.targetDateEpochDay >= today }.minByOrNull { it.targetDateEpochDay }
            ?: goals.maxByOrNull { it.targetDateEpochDay }
        val views = RemoteViews(context.packageName, R.layout.widget_goal_focus)
        views.setOnClickPendingIntent(R.id.widget_goal_focus_root, openGoals(context))
        if (goal == null) {
            views.setTextViewText(R.id.widget_goal_focus_days, context.getString(R.string.widget_goal_focus_empty_count))
            views.setTextViewText(R.id.widget_goal_focus_unit, context.getString(R.string.widget_goal_focus_empty_unit))
            views.setTextViewText(R.id.widget_goal_focus_title, context.getString(R.string.widget_goal_focus_empty_title))
        } else {
            val remaining = ChronoUnit.DAYS.between(LocalDate.now(), LocalDate.ofEpochDay(goal.targetDateEpochDay))
            views.setTextViewText(R.id.widget_goal_focus_days, if (remaining < 0) context.getString(R.string.widget_done) else remaining.toString())
            views.setTextViewText(R.id.widget_goal_focus_unit, if (remaining < 0) "" else context.getString(R.string.widget_days_left))
            views.setTextViewText(R.id.widget_goal_focus_title, goal.title.uppercase(Locale.getDefault()))
        }
        manager.updateAppWidget(ids, views)
    }

    private fun openApp(context: Context) = PendingIntent.getActivity(
        context, 100, Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private fun openGoals(context: Context) = PendingIntent.getActivity(
        context, 101, Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_OPEN_GOALS, true).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private fun newAlarm(context: Context) = PendingIntent.getActivity(
        context, 102, Intent(context, MainActivity::class.java).putExtra(MainActivity.EXTRA_NEW_ALARM, true).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )

    private fun toggleAlarm(context: Context, id: Long) = PendingIntent.getBroadcast(
        context, id.hashCode(), Intent(context, WidgetActionReceiver::class.java).setAction(WidgetActionReceiver.ACTION_TOGGLE_ALARM)
            .setData(Uri.parse("paperclock://widget/alarm/$id")).putExtra(WidgetActionReceiver.EXTRA_ALARM_ID, id),
        PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
}

abstract class PaperClockWidgetProvider : AppWidgetProvider() {
    override fun onUpdate(context: Context, appWidgetManager: AppWidgetManager, appWidgetIds: IntArray) = refresh(context)
    override fun onAppWidgetOptionsChanged(context: Context, appWidgetManager: AppWidgetManager, appWidgetId: Int, newOptions: android.os.Bundle) = refresh(context)

    private fun refresh(context: Context) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { WidgetUpdater.updateAll(context) } finally { pending.finish() }
        }
    }
}

class NextReasonWidgetProvider : PaperClockWidgetProvider()
class QuickAlarmWidgetProvider : PaperClockWidgetProvider()
class GoalCountdownWidgetProvider : PaperClockWidgetProvider()
class GoalFocusWidgetProvider : PaperClockWidgetProvider()

class WidgetActionReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_TOGGLE_ALARM) return
        val id = intent.getLongExtra(EXTRA_ALARM_ID, -1)
        if (id < 0) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val app = context.applicationContext as PaperClockApp
                app.container.repository.alarm(id)?.alarm?.let { alarm ->
                    val changed = alarm.copy(enabled = !alarm.enabled)
                    app.container.repository.saveAlarm(changed)
                    if (changed.enabled) app.container.scheduler.schedule(changed) else app.container.scheduler.cancel(changed.id)
                }
                WidgetUpdater.updateAll(context)
            } finally { pending.finish() }
        }
    }

    companion object {
        const val ACTION_TOGGLE_ALARM = "com.paperclock.widget.TOGGLE_ALARM"
        const val EXTRA_ALARM_ID = "alarm_id"
    }
}

class WidgetRefreshReceiver : android.content.BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try { WidgetUpdater.updateAll(context) } finally { pending.finish() }
        }
    }
}

private fun nextOccurrence(alarm: AlarmEntity): Calendar {
    val now = Calendar.getInstance()
    val selectedDays = alarm.repeatDays.split(',').mapNotNull { it.toIntOrNull() }.toSet()
    repeat(8) { offset ->
        val candidate = (now.clone() as Calendar).apply {
            add(Calendar.DAY_OF_YEAR, offset)
            set(Calendar.HOUR_OF_DAY, alarm.hour)
            set(Calendar.MINUTE, alarm.minute)
            set(Calendar.SECOND, 0)
            set(Calendar.MILLISECOND, 0)
        }
        if (candidate.timeInMillis > now.timeInMillis && (selectedDays.isEmpty() || candidate.get(Calendar.DAY_OF_WEEK) in selectedDays)) return candidate
    }
    return now
}

private fun formatTime(alarm: AlarmEntity): String {
    val suffix = if (alarm.hour < 12) "AM" else "PM"
    val hour = alarm.hour % 12
    return String.format(Locale.getDefault(), "%d:%02d %s", if (hour == 0) 12 else hour, alarm.minute, suffix)
}

private fun repeatLabel(days: String): String {
    val selected = days.split(',').mapNotNull { it.toIntOrNull() }.toSet()
    val weekdays = setOf(Calendar.MONDAY, Calendar.TUESDAY, Calendar.WEDNESDAY, Calendar.THURSDAY, Calendar.FRIDAY)
    return when {
        selected.isEmpty() -> "ONCE"
        selected == weekdays -> "WEEKDAYS"
        selected.size == 7 -> "EVERY DAY"
        else -> "REPEATS"
    }
}

private fun countdownText(days: Long) = when {
    days > 0 -> "$days DAYS REMAINING"
    days == 0L -> "TARGET DAY"
    else -> "${-days} DAYS PAST"
}
