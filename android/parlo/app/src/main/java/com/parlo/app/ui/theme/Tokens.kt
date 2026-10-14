package com.parlo.app.ui.theme

import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.Spring
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Parlo design tokens on top of Material 3. Colour roles always come from [MaterialTheme.colorScheme]
 * (light, dark or dynamic), so every screen and widget follows the system theme.
 */
object ParloSpacing {
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 24.dp
    val xxl: Dp = 32.dp
    /** Horizontal page margin. */
    val page: Dp = 16.dp
    /** Minimum touch target for anything used while walking. */
    val walkTarget: Dp = 56.dp
    val heroButton: Dp = 56.dp
}

object ParloShape {
    val hero = RoundedCornerShape(28.dp)
    val card = RoundedCornerShape(20.dp)
    val tile = RoundedCornerShape(16.dp)
    val pill = RoundedCornerShape(50)
    val badge = RoundedCornerShape(8.dp)
}

object ParloMotion {
    fun <T> state(): FiniteAnimationSpec<T> = spring(dampingRatio = Spring.DampingRatioLowBouncy, stiffness = Spring.StiffnessMediumLow)
    fun <T> fade(): FiniteAnimationSpec<T> = tween(durationMillis = 220)
}

/** Semantic roles Material 3 doesn't name: who is talking, and what's been confirmed. */
@Immutable
data class ParloRoles(
    val speaking: Color,
    val onSpeaking: Color,
    val listening: Color,
    val onListening: Color,
    val idle: Color,
    val onIdle: Color,
    val confirmed: Color,
    val onConfirmed: Color,
    val phrase: Color,
    val onPhrase: Color,
)

internal val LocalParloRoles = staticCompositionLocalOf<ParloRoles> { error("ParloTheme not applied") }

@Composable
internal fun rolesFrom(scheme: androidx.compose.material3.ColorScheme) = ParloRoles(
    speaking = scheme.primaryContainer,
    onSpeaking = scheme.onPrimaryContainer,
    listening = scheme.secondaryContainer,
    onListening = scheme.onSecondaryContainer,
    idle = scheme.surfaceVariant,
    onIdle = scheme.onSurfaceVariant,
    confirmed = scheme.tertiaryContainer,
    onConfirmed = scheme.onTertiaryContainer,
    phrase = scheme.secondaryContainer,
    onPhrase = scheme.onSecondaryContainer,
)

object Parlo {
    val roles: ParloRoles
        @Composable @ReadOnlyComposable get() = LocalParloRoles.current
}
