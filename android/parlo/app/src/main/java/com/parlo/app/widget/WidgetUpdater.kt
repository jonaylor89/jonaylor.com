package com.parlo.app.widget

import android.content.Context
import androidx.glance.appwidget.updateAll
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.FlowPreview
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.debounce
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.launch

/**
 * Event-driven refresh: widgets re-render only when what they show changes (a walk starts/ends,
 * mute, a word is saved, a recap lands). No timers; the walk clock ticks by itself.
 */
object WidgetUpdater {
    @OptIn(FlowPreview::class)
    fun start(context: Context, data: StateFlow<WidgetData>, scope: CoroutineScope) {
        val app = context.applicationContext
        scope.launch {
            data.drop(1).distinctUntilChanged().debounce(300).collect {
                runCatching {
                    NextWalkWidget().updateAll(app)
                    ReviewWordWidget().updateAll(app)
                    ThisWeekWidget().updateAll(app)
                }
            }
        }
    }
}
