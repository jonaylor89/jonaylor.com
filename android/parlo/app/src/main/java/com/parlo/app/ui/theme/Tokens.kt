package com.parlo.app.ui.theme

import android.provider.Settings
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.shape.CornerBasedShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Parlo design tokens on top of Material 3, mirroring the Parlo design system (`design/tokens.json`).
 * Material colour roles come from [androidx.compose.material3.MaterialTheme.colorScheme]; Parlo's own
 * semantic roles from [Parlo.colors].
 */
object ParloSpacing {
    /** Gap inside connected button groups. */
    val hair: Dp = 2.dp
    val space1: Dp = 4.dp
    val space2: Dp = 8.dp
    val space3: Dp = 12.dp
    /** Compact screen margin; card padding. */
    val space4: Dp = 16.dp
    /** Sheet content padding. */
    val space5: Dp = 20.dp
    val space6: Dp = 24.dp
    /** Voice orb to its state word. */
    val space8: Dp = 32.dp
    val space12: Dp = 48.dp
    val space16: Dp = 64.dp
}

object ParloSize {
    /** Minimum touch target anywhere. */
    val targetMin: Dp = 48.dp
    /** Minimum touch target on the in-walk screen. */
    val targetWalk: Dp = 72.dp
    /** Start-walk extended FAB height. */
    val fabLarge: Dp = 96.dp
    val orb: Dp = 240.dp
    val monogram: Dp = 44.dp
    val icon: Dp = 24.dp
    val iconWalk: Dp = 36.dp
}

/** M3 Expressive shape scale plus the steps Material 3 1.3 doesn't name. */
object ParloShape {
    val none = RoundedCornerShape(0.dp)
    val extraSmall = RoundedCornerShape(4.dp)
    val small = RoundedCornerShape(8.dp)
    val medium = RoundedCornerShape(12.dp)
    val large = RoundedCornerShape(16.dp)
    val largeIncreased = RoundedCornerShape(20.dp)
    val extraLarge = RoundedCornerShape(28.dp)
    val extraLargeIncreased = RoundedCornerShape(32.dp)
    val extraExtraLarge = RoundedCornerShape(48.dp)
    val full = RoundedCornerShape(50)

    /** Speech bubble: one 4dp corner points toward the speaker. */
    fun bubble(fromLearner: Boolean): CornerBasedShape = RoundedCornerShape(
        topStart = 20.dp, topEnd = 20.dp,
        bottomStart = if (fromLearner) 20.dp else 4.dp,
        bottomEnd = if (fromLearner) 4.dp else 20.dp,
    )

    /** Item in a vertically connected group: large outer corners, medium inner ones. */
    fun grouped(index: Int, count: Int, outer: Dp = 16.dp, inner: Dp = 4.dp): CornerBasedShape {
        val top = if (index == 0) outer else inner
        val bottom = if (index == count - 1) outer else inner
        return RoundedCornerShape(topStart = top, topEnd = top, bottomStart = bottom, bottomEnd = bottom)
    }

    /** Item in a horizontally connected button group: full outer corners, medium inner ones. */
    fun connected(index: Int, count: Int, selected: Boolean): CornerBasedShape {
        if (selected) return full
        val start = if (index == 0) 50 else 25
        val end = if (index == count - 1) 50 else 25
        return RoundedCornerShape(topStartPercent = start, bottomStartPercent = start, topEndPercent = end, bottomEndPercent = end)
    }
}

/**
 * Expressive motion: spatial springs (position, size, shape) may bounce a little; effects springs
 * (colour, opacity) never bounce. With "Remove animations" on, use [reducedMotion] crossfades.
 */
object ParloMotion {
    fun <T> spatialFast(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.6f, stiffness = 800f)
    fun <T> spatial(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.8f, stiffness = 380f)
    fun <T> spatialSlow(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.8f, stiffness = 200f)
    fun <T> effects(): FiniteAnimationSpec<T> = spring(dampingRatio = 1f, stiffness = 1600f)
    fun <T> reducedMotion(): FiniteAnimationSpec<T> = tween(durationMillis = DURATION_SHORT)

    const val DURATION_SHORT = 150
    const val DURATION_MEDIUM = 300
    const val DURATION_LONG = 500
    /** One idle breath of the listening orb. */
    const val DURATION_BREATH = 4200

    val Emphasized = CubicBezierEasing(0.2f, 0f, 0f, 1f)
    val EmphasizedDecelerate = CubicBezierEasing(0.05f, 0.7f, 0.1f, 1f)
    val EmphasizedAccelerate = CubicBezierEasing(0.3f, 0f, 0.8f, 0.15f)
}

/** True when the system "Remove animations" setting (animator duration scale 0) is on. */
@Composable
fun rememberReducedMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        runCatching { Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f }.getOrDefault(false)
    }
}

/** A language's identity tone: the accent for rings and dots, the container for monogram discs. */
@Immutable
data class TongueTone(val name: String, val accent: Color, val container: Color, val onContainer: Color)

/** Colours that don't follow dynamic colour, so the tutor and your languages stay recognisable. */
@Immutable
data class ParloFixedColors(
    val tongues: List<TongueTone>,
    /** Review ladder fills for the 1/3/7/14/30/60-day stages. Decorative; the label carries meaning. */
    val reviewStages: List<Color>,
    val primaryFixed: Color,
    val onPrimaryFixed: Color,
    val tertiaryFixed: Color,
    val onTertiaryFixed: Color,
    val devBadge: Color,
    val onDevBadge: Color,
)

/** Parlo's semantic roles: who is talking, and how the walk is going. */
@Immutable
data class ParloColors(
    val stateListening: Color,
    val stateSpeaking: Color,
    val stateThinking: Color,
    val stateMuted: Color,
    val stateReconnecting: Color,
    val bubbleLearner: Color,
    val onBubbleLearner: Color,
    val bubbleTutor: Color,
    val onBubbleTutor: Color,
    /** Underline and text of a corrected word. Always paired with a strike-through, never colour alone. */
    val correction: Color,
    /** Full-bleed ground behind the walk screen. */
    val walkGround: Color,
    val fixed: ParloFixedColors,
) {
    val tongues: List<TongueTone> get() = fixed.tongues
}

internal fun parloColors(scheme: ColorScheme, fixed: ParloFixedColors, dark: Boolean) = ParloColors(
    stateListening = scheme.primary,
    stateSpeaking = scheme.tertiary,
    stateThinking = scheme.secondary,
    stateMuted = scheme.outline,
    stateReconnecting = scheme.onSurfaceVariant,
    bubbleLearner = scheme.primaryContainer,
    onBubbleLearner = scheme.onPrimaryContainer,
    bubbleTutor = scheme.surfaceContainerHigh,
    onBubbleTutor = scheme.onSurface,
    correction = scheme.tertiary,
    walkGround = if (dark) scheme.surfaceContainerLowest else scheme.surfaceDim,
    fixed = fixed,
)

internal val LocalParloColors = staticCompositionLocalOf<ParloColors> { error("ParloTheme not applied") }
internal val LocalParloTextStyles = staticCompositionLocalOf { ParloTextStyles() }

object Parlo {
    val colors: ParloColors
        @Composable @ReadOnlyComposable get() = LocalParloColors.current
    val type: ParloTextStyles
        @Composable @ReadOnlyComposable get() = LocalParloTextStyles.current
}
