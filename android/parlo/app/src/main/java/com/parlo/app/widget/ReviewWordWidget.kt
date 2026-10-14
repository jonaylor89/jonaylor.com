package com.parlo.app.widget

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.GlanceModifier
import androidx.glance.GlanceTheme
import androidx.glance.LocalContext
import androidx.glance.action.ActionParameters
import androidx.glance.action.clickable
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.action.ActionCallback
import androidx.glance.appwidget.action.actionRunCallback
import androidx.glance.appwidget.appWidgetBackground
import androidx.glance.appwidget.cornerRadius
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.updateAppWidgetState
import androidx.glance.background
import androidx.glance.currentState
import androidx.glance.layout.Alignment
import androidx.glance.layout.Box
import androidx.glance.layout.Column
import androidx.glance.layout.Row
import androidx.glance.layout.Spacer
import androidx.glance.layout.fillMaxSize
import androidx.glance.layout.height
import androidx.glance.layout.padding
import androidx.glance.layout.width
import androidx.glance.semantics.contentDescription
import androidx.glance.semantics.semantics
import androidx.glance.state.PreferencesGlanceStateDefinition
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.Text
import androidx.glance.text.TextStyle
import com.parlo.app.ParloApp

/** One saved word: tap to reveal, then Next. Which word and whether it's revealed live in Glance state. */
class ReviewWordWidget : GlanceAppWidget() {
    override val sizeMode = SizeMode.Exact
    override val stateDefinition = PreferencesGlanceStateDefinition

    override suspend fun provideGlance(context: Context, id: GlanceId) {
        val flow = (context.applicationContext as ParloApp).container.widgetData
        provideContent {
            val data by flow.collectAsState()
            val prefs = currentState<Preferences>()
            ParloWidgetTheme(data.dynamicColor) { ReviewWordContent(data.reviewWords, prefs[WORD_ID], prefs[REVEALED] ?: false) }
        }
    }

    companion object {
        internal val WORD_ID = longPreferencesKey("word_id")
        internal val REVEALED = booleanPreferencesKey("revealed")

        /** The word to show: the stored one if it still exists, else the newest. */
        fun current(words: List<ReviewWord>, id: Long?): ReviewWord? = words.firstOrNull { it.id == id } ?: words.firstOrNull()

        /** Older word next, wrapping round to the newest. */
        fun next(words: List<ReviewWord>, id: Long?): ReviewWord? {
            if (words.isEmpty()) return null
            val i = words.indexOfFirst { it.id == id }
            return words[(i + 1).mod(words.size)]
        }
    }
}

class ReviewWordWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = ReviewWordWidget()
}

class RevealWordAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        updateAppWidgetState(context, glanceId) { it[ReviewWordWidget.REVEALED] = !(it[ReviewWordWidget.REVEALED] ?: false) }
        ReviewWordWidget().update(context, glanceId)
    }
}

class NextWordAction : ActionCallback {
    override suspend fun onAction(context: Context, glanceId: GlanceId, parameters: ActionParameters) {
        val words = (context.applicationContext as ParloApp).container.widgetData.value.reviewWords
        updateAppWidgetState(context, glanceId) { p ->
            ReviewWordWidget.next(words, ReviewWordWidget.current(words, p[ReviewWordWidget.WORD_ID])?.id)?.let { p[ReviewWordWidget.WORD_ID] = it.id }
            p[ReviewWordWidget.REVEALED] = false
        }
        ReviewWordWidget().update(context, glanceId)
    }
}

@Composable
internal fun ReviewWordContent(words: List<ReviewWord>, wordId: Long?, revealed: Boolean) {
    val context = LocalContext.current
    val word = ReviewWordWidget.current(words, wordId)
    Box(
        GlanceModifier.fillMaxSize().appWidgetBackground().background(GlanceTheme.colors.surface)
            .cornerRadius(android.R.dimen.system_app_widget_background_radius).padding(16.dp),
    ) {
        if (word == null) {
            Column(GlanceModifier.fillMaxSize().clickable(openApp(context))) {
                Label()
                Spacer(GlanceModifier.height(6.dp))
                Text("Words you save on walks show up here.", style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 15.sp))
            }
            return@Box
        }
        Column(GlanceModifier.fillMaxSize()) {
            Label()
            Spacer(GlanceModifier.height(4.dp))
            Column(GlanceModifier.defaultWeight().clickable(actionRunCallback<RevealWordAction>()).semantics { contentDescription = if (revealed) "Hide translation" else "Reveal translation" }) {
                Text(word.word, maxLines = 2, style = TextStyle(color = GlanceTheme.colors.onSurface, fontSize = 22.sp, fontWeight = FontWeight.Bold, fontFamily = FontFamily.Serif))
                Text(
                    if (revealed) word.translation.ifBlank { "No translation saved" } else "Tap to reveal",
                    maxLines = 2,
                    style = TextStyle(color = if (revealed) GlanceTheme.colors.onSurface else GlanceTheme.colors.onSurfaceVariant, fontSize = 14.sp),
                )
                if (revealed && word.example.isNotBlank()) {
                    Text(word.example, maxLines = 1, style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
                }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Box(
                    GlanceModifier.height(40.dp).cornerRadius(20.dp).background(GlanceTheme.colors.secondaryContainer).padding(horizontal = 16.dp)
                        .clickable(actionRunCallback<NextWordAction>()).semantics { contentDescription = "Next word" },
                    contentAlignment = Alignment.Center,
                ) { Text("Next", style = TextStyle(color = GlanceTheme.colors.onSecondaryContainer, fontSize = 14.sp, fontWeight = FontWeight.Medium)) }
                Spacer(GlanceModifier.width(8.dp))
                Text("${words.size} saved", style = TextStyle(color = GlanceTheme.colors.onSurfaceVariant, fontSize = 12.sp))
            }
        }
    }
}

@Composable
private fun Label() = Text("REVIEW A WORD", style = TextStyle(color = GlanceTheme.colors.primary, fontSize = 11.sp, fontWeight = FontWeight.Medium))
