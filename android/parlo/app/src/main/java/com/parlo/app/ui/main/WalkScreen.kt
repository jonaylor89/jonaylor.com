package com.parlo.app.ui.main

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.MenuBook
import androidx.compose.material.icons.filled.GraphicEq
import androidx.compose.material.icons.filled.Mic
import androidx.compose.material.icons.filled.MicOff
import androidx.compose.material.icons.filled.Replay
import androidx.compose.material.icons.filled.Stop
import androidx.compose.material.icons.filled.Translate
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.parlo.app.model.AudioState
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LearnerProfile
import com.parlo.app.model.LiveSessionState
import com.parlo.app.model.Speaker
import com.parlo.app.ui.components.HeroCard
import com.parlo.app.ui.components.ProfileTiles
import com.parlo.app.ui.components.StateOrb
import com.parlo.app.ui.components.WalkToolbar
import com.parlo.app.ui.components.WalkToolbarAction
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloSpacing

/** At-a-glance walk surface: who's talking, the phrase to try, words caught, and a thumb-sized toolbar. Follows the system theme. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun WalkScreen(
    live: LiveSessionState,
    onToggleMute: () -> Unit,
    onSlower: () -> Unit,
    onEnglish: () -> Unit,
    onEnd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showTranscript by remember { mutableStateOf(false) }
    val connecting = live.connection == ConnectionState.CONNECTING || live.connection == ConnectionState.RECONNECTING
    val ending = live.connection == ConnectionState.ENDING
    Column(modifier.fillMaxSize().testTag("walk_screen"), horizontalAlignment = Alignment.CenterHorizontally) {
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            Text(
                live.config.topicTitle.ifBlank { if (live.profile != null) "First walk" else live.config.scenario.label },
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier.weight(1f),
                maxLines = 1, overflow = TextOverflow.Ellipsis,
            )
            Surface(shape = RoundedCornerShape(8.dp), color = MaterialTheme.colorScheme.tertiaryContainer, modifier = Modifier.testTag("caught_count")) {
                Row(Modifier.padding(horizontal = 8.dp, vertical = 4.dp), verticalAlignment = Alignment.CenterVertically) {
                    Icon(Icons.AutoMirrored.Filled.MenuBook, "Words saved this walk", Modifier.size(16.dp), tint = MaterialTheme.colorScheme.onTertiaryContainer)
                    Spacer(Modifier.width(4.dp))
                    Text(live.caughtWords.size.toString(), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.onTertiaryContainer)
                }
            }
        }
        StateOrb(audio = live.audio, connecting = connecting, ending = ending)
        Spacer(Modifier.height(12.dp))
        Text(stateLabel(live.audio, connecting, ending, live.muted), style = MaterialTheme.typography.titleMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
        Spacer(Modifier.height(16.dp))
        live.profile?.let { ProfileTiles(it) }
        Column(Modifier.weight(1f).fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            live.phrase?.let { p ->
                HeroCard(
                    eyebrow = "Try saying",
                    title = p.phrase,
                    subtitle = p.translation,
                    container = Parlo.roles.phrase,
                    onContainer = Parlo.roles.onPhrase,
                    modifier = Modifier.testTag("try_saying"),
                )
            }
            live.caughtWords.lastOrNull()?.let { w ->
                Text("Saved: $w", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            val last = live.transcript.lastOrNull { it.speaker == Speaker.TUTOR }
            if (last != null) {
                Text(last.text, style = MaterialTheme.typography.bodyLarge, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            if (live.transcript.isNotEmpty()) TextButton(onClick = { showTranscript = true }) { Text("Show transcript") }
        }
        WalkToolbar(Modifier.padding(bottom = ParloSpacing.md)) {
            run {
                WalkToolbarAction(if (live.muted) Icons.Filled.MicOff else Icons.Filled.Mic, if (live.muted) "Unmute" else "Mute", onToggleMute, highlight = live.muted)
                WalkToolbarAction(Icons.Filled.Replay, "Slower", onSlower, enabled = !connecting && !ending)
                WalkToolbarAction(Icons.Filled.Translate, "English", onEnglish, enabled = !connecting && !ending)
                WalkToolbarAction(Icons.Filled.Stop, if (ending) "Ending…" else "End", onEnd, enabled = !ending, destructive = true)
            }
        }
    }
    if (showTranscript) {
        ModalBottomSheet(onDismissRequest = { showTranscript = false }) {
            Transcript(turns = live.transcript, modifier = Modifier.fillMaxWidth().height(480.dp).padding(horizontal = 16.dp))
        }
    }
}

internal fun stateLabel(audio: AudioState, connecting: Boolean, ending: Boolean, muted: Boolean = false) = when {
    ending -> "Writing your recap…"
    connecting -> "Connecting…"
    audio == AudioState.SPEAKING -> if (muted) "Parlo is speaking · mic muted" else "Parlo is speaking · interrupt anytime"
    audio == AudioState.MUTED -> "Muted"
    audio == AudioState.LISTENING -> "Listening…"
    else -> "Listening · take your time"
}
