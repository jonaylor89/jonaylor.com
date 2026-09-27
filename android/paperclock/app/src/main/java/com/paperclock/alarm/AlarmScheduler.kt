package com.paperclock.alarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import com.paperclock.data.AlarmEntity
import java.util.Calendar

class AlarmScheduler(val context: Context) {
    private val manager = context.getSystemService(AlarmManager::class.java)
    fun canScheduleExact() = Build.VERSION.SDK_INT < Build.VERSION_CODES.S || manager.canScheduleExactAlarms()
    fun schedule(alarm: AlarmEntity) {
        if (!alarm.enabled || !canScheduleExact()) return
        manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextTrigger(alarm), pendingIntent(alarm.id))
    }
    fun cancel(id: Long) = manager.cancel(pendingIntent(id))
    fun reschedule(alarm: AlarmEntity) { cancel(alarm.id); schedule(alarm) }
    fun pendingIntent(id: Long): PendingIntent = PendingIntent.getBroadcast(context, id.hashCode(), Intent(context, AlarmReceiver::class.java).putExtra(AlarmReceiver.EXTRA_ALARM_ID, id), PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    fun nextTrigger(alarm: AlarmEntity, now: Calendar = Calendar.getInstance()): Long {
        val candidate = now.clone() as Calendar
        candidate.set(Calendar.HOUR_OF_DAY, alarm.hour); candidate.set(Calendar.MINUTE, alarm.minute); candidate.set(Calendar.SECOND, 0); candidate.set(Calendar.MILLISECOND, 0)
        val repeats = alarm.repeatDays.split(',').mapNotNull { it.toIntOrNull() }.toSet()
        if (repeats.isEmpty()) { if (candidate.timeInMillis <= now.timeInMillis) candidate.add(Calendar.DAY_OF_YEAR, 1); return candidate.timeInMillis }
        repeat(8) { offset ->
            if (offset > 0) candidate.add(Calendar.DAY_OF_YEAR, 1)
            if (candidate.timeInMillis > now.timeInMillis && candidate.get(Calendar.DAY_OF_WEEK) in repeats) return candidate.timeInMillis
        }
        return candidate.timeInMillis
    }
}
