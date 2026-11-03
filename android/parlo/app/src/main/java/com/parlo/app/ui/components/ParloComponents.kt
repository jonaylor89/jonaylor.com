package com.parlo.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.CheckCircle
import androidx.compose.material.icons.automirrored.rounded.DirectionsWalk
import androidx.compose.material.icons.rounded.Hearing
import androidx.compose.material.icons.rounded.Key
import androidx.compose.material.icons.rounded.Sync
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Snackbar
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import com.parlo.app.model.LearnerProfile
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloMotion
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.theme.ParloSpacing

/** Small all-caps label above a title ("YOUR TUTOR SUGGESTS", "PHRASE FROM YOUR WALK"). */
@Composable
fun Overline(text: String, modifier: Modifier = Modifier, color: Color = Color.Unspecified, icon: ImageVector? = null) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically) {
        if (icon != null) {
            Icon(icon, null, Modifier.size(16.dp), tint = if (color == Color.Unspecified) androidx.compose.material3.LocalContentColor.current else color)
            Spacer(Modifier.width(ParloSpacing.space1 + 2.dp))
        }
        Text(text.uppercase(), style = MaterialTheme.typography.labelSmall, color = color)
    }
}

/** Filled in by update_learner_profile during the onboarding walk. Goals live on Sunpath (secondary). */
@Composable
fun ProfileTiles(p: LearnerProfile) {
    Column(Modifier.fillMaxWidth().padding(bottom = ParloSpacing.space3).testTag("profile_tiles"), verticalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
        Overline("Your tutor is setting up", color = MaterialTheme.colorScheme.secondary, modifier = Modifier.padding(bottom = ParloSpacing.space2))
        Row(horizontalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
            ProfileTile("Language", p.language, Modifier.weight(1f), RoundedCornerShape(topStart = 16.dp, topEnd = 4.dp, bottomStart = 4.dp, bottomEnd = 4.dp))
            ProfileTile("Accent", p.dialect, Modifier.weight(1f), RoundedCornerShape(topStart = 4.dp, topEnd = 16.dp, bottomStart = 4.dp, bottomEnd = 4.dp))
        }
        Row(horizontalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
            ProfileTile("Goal", p.goal, Modifier.weight(1f), RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp, bottomStart = 16.dp, bottomEnd = 4.dp))
            ProfileTile("Level", p.level, Modifier.weight(1f), RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp, bottomStart = 4.dp, bottomEnd = 16.dp))
        }
    }
}

@Composable
fun ProfileTile(label: String, value: String, modifier: Modifier, shape: androidx.compose.ui.graphics.Shape = ParloShape.medium) {
    val filled = value.isNotBlank()
    val scheme = MaterialTheme.colorScheme
    val bg by animateColorAsState(if (filled) scheme.secondaryContainer else scheme.surfaceContainerHigh, ParloMotion.effects(), label = "tile")
    Surface(modifier, shape = shape, color = bg, contentColor = if (filled) scheme.onSecondaryContainer else scheme.onSurfaceVariant) {
        Column(Modifier.padding(horizontal = ParloSpacing.space3, vertical = ParloSpacing.space2)) {
            Text(label.uppercase(), style = MaterialTheme.typography.labelSmall)
            Text(value.ifBlank { "Asking…" }, style = MaterialTheme.typography.titleSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
    }
}

/**
 * A phrase the tutor raises (show_phrase): the tutor speaking visually, so Persimmon's container.
 * One phrase in the hero serif, its meaning in sans beneath.
 */
@Composable
fun PhraseCard(phrase: String, meaning: String, modifier: Modifier = Modifier, overline: String = "Try saying", actions: @Composable RowScope.() -> Unit = {}) {
    Surface(
        modifier.fillMaxWidth(),
        shape = ParloShape.extraLarge,
        color = MaterialTheme.colorScheme.tertiaryContainer,
        contentColor = MaterialTheme.colorScheme.onTertiaryContainer,
    ) {
        Column(Modifier.padding(ParloSpacing.space5), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
            Overline(overline)
            Text(phrase, style = Parlo.type.phraseHero, maxLines = 4, overflow = TextOverflow.Ellipsis)
            if (meaning.isNotBlank()) Text(meaning, style = MaterialTheme.typography.bodyLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space2), content = actions)
        }
    }
}

/** Inline status for connection and configuration problems, phrased so a walker is never alarmed. */
@Composable
fun StatusBanner(
    title: String,
    body: String,
    modifier: Modifier = Modifier,
    icon: ImageVector = Icons.Rounded.Sync,
    error: Boolean = false,
    content: @Composable ColumnScope.() -> Unit = {},
) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        modifier.fillMaxWidth().semantics { liveRegion = if (error) LiveRegionMode.Assertive else LiveRegionMode.Polite },
        shape = ParloShape.large,
        color = if (error) scheme.errorContainer else scheme.surfaceContainerHighest,
        contentColor = if (error) scheme.onErrorContainer else scheme.onSurface,
    ) {
        Row(Modifier.padding(ParloSpacing.space4), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space3)) {
            Icon(icon, null)
            Column(Modifier.weight(1f)) {
                Text(title, style = MaterialTheme.typography.titleSmall)
                if (body.isNotBlank()) {
                    Text(body, style = MaterialTheme.typography.bodyMedium, color = if (error) scheme.onErrorContainer else scheme.onSurfaceVariant)
                }
                content()
            }
        }
    }
}

/** In-walk control at the walk target size (72dp), icon at 36dp, its word beside it. */
@Composable
fun WalkControl(
    icon: ImageVector,
    label: String,
    onClick: () -> Unit,
    container: Color,
    content: Color,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    Surface(
        onClick = onClick,
        enabled = enabled,
        shape = if (pressed) ParloShape.extraLarge else ParloShape.full,
        color = container,
        contentColor = content,
        interactionSource = interaction,
        modifier = modifier.heightIn(min = ParloSize.targetWalk),
    ) {
        Row(Modifier.padding(horizontal = ParloSpacing.space5), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(ParloSize.iconWalk))
            Spacer(Modifier.width(ParloSpacing.space3))
            Text(label, style = MaterialTheme.typography.titleLarge, maxLines = 1)
        }
    }
}

enum class WalkFabState { READY, SETUP, RUNNING }

/**
 * The one big way into a walk: always says what will happen and in which language. The only
 * primary-filled element on Home. Morphs one shape step tighter while pressed.
 */
@Composable
fun WalkFab(
    state: WalkFabState,
    subLabel: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val (icon, label) = when (state) {
        WalkFabState.READY -> Icons.AutoMirrored.Rounded.DirectionsWalk to "Start walk"
        WalkFabState.SETUP -> Icons.Rounded.Key to "Finish setup"
        WalkFabState.RUNNING -> Icons.Rounded.Hearing to "Back to your walk"
    }
    val setup = state == WalkFabState.SETUP
    Surface(
        onClick = onClick,
        shape = if (pressed) ParloShape.large else ParloShape.extraLarge,
        color = if (setup) scheme.secondaryContainer else scheme.primary,
        contentColor = if (setup) scheme.onSecondaryContainer else scheme.onPrimary,
        shadowElevation = if (pressed) 8.dp else 6.dp,
        interactionSource = interaction,
        modifier = modifier.heightIn(min = ParloSize.fabLarge),
    ) {
        Row(Modifier.padding(horizontal = 28.dp, vertical = ParloSpacing.space4), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(ParloSize.iconWalk))
            Spacer(Modifier.width(ParloSpacing.space4))
            Column(Modifier.weight(1f)) {
                Text(label, style = MaterialTheme.typography.titleLarge)
                if (subLabel.isNotBlank()) {
                    Text(
                        subLabel,
                        style = if (setup) MaterialTheme.typography.bodyMedium else Parlo.type.phraseGloss.copy(fontSize = MaterialTheme.typography.bodyLarge.fontSize),
                        maxLines = 2, overflow = TextOverflow.Ellipsis,
                    )
                }
            }
        }
    }
}

/** Snackbars on inverse-surface, the action in inverse-primary, shape-small corners. */
@Composable
fun ParloSnackbarHost(state: SnackbarHostState, modifier: Modifier = Modifier) {
    SnackbarHost(state, modifier) { data -> Snackbar(data, shape = ParloShape.small) }
}

/** A setup step that ticks when done (welcome screen). */
@Composable
fun StepRow(done: Boolean, icon: ImageVector, title: String, body: String, onClick: () -> Unit, modifier: Modifier = Modifier, busy: Boolean = false, shape: androidx.compose.ui.graphics.Shape = ParloShape.large) {
    val scheme = MaterialTheme.colorScheme
    Card(
        onClick = onClick,
        modifier = modifier.fillMaxWidth(),
        shape = shape,
        colors = CardDefaults.cardColors(
            containerColor = if (done) scheme.primaryContainer else scheme.surfaceContainer,
            contentColor = if (done) scheme.onPrimaryContainer else scheme.onSurface,
        ),
    ) {
        Row(Modifier.padding(ParloSpacing.space4).heightIn(min = 40.dp), verticalAlignment = Alignment.CenterVertically) {
            when {
                busy -> CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
                done -> Icon(Icons.Rounded.CheckCircle, "Done")
                else -> Icon(icon, null)
            }
            Spacer(Modifier.width(ParloSpacing.space4))
            Column {
                Text(title, style = MaterialTheme.typography.titleMedium)
                Text(body, style = MaterialTheme.typography.bodyMedium, color = if (done) scheme.onPrimaryContainer else scheme.onSurfaceVariant)
            }
        }
    }
}

