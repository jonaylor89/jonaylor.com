package com.paperclock.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import androidx.core.content.ContextCompat
import com.paperclock.PaperClockApp
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class AlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val id = intent.getLongExtra(EXTRA_ALARM_ID, -1); if (id < 0) return
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val app = context.applicationContext as PaperClockApp
                val row = app.container.repository.alarm(id) ?: return@launch
                if (!row.alarm.enabled) return@launch
                ContextCompat.startForegroundService(context, Intent(context, AlarmSoundService::class.java).putExtra(EXTRA_ALARM_ID, id))
                context.startActivity(Intent(context, AlarmActivity::class.java).putExtra(EXTRA_ALARM_ID, id).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP))
                if (row.alarm.repeatDays.isBlank()) app.container.repository.saveAlarm(row.alarm.copy(enabled = false)) else app.container.scheduler.reschedule(row.alarm)
            } finally { pending.finish() }
        }
    }
    companion object { const val EXTRA_ALARM_ID = "com.paperclock.extra.ALARM_ID" }
}
