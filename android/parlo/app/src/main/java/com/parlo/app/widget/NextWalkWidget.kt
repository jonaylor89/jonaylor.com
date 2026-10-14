package com.parlo.app.widget

import android.content.Context
import android.os.SystemClock
import android.widget.RemoteViews
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.LocalContext
import androidx.glance.LocalSize
import androidx.glance.action.Action
import androidx.glance.action.clickable
import androidx.glance.appwidget.AndroidRemoteViews
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
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
import androidx.glance.layout.size
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import com.parlo.app.ParloApp
import com.parlo.app.R
import com.parlo.app.service.LiveSessionService

/** Next walk: "Your tutor suggests" + Start when idle; elapsed time, words, Mute and End during a walk. */
class NextWalkWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Responsive(setOf(SMALL, MEDIUM, LARGE))

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val flow = (context.applicationContext as ParloApp).container.widgetData
        provideContent {
            val data by flow.collectAsState()
            ParloWidgetTheme(data.dynamicColor) { NextWalkContent(data) }
        }
    }

    companion object {
        val SMALL = DpSize(57.dp, 57.dp)
        val MEDIUM = DpSize(130.dp, 130.dp)
        val LARGE = DpSize(250.dp, 180.dp)
    }
}

class NextWalkWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = NextWalkWidget()
}

@Composable
internal fun NextWalkContent(data: WidgetData) {
    val context = LocalContext.current
    val size = LocalSize.current
    val live = data.live
    val small = size.width < NextWalkWidget.MEDIUM.width || size.height < NextWalkWidget.MEDIUM.height
    val bg = if (live != null) GlanceTheme.colors.primaryContainer else GlanceTheme.colors.surface
    Box(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(bg).cornerRadius(android.R.dimen.system_app_widget_background_radius)
            .clickable(openApp(context)),
        contentAlignment = Alignment.Center,
    ) {
        when {
            small && live != null -> RoundButton(R.drawable.ic_widget_stop, "End walk", serviceAction(context, LiveSessionService.ACTION_END), primary = true)
            small -> RoundButton(R.drawable.ic_widget_play, "Start walk", startWalk(context, data), primary = true)
            live != null -> LiveLayout(live, large = size.height >= NextWalkWidget.LARGE.height)
            else -> IdleLayout(data, large = size.height >= NextWalkWidget.LARGE.height)
        }
    }
}

@Composable
private fun IdleLayout(data: WidgetData, large: Boolean) {
    val context = LocalContext.current
    Column(GlanceModifier.fillMaxSize().padding(16.dp)) {
        Text(
            if (data.next.suggested) "YOUR TUTOR SUGGESTS" else "YOUR NEXT WALK",
            style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 11.sp, fontWeight = FontWeight.Medium),
        )
        Spacer(GlanceModifier.height(4.dp))
        Text(
            data.next.title,
            maxLines = if (large) 3 else 2,
            style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = if (large) 22.sp else 17.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Serif),
        )
        if (large && data.next.subtitle.isNotBlank()) {
            Spacer(GlanceModifier.height(4.dp))
            Text(data.next.subtitle, maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 13.sp))
        }
        Spacer(GlanceModifier.defaultWeight())
        PillButton("Start walk", R.drawable.ic_widget_play, startWalk(context, data))
    }
}

@Composable
private fun LiveLayout(live: LiveWalk, large: Boolean) {
    val context = LocalContext.current
    val on = GlanceTheme.colors.onPrimaryContainer
    val state = when { live.ending -> "Writing your recap"; live.connecting -> "Connecting"; live.muted -> "Muted"; else -> "On a walk" }
    val words = "${live.words} ${if (live.words == 1) "word" else "words"}"
    val mute = serviceAction(context, LiveSessionService.ACTION_TOGGLE_MUTE)
    val end = serviceAction(context, LiveSessionService.ACTION_END)
    val muteIcon = if (live.muted) R.drawable.ic_widget_mic_off else R.drawable.ic_widget_mic
    val muteLabel = if (live.muted) "Unmute" else "Mute"
    Column(GlanceModifier.fillMaxSize().padding(16.dp)) {
        Text("${state.uppercase()} · $words", maxLines = 1, style = TextStyle(color = on, fontSize = 11.sp, fontWeight = FontWeight.Medium))
        Chronometer(live.startedAtMs, if (large) 40f else 28f)
        Spacer(GlanceModifier.defaultWeight())
        Row(GlanceModifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            val btn = if (large) 52.dp else 44.dp
            RoundButton(muteIcon, muteLabel, mute, primary = false, size = btn)
            Spacer(GlanceModifier.width(if (large) 12.dp else 8.dp))
            RoundButton(R.drawable.ic_widget_stop, "End walk", end, primary = true, size = btn)
        }
    }
}

/** Glance has no chronometer; a RemoteViews one ticks on its own, so the walk timer costs no widget updates. */
@Composable
private fun Chronometer(startedAtMs: Long, textSp: Float) {
    val context = LocalContext.current
    val views = RemoteViews(context.packageName, R.layout.widget_chronometer).apply {
        val base = SystemClock.elapsedRealtime() - (System.currentTimeMillis() - startedAtMs)
        setChronometer(R.id.widget_chronometer, base, null, true)
        setTextViewTextSize(R.id.widget_chronometer, android.util.TypedValue.COMPLEX_UNIT_SP, textSp)
    }
    AndroidRemoteViews(views, GlanceModifier.height((textSp * 1.3f).dp))
}

@Composable
internal fun PillButton(label: String, icon: Int, onClick: Action, modifier: GlanceModifier = GlanceModifier) {
    Row(
        modifier.height(48.dp).cornerRadius(24.dp).background(GlanceTheme.colors.primary).padding(horizontal = 18.dp)
            .clickable(onClick).semantics { contentDescription = label },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Image(ImageProvider(icon), null, GlanceModifier.size(20.dp), colorFilter = ColorFilter.tint(GlanceTheme.colors.onPrimary))
        Spacer(GlanceModifier.width(8.dp))
        Text(label, style = TextStyle(color = GlanceTheme.colors.onPrimary, fontSize = 15.sp, fontWeight = FontWeight.Medium))
    }
}

@Composable
internal fun RoundButton(icon: Int, label: String, onClick: Action, primary: Boolean, size: androidx.compose.ui.unit.Dp = 52.dp) {
    val bg: ColorProvider = if (primary) GlanceTheme.colors.primary else GlanceTheme.colors.surface
    val fg: ColorProvider = if (primary) GlanceTheme.colors.onPrimary else GlanceTheme.colors.onSurface
    Box(
        GlanceModifier.size(size).cornerRadius(size / 2).background(bg).clickable(onClick).semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        Image(ImageProvider(icon), label, GlanceModifier.size(24.dp), colorFilter = ColorFilter.tint(fg))
    }
}
