package com.parlo.app.widget

import android.content.Context
import android.graphics.Color
import android.view.View
import android.widget.FrameLayout
import android.widget.LinearLayout
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.glance.appwidget.ExperimentalGlanceRemoteViewsApi
import androidx.glance.appwidget.GlanceRemoteViews
import androidx.test.core.app.ApplicationProvider
import kotlinx.coroutines.runBlocking
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.time.LocalDate

/** Renders the real Glance output (RemoteViews applied to views) for each widget, size and state. */
@OptIn(ExperimentalGlanceRemoteViewsApi::class)
@RunWith(com.parlo.app.uiaudit.KeystoreRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h915dp-xxhdpi")
class WidgetRenderTest {
    private val out = java.io.File("build/widgets").apply { mkdirs() }

    private val suggested = WidgetData(
        next = NextWalk("Haggling at the market", "Practise: fui vs ha ido", suggested = true),
        canStartDirect = true,
        reviewWords = listOf(ReviewWord(1, "madrugar", "to get up early", "Mañana tengo que madrugar."), ReviewWord(2, "fui", "I went", "")),
        week = (6 downTo 0).map { b -> WeekDay(LocalDate.of(2026, 10, 14).minusDays(b.toLong()), listOf(12, 0, 8, 0, 15, 20, 9)[6 - b], if (b % 2 == 0) 1 else 0, b) },
    )
    private val live = suggested.copy(live = LiveWalk(System.currentTimeMillis() - 7 * 60_000 - 12_000, words = 3, muted = false, connecting = false, ending = false))

    @Test fun next_walk_sizes_light() = sizes("light")
    @Test fun next_walk_sizes_dark() { RuntimeEnvironment.setQualifiers("+night"); sizes("dark") }

    private fun sizes(mode: String) {
        board("W1_next_walk_$mode", listOf(NextWalkWidget.SMALL, NextWalkWidget.MEDIUM, NextWalkWidget.LARGE)) { NextWalkContent(suggested) }
        board("W2_next_walk_live_$mode", listOf(NextWalkWidget.SMALL, NextWalkWidget.MEDIUM, NextWalkWidget.LARGE)) { NextWalkContent(live) }
        board("W3_review_week_$mode", listOf(DpSize(180.dp, 160.dp))) { ReviewWordContent(suggested.reviewWords, 1, revealed = false) }
        board("W4_review_revealed_$mode", listOf(DpSize(180.dp, 160.dp))) { ReviewWordContent(suggested.reviewWords, 1, revealed = true) }
        board("W5_this_week_$mode", listOf(DpSize(260.dp, 160.dp))) { ThisWeekContent(suggested.week) }
    }

    @Test fun first_run_and_empty() {
        board("W6_first_run", listOf(NextWalkWidget.MEDIUM, NextWalkWidget.LARGE)) { NextWalkContent(WidgetData(next = NextWalk(subtitle = "Your tutor asks what you want to learn"))) }
        board("W7_review_empty", listOf(DpSize(180.dp, 160.dp))) { ReviewWordContent(emptyList(), null, false) }
    }

    private fun board(name: String, sizes: List<DpSize>, content: @Composable () -> Unit) {
        val context: Context = ApplicationProvider.getApplicationContext()
        val density = context.resources.displayMetrics.density
        val row = LinearLayout(context).apply { setBackgroundColor(Color.rgb(0x8A, 0x9B, 0xA8)); setPadding(24, 24, 24, 24) }
        sizes.forEach { size ->
            val result = runBlocking { GlanceRemoteViews().compose(context, size) { ParloWidgetTheme(false, content) } }
            val host = FrameLayout(context)
            host.addView(result.remoteViews.apply(context, host))
            row.addView(host, LinearLayout.LayoutParams((size.width.value * density).toInt(), (size.height.value * density).toInt()).apply { marginEnd = 24 })
        }
        val w = row.paddingLeft + row.paddingRight + sizes.sumOf { (it.width.value * density).toInt() + 24 }
        val h = row.paddingTop + row.paddingBottom + (sizes.maxOf { it.height.value } * density).toInt()
        row.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY))
        row.layout(0, 0, w, h)
        val bmp = android.graphics.Bitmap.createBitmap(w, h, android.graphics.Bitmap.Config.ARGB_8888)
        row.draw(android.graphics.Canvas(bmp))
        java.io.File(out, "$name.png").outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
    }
}
