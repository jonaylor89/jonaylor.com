@file:Suppress("unused")
package com.parlo.app.ui.components

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
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloMotion
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSpacing
import androidx.compose.material.icons.filled.CheckCircle

import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LearnerProfile
import com.parlo.app.model.LiveSessionState
import com.parlo.app.model.Speaker

@Composable
fun StateOrb(audio: AudioState, connecting: Boolean, ending: Boolean) {
    val roles = Parlo.roles
    val speaking = audio == AudioState.SPEAKING
    val quiet = connecting || ending || audio == AudioState.MUTED
    val color by animateColorAsState(if (quiet) roles.idle else if (speaking) roles.speaking else roles.listening, ParloMotion.state(), label = "orb")
    Box(Modifier.size(160.dp).background(color, CircleShape).testTag("state_orb"), contentAlignment = Alignment.Center) {
        Icon(
            if (speaking) Icons.Filled.GraphicEq else if (audio == AudioState.MUTED) Icons.Filled.MicOff else Icons.Filled.Mic,
            contentDescription = null,
            modifier = Modifier.size(ParloSpacing.walkTarget),
            tint = if (quiet) roles.onIdle else if (speaking) roles.onSpeaking else roles.onListening,
        )
    }
}

/** Filled in by update_learner_profile during the onboarding walk. */
@Composable
fun ProfileTiles(p: LearnerProfile) {
    Column(Modifier.fillMaxWidth().padding(bottom = 12.dp).testTag("profile_tiles"), verticalArrangement = Arrangement.spacedBy(8.dp)) {
        Text("Your tutor is setting up", style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ProfileTile("Language", p.language, Modifier.weight(1f))
            ProfileTile("Accent", p.dialect, Modifier.weight(1f))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            ProfileTile("Goal", p.goal, Modifier.weight(1f))
            ProfileTile("Level", p.level, Modifier.weight(1f))
        }
    }
}

@Composable
fun ProfileTile(label: String, value: String, modifier: Modifier) {
    val filled = value.isNotBlank()
    val content: @Composable () -> Unit = {
        Column(Modifier.padding(horizontal = 12.dp, vertical = 8.dp)) {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall)
            Text(value.ifBlank { "Asking…" }, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
    if (filled) Card(modifier, shape = ParloShape.tile, colors = CardDefaults.cardColors(containerColor = Parlo.roles.confirmed, contentColor = Parlo.roles.onConfirmed)) { content() }
    else OutlinedCard(modifier, shape = ParloShape.tile) { content() }
}

@Composable
fun WalkToolbarAction(icon: ImageVector, label: String, onClick: () -> Unit, enabled: Boolean = true, highlight: Boolean = false, destructive: Boolean = false) {
    val scheme = MaterialTheme.colorScheme
    Column(horizontalAlignment = Alignment.CenterHorizontally, modifier = Modifier.width(72.dp)) {
        FilledTonalIconButton(
            onClick = onClick,
            enabled = enabled,
            modifier = Modifier.size(ParloSpacing.walkTarget),
            colors = when {
                destructive -> IconButtonDefaults.filledTonalIconButtonColors(containerColor = scheme.errorContainer, contentColor = scheme.onErrorContainer)
                highlight -> IconButtonDefaults.filledTonalIconButtonColors(containerColor = scheme.error, contentColor = scheme.onError)
                else -> IconButtonDefaults.filledTonalIconButtonColors(containerColor = scheme.surfaceVariant, contentColor = scheme.onSurfaceVariant)
            },
        ) { Icon(icon, contentDescription = label) }
        Text(label, style = MaterialTheme.typography.labelSmall, textAlign = TextAlign.Center)
    }
}

/** Small all-caps label above a title ("YOUR TUTOR SUGGESTS", "TRY SAYING"). */
@Composable
fun Eyebrow(text: String, modifier: Modifier = Modifier, color: androidx.compose.ui.graphics.Color = androidx.compose.ui.graphics.Color.Unspecified) {
    Text(text.uppercase(), style = MaterialTheme.typography.labelMedium, color = color, modifier = modifier)
}

/** The one big card a screen is about: the next walk on home, the phrase on the walk screen. */
@Composable
fun HeroCard(
    eyebrow: String,
    title: String,
    modifier: Modifier = Modifier,
    container: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primaryContainer,
    onContainer: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.onPrimaryContainer,
    subtitle: String = "",
    content: @Composable androidx.compose.foundation.layout.ColumnScope.() -> Unit = {},
) {
    Card(modifier.fillMaxWidth(), shape = ParloShape.hero, colors = CardDefaults.cardColors(containerColor = container, contentColor = onContainer)) {
        Column(Modifier.padding(ParloSpacing.xl - 4.dp), verticalArrangement = Arrangement.spacedBy(ParloSpacing.md - 2.dp)) {
            Eyebrow(eyebrow)
            Text(title, style = MaterialTheme.typography.headlineMedium)
            if (subtitle.isNotBlank()) Text(subtitle, style = MaterialTheme.typography.bodyMedium)
            content()
        }
    }
}

/** The floating walk toolbar: equal-weight actions, End visually distinct but not dominant. */
@Composable
fun WalkToolbar(modifier: Modifier = Modifier, actions: @Composable androidx.compose.foundation.layout.RowScope.() -> Unit) {
    Surface(shape = ParloShape.hero, tonalElevation = 3.dp, shadowElevation = 3.dp, modifier = modifier) {
        Row(Modifier.padding(ParloSpacing.sm), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.sm), content = actions)
    }
}

/** A setup step that ticks when done (welcome screen). */
@Composable
fun StepRow(done: Boolean, icon: ImageVector, title: String, body: String, onClick: () -> Unit, modifier: Modifier = Modifier, busy: Boolean = false) {
    Card(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        shape = ParloShape.card,
        colors = CardDefaults.cardColors(
            containerColor = if (done) Parlo.roles.confirmed else MaterialTheme.colorScheme.surfaceVariant,
            contentColor = if (done) Parlo.roles.onConfirmed else MaterialTheme.colorScheme.onSurfaceVariant,
        ),
    ) {
        Row(Modifier.padding(ParloSpacing.lg), verticalAlignment = Alignment.CenterVertically) {
            when {
                busy -> androidx.compose.material3.CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                done -> Icon(androidx.compose.material.icons.Icons.Filled.CheckCircle, "Done")
                else -> Icon(icon, null)
            }
            Spacer(Modifier.width(ParloSpacing.md + 2.dp))
            Column {
                Text(title, style = MaterialTheme.typography.titleSmall)
                Text(body, style = MaterialTheme.typography.bodySmall)
            }
        }
    }
}
