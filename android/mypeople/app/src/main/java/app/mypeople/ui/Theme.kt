package app.mypeople.ui

import androidx.compose.animation.core.FiniteAnimationSpec
import androidx.compose.animation.core.spring
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import app.mypeople.R

// Kin: M3 Tonal Spot from seed #1E7062. Quiet teal-grey chrome; colour is spent on people.
private val Light = lightColorScheme(
    primary = Color(0xFF036B5C), onPrimary = Color(0xFFFFFFFF),
    primaryContainer = Color(0xFFA0F2DF), onPrimaryContainer = Color(0xFF005045),
    secondary = Color(0xFF4A635D), onSecondary = Color(0xFFFFFFFF),
    secondaryContainer = Color(0xFFCDE8E0), onSecondaryContainer = Color(0xFF334B46),
    tertiary = Color(0xFF436278), onTertiary = Color(0xFFFFFFFF),
    tertiaryContainer = Color(0xFFC9E6FF), onTertiaryContainer = Color(0xFF2B4A5F),
    error = Color(0xFFBA1A1A), onError = Color(0xFFFFFFFF),
    errorContainer = Color(0xFFFFDAD6), onErrorContainer = Color(0xFF93000A),
    background = Color(0xFFF5FBF7), onBackground = Color(0xFF171D1B),
    surface = Color(0xFFF5FBF7), onSurface = Color(0xFF171D1B),
    surfaceVariant = Color(0xFFDEE4E1), onSurfaceVariant = Color(0xFF3F4946),
    surfaceDim = Color(0xFFD5DBD8), surfaceBright = Color(0xFFF5FBF7),
    surfaceContainerLowest = Color(0xFFFFFFFF), surfaceContainerLow = Color(0xFFEFF5F2),
    surfaceContainer = Color(0xFFE9EFEC), surfaceContainerHigh = Color(0xFFE3EAE6),
    surfaceContainerHighest = Color(0xFFDEE4E1),
    outline = Color(0xFF6F7976), outlineVariant = Color(0xFFBEC9C5),
    inverseSurface = Color(0xFF2B3230), inverseOnSurface = Color(0xFFECF2EF),
    inversePrimary = Color(0xFF84D6C3), scrim = Color(0xFF000000),
)
private val Dark = darkColorScheme(
    primary = Color(0xFF84D6C3), onPrimary = Color(0xFF00382F),
    primaryContainer = Color(0xFF005045), onPrimaryContainer = Color(0xFFA0F2DF),
    secondary = Color(0xFFB1CCC4), onSecondary = Color(0xFF1C352F),
    secondaryContainer = Color(0xFF334B46), onSecondaryContainer = Color(0xFFCDE8E0),
    tertiary = Color(0xFFABCAE4), onTertiary = Color(0xFF123348),
    tertiaryContainer = Color(0xFF2B4A5F), onTertiaryContainer = Color(0xFFC9E6FF),
    error = Color(0xFFFFB4AB), onError = Color(0xFF690005),
    errorContainer = Color(0xFF93000A), onErrorContainer = Color(0xFFFFDAD6),
    background = Color(0xFF0E1513), onBackground = Color(0xFFDEE4E1),
    surface = Color(0xFF0E1513), onSurface = Color(0xFFDEE4E1),
    surfaceVariant = Color(0xFF303634), onSurfaceVariant = Color(0xFFBEC9C5),
    surfaceDim = Color(0xFF0E1513), surfaceBright = Color(0xFF343B38),
    surfaceContainerLowest = Color(0xFF090F0E), surfaceContainerLow = Color(0xFF171D1B),
    surfaceContainer = Color(0xFF1B211F), surfaceContainerHigh = Color(0xFF252B29),
    surfaceContainerHighest = Color(0xFF303634),
    outline = Color(0xFF89938F), outlineVariant = Color(0xFF3F4946),
    inverseSurface = Color(0xFFDEE4E1), inverseOnSurface = Color(0xFF2B3230),
    inversePrimary = Color(0xFF036B5C), scrim = Color(0xFF000000),
)

/** One person's colours. Each pair meets 4.5:1 in its theme. */
@Immutable
data class PersonPalette(val accent: Color, val onAccent: Color, val container: Color, val onContainer: Color, val wash: Color)

private fun palette(accent: Long, onAccent: Long, container: Long, onContainer: Long, wash: Long) =
    PersonPalette(Color(accent), Color(onAccent), Color(container), Color(onContainer), Color(wash))

// coral, amber, leaf, sky, plum, rose: order is part of each person's identity, never reorder.
private val LightPalettes = listOf(
    palette(0xFF904B3B, 0xFFFFFFFF, 0xFFFFDAD2, 0xFF733426, 0xFFFFF0ED),
    palette(0xFF7D570E, 0xFFFFFFFF, 0xFFFFDEAD, 0xFF604100, 0xFFFEF2E5),
    palette(0xFF48672F, 0xFFFFFFFF, 0xFFC8EEA7, 0xFF314E19, 0xFFF3F5EA),
    palette(0xFF30628C, 0xFFFFFFFF, 0xFFCFE5FF, 0xFF104A73, 0xFFF1F3F9),
    palette(0xFF765085, 0xFFFFFFFF, 0xFFF7D8FF, 0xFF5C386B, 0xFFFBF1F8),
    palette(0xFF8C4A5E, 0xFFFFFFFF, 0xFFFFD9E1, 0xFF703346, 0xFFFFF0F2),
)
private val DarkPalettes = listOf(
    palette(0xFFFFB4A3, 0xFF561F12, 0xFF733426, 0xFFFFDAD2, 0xFF231917),
    palette(0xFFF1BE6D, 0xFF432C00, 0xFF604100, 0xFFFFDEAD, 0xFF201B13),
    palette(0xFFADD28E, 0xFF1B3704, 0xFF314E19, 0xFFC8EEA7, 0xFF1A1D16),
    palette(0xFF9CCBFB, 0xFF003354, 0xFF104A73, 0xFFCFE5FF, 0xFF181C20),
    palette(0xFFE4B7F3, 0xFF442253, 0xFF5C386B, 0xFFF7D8FF, 0xFF1E1A1F),
    palette(0xFFFFB1C5, 0xFF551D30, 0xFF703346, 0xFFFFD9E1, 0xFF22191B),
)

/** A stable hue per person: the same seed always lands on the same palette. */
fun paletteIndex(seed: String): Int = Math.floorMod(seed.hashCode(), LightPalettes.size)

@Composable
@ReadOnlyComposable
fun personPalette(seed: String): PersonPalette =
    (if (LocalDarkTheme.current) DarkPalettes else LightPalettes)[paletteIndex(seed)]

private val LocalDarkTheme = staticCompositionLocalOf { false }
/** The palette of the person a screen is about; null on app chrome. */
val LocalPersonPalette = staticCompositionLocalOf<PersonPalette?> { null }

@OptIn(ExperimentalTextApi::class)
private fun variable(res: Int, weight: Int, vararg extra: FontVariation.Setting) =
    Font(res, FontWeight(weight), variationSettings = FontVariation.Settings(FontVariation.weight(weight), *extra))

// Bricolage Grotesque for people (names, monograms, index letters); Figtree for the interface.
private val Display = FontFamily(listOf(600, 650, 700).map { variable(R.font.bricolage_grotesque_variable, it, FontVariation.Setting("opsz", 72f)) })
private val Expressive = FontFamily(listOf(600, 650, 700).map { variable(R.font.bricolage_grotesque_variable, it, FontVariation.Setting("opsz", 24f)) })
private val Interface = FontFamily(listOf(400, 500, 600, 700).map { variable(R.font.figtree_variable, it) })

private fun style(family: FontFamily, size: Int, line: Int, weight: Int, tracking: Double) =
    TextStyle(fontFamily = family, fontSize = size.sp, lineHeight = line.sp, fontWeight = FontWeight(weight), letterSpacing = tracking.sp)

private val Type = Typography(
    displayLarge = style(Display, 57, 60, 700, -1.2),
    displayMedium = style(Display, 45, 48, 700, -0.8),
    displaySmall = style(Display, 36, 40, 650, -0.4),
    headlineLarge = style(Expressive, 32, 40, 600, -0.2),
    headlineMedium = style(Expressive, 28, 36, 600, 0.0),
    headlineSmall = style(Expressive, 24, 32, 600, 0.0),
    titleLarge = style(Interface, 22, 28, 500, 0.0),
    titleMedium = style(Interface, 16, 24, 600, 0.15),
    titleSmall = style(Interface, 14, 20, 600, 0.1),
    bodyLarge = style(Interface, 16, 24, 400, 0.2),
    bodyMedium = style(Interface, 14, 20, 400, 0.2),
    bodySmall = style(Interface, 12, 16, 400, 0.4),
    labelLarge = style(Interface, 14, 20, 600, 0.1),
    labelMedium = style(Interface, 12, 16, 600, 0.5),
    labelSmall = style(Interface, 11, 16, 600, 0.5),
)

/** Expressive styles outside the M3 scale. */
object KinType {
    val monogramLarge = style(Expressive, 56, 56, 700, -1.0)
    val monogram = style(Expressive, 20, 20, 650, 0.0)
    val indexLetter = style(Expressive, 22, 28, 700, 0.0)
}

object KinSpace {
    val half = 2.dp; val s1 = 4.dp; val s2 = 8.dp; val s3 = 12.dp; val s4 = 16.dp
    val s5 = 20.dp; val s6 = 24.dp; val s8 = 32.dp; val s12 = 48.dp
}

object KinRadius {
    val xs = 4.dp; val sm = 8.dp; val md = 12.dp; val lg = 16.dp; val lgPlus = 20.dp
    val xl = 28.dp; val xlPlus = 32.dp; val xxl = 48.dp
}

object KinSize {
    val touchTarget = 48.dp
    val avatarSm = 40.dp; val avatarMd = 56.dp; val avatarLg = 96.dp; val avatarXl = 144.dp
    val rowOneLine = 56.dp; val rowTwoLine = 72.dp
    val searchBar = 56.dp; val fab = 56.dp; val actionButton = 64.dp
}

/** Elevation is for things that float over content; hierarchy comes from tone. */
object KinElevation { val level1: Dp = 1.dp; val level2: Dp = 3.dp; val level3: Dp = 6.dp }

/** M3 Expressive springs, named as in the design system. */
object KinMotion {
    fun <T> spatialFast(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.6f, stiffness = 800f)
    fun <T> spatialDefault(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.8f, stiffness = 380f)
    fun <T> spatialSlow(): FiniteAnimationSpec<T> = spring(dampingRatio = 0.8f, stiffness = 200f)
    fun <T> effects(): FiniteAnimationSpec<T> = spring(dampingRatio = 1f, stiffness = 1600f)
}

/** List cards: a calm tonal step above the window. */
@Composable
fun journalSurfaceColor(): Color = MaterialTheme.colorScheme.surfaceContainerLow

@Composable
fun MyPeopleTheme(content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    CompositionLocalProvider(LocalDarkTheme provides dark) {
        MaterialTheme(
            colorScheme = if (dark) Dark else Light,
            typography = Type,
            shapes = Shapes(
                extraSmall = RoundedCornerShape(KinRadius.xs), small = RoundedCornerShape(KinRadius.sm),
                medium = RoundedCornerShape(KinRadius.md), large = RoundedCornerShape(KinRadius.lg), extraLarge = RoundedCornerShape(KinRadius.xl),
            ),
            content = content,
        )
    }
}
