package com.parlo.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.background
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.fillMaxWidth
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextAlign
import androidx.glance.text.TextStyle
import com.parlo.app.ParloApp
import java.time.format.TextStyle as DayStyle
import java.util.Locale

/** The last 7 days: real minutes walked, walks and words saved. */
class ThisWeekWidget : GlanceAppWidget() {
    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val flow = (context.applicationContext as ParloApp).container.widgetData
        provideContent {
            val data by flow.collectAsState()
            ParloWidgetTheme(data.dynamicColor) { ThisWeekContent(data.week) }
        }
    }
}

class ThisWeekWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ThisWeekWidget()
}

@Composable
internal fun ThisWeekContent(week: List<WeekDay>) {
    val context = LocalContext.current
    val minutes = week.sumOf { it.minutes }
    val walks = week.sumOf { it.walks }
    val words = week.sumOf { it.words }
    Column(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(GlanceTheme.colors.surface)
            .cornerRadius(android.R.dimen.system_app_widget_background_radius).padding(16.dp).clickable(openApp(context)),
    ) {
        Text("THIS WEEK", style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 11.sp, fontWeight = FontWeight.Medium))
        Spacer(GlanceModifier.height(4.dp))
        Row(GlanceModifier.fillMaxWidth()) {
            Stat("$minutes", "min", GlanceModifier.defaultWeight())
            Stat("$walks", if (walks == 1) "walk" else "walks", GlanceModifier.defaultWeight())
            Stat("$words", if (words == 1) "word" else "words", GlanceModifier.defaultWeight())
        }
        Spacer(GlanceModifier.defaultWeight())
        Row(GlanceModifier.fillMaxWidth()) {
            week.forEach { d ->
                Column(GlanceModifier.defaultWeight(), horizontalAlignment = Alignment.CenterHorizontally) {
                    Box(
                        GlanceModifier.width(20.dp).height(20.dp).cornerRadius(10.dp)
                            .background(if (d.walks > 0) GlanceTheme.colors.primary else GlanceTheme.colors.surfaceVariant),
                    ) {}
                    Text(
                        d.date.dayOfWeek.getDisplayName(DayStyle.NARROW, Locale.getDefault()),
                        style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 11.sp, textAlign = TextAlign.Center),
                    )
                }
            }
        }
    }
}

@Composable
private fun Stat(value: String, label: String, modifier: GlanceModifier) {
    Column(modifier) {
        Text(value, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 24.sp, fontWeight = FontWeight.Bold))
        Text(label, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
    }
}
