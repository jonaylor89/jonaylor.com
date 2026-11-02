package com.parlo.app.ui.main

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.rounded.Notes
import androidx.compose.material.icons.rounded.BookmarkAdded
import androidx.compose.material.icons.rounded.Mic
import androidx.compose.material.icons.rounded.MicOff
import androidx.compose.material.icons.rounded.Replay
import androidx.compose.material.icons.rounded.Stop
import androidx.compose.material.icons.rounded.Translate
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
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
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.parlo.app.model.AudioState
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LiveSessionState
import com.parlo.app.model.Speaker
import com.parlo.app.ui.components.OrbState
import com.parlo.app.ui.components.PhraseCard
import com.parlo.app.ui.components.ProfileTiles
import com.parlo.app.ui.components.StatusBanner
import com.parlo.app.ui.components.VoiceOrb
import com.parlo.app.ui.components.WalkControl
import com.parlo.app.ui.components.orbState
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloMotion
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.theme.ParloSpacing
import com.parlo.app.ui.theme.SunlightAwareTheme

/**
 * One-second glance: one shape, one state word, two big controls. Everything else is secondary and
 * the transcript is one tap away, never on by default. Switches to high contrast in bright sunlight.
 */
@Composable
fun WalkScreen(
    live: LiveSessionState,
    onToggleMute: () -> Unit,
    onSlower: () -> Unit,
    onEnglish: () -> Unit,
    onEnd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    SunlightAwareTheme {
        Surface(color = Parlo.colors.walkGround, modifier = Modifier.fillMaxSize()) {
            WalkContent(live, onToggleMute, onSlower, onEnglish, onEnd, modifier)
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun WalkContent(
    live: LiveSessionState,
    onToggleMute: () -> Unit,
    onSlower: () -> Unit,
    onEnglish: () -> Unit,
    onEnd: () -> Unit,
    modifier: Modifier,
) {
    var showTranscript by remember { mutableStateOf(false) }
    val connecting = live.connection == ConnectionState.CONNECTING || live.connection == ConnectionState.RECONNECTING
    val ending = live.connection == ConnectionState.ENDING
    val orb = live.orbState()
    val scheme = MaterialTheme.colorScheme
    BoxWithConstraints(modifier.fillMaxSize().testTag("walk_screen")) {
        val fontScale = LocalDensity.current.fontScale
        val shortSide = minOf(maxWidth, maxHeight)
        // Room for big text: at large font scales the orb shrinks to 40% of the short side.
        val fullOrb = if (fontScale > 1.3f) shortSide * 0.4f else minOf(ParloSize.orb, shortSide * 0.62f)
        val orbSize by animateDpAsState(if (live.phrase != null || live.profile != null) fullOrb * 0.62f else fullOrb, ParloMotion.spatial(), label = "orb-size")

        Column(Modifier.fillMaxSize(), horizontalAlignment = Alignment.CenterHorizontally) {
            Row(Modifier.fillMaxWidth().padding(vertical = ParloSpacing.space2), verticalAlignment = Alignment.CenterVertically) {
                Text(
                    live.config.topicTitle.ifBlank { if (live.profile != null) "First walk" else live.config.scenario.label },
                    style = MaterialTheme.typography.labelLarge,
                    color = scheme.onSurfaceVariant,
                    modifier = Modifier.weight(1f),
                    maxLines = 1, overflow = TextOverflow.Ellipsis,
                )
                Surface(shape = ParloShape.full, color = scheme.secondaryContainer, contentColor = scheme.onSecondaryContainer, modifier = Modifier.testTag("caught_count")) {
                    Row(Modifier.padding(horizontal = ParloSpacing.space3, vertical = ParloSpacing.space1 + 2.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.BookmarkAdded, "Words saved this walk", Modifier.size(18.dp))
                        Spacer(Modifier.width(ParloSpacing.space1 + 2.dp))
                        Text(live.caughtWords.size.toString(), style = MaterialTheme.typography.labelLarge)
                    }
                }
            }
            if (live.connection == ConnectionState.RECONNECTING) {
                StatusBanner("Reconnecting…", "Your conversation is safe. Keep walking.", modifier = Modifier.padding(bottom = ParloSpacing.space3))
            }

            Spacer(Modifier.height(ParloSpacing.space4))
            VoiceOrb(orb, size = orbSize)
            Spacer(Modifier.height(ParloSpacing.space6))
            // The state word is announced politely; the hint below adds what you can do.
            AnimatedContent(
                targetState = walkStateWord(orb, ending, connecting),
                transitionSpec = { fadeIn(ParloMotion.effects()) togetherWith fadeOut(ParloMotion.effects()) },
                label = "state-word",
                modifier = Modifier.semantics {
                    liveRegion = LiveRegionMode.Polite
                    contentDescription = stateLabel(live.audio, connecting, ending, live.muted)
                },
            ) { word ->
                Text(word, style = Parlo.type.walkState, textAlign = TextAlign.Center, color = scheme.onSurface)
            }
            val hint = walkStateHint(live.audio, connecting, ending, live.muted)
            if (hint.isNotBlank()) {
                Text(hint, style = MaterialTheme.typography.bodyLarge, color = scheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            Spacer(Modifier.height(ParloSpacing.space4))

            Column(
                Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState()),
                verticalArrangement = Arrangement.spacedBy(ParloSpacing.space3),
            ) {
                live.profile?.let { ProfileTiles(it) }
                live.phrase?.let { p -> PhraseCard(p.phrase, p.translation, Modifier.testTag("try_saying")) }
                live.caughtWords.lastOrNull()?.let { w ->
                    Text("Saved: $w", style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                }
                val last = live.transcript.lastOrNull { it.speaker == Speaker.TUTOR }
                if (last != null && live.phrase == null) {
                    Text(last.text, style = Parlo.type.phraseBody, color = scheme.onSurface, maxLines = 3, overflow = TextOverflow.Ellipsis)
                }
            }

            Row(Modifier.fillMaxWidth().padding(vertical = ParloSpacing.space2), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space2, Alignment.CenterHorizontally)) {
                val canAsk = !connecting && !ending
                OutlinedButton(onClick = onSlower, enabled = canAsk, modifier = Modifier.heightIn(min = ParloSize.targetMin)) {
                    Icon(Icons.Rounded.Replay, null, Modifier.size(18.dp)); Spacer(Modifier.width(ParloSpacing.space2)); Text("Slower")
                }
                OutlinedButton(onClick = onEnglish, enabled = canAsk, modifier = Modifier.heightIn(min = ParloSize.targetMin)) {
                    Icon(Icons.Rounded.Translate, null, Modifier.size(18.dp)); Spacer(Modifier.width(ParloSpacing.space2)); Text("English")
                }
                AnimatedVisibility(live.transcript.isNotEmpty()) {
                    TextButton(onClick = { showTranscript = true }, modifier = Modifier.heightIn(min = ParloSize.targetMin)) {
                        Icon(Icons.AutoMirrored.Rounded.Notes, null, Modifier.size(18.dp)); Spacer(Modifier.width(ParloSpacing.space2)); Text("Transcript")
                    }
                }
            }
            Row(Modifier.fillMaxWidth().padding(bottom = ParloSpacing.space3), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
                WalkControl(
                    icon = if (live.muted) Icons.Rounded.MicOff else Icons.Rounded.Mic,
                    label = if (live.muted) "Unmute" else "Mute",
                    onClick = onToggleMute,
                    container = if (live.muted) scheme.secondary else scheme.secondaryContainer,
                    content = if (live.muted) scheme.onSecondary else scheme.onSecondaryContainer,
                    modifier = Modifier.weight(1f),
                )
                WalkControl(
                    icon = Icons.Rounded.Stop,
                    label = if (ending) "Ending…" else "End",
                    onClick = onEnd,
                    enabled = !ending,
                    container = scheme.errorContainer,
                    content = scheme.onErrorContainer,
                    modifier = Modifier.weight(1f),
                )
            }
        }
    }
    if (showTranscript) {
        ModalBottomSheet(onDismissRequest = { showTranscript = false }, containerColor = scheme.surfaceContainerHigh) {
            Transcript(turns = live.transcript, modifier = Modifier.fillMaxWidth().height(480.dp).padding(horizontal = ParloSpacing.space4))
        }
    }
}

/** The single word under the orb, read at arm's length. */
internal fun walkStateWord(orb: OrbState, ending: Boolean, connecting: Boolean) = when {
    ending -> "Wrapping up"
    connecting -> "Connecting…"
    orb == OrbState.RECONNECTING -> "Reconnecting…"
    orb == OrbState.SPEAKING -> "Parlo is speaking"
    orb == OrbState.MUTED -> "Muted"
    orb == OrbState.THINKING -> "Thinking"
    else -> "Listening"
}

/** What you can do in this state, in your language. */
internal fun walkStateHint(audio: AudioState, connecting: Boolean, ending: Boolean, muted: Boolean) = when {
    ending -> "Writing your recap…"
    connecting -> "Your conversation is safe."
    audio == AudioState.SPEAKING -> if (muted) "Your mic is muted" else "Interrupt anytime"
    audio == AudioState.MUTED || muted -> "Parlo can't hear you"
    audio == AudioState.LISTENING -> ""
    else -> "Take your time"
}

/** The full spoken description of the walk state (TalkBack). */
internal fun stateLabel(audio: AudioState, connecting: Boolean, ending: Boolean, muted: Boolean = false) = when {
    ending -> "Writing your recap…"
    connecting -> "Connecting…"
    audio == AudioState.SPEAKING -> if (muted) "Parlo is speaking · mic muted" else "Parlo is speaking · interrupt anytime"
    audio == AudioState.MUTED -> "Muted"
    audio == AudioState.LISTENING -> "Listening…"
    else -> "Listening · take your time"
}
