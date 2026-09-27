package com.paperclock.alarm

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.paperclock.PaperClockApp
import com.paperclock.widget.WidgetUpdater
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        val pending = goAsync()
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val app = context.applicationContext as PaperClockApp
                app.container.repository.enabledAlarms().forEach(app.container.scheduler::schedule)
                WidgetUpdater.updateAll(context)
            } finally { pending.finish() }
        }
    }
}
