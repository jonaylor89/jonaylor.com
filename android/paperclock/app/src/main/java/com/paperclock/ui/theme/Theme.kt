package com.paperclock.ui.theme

import android.graphics.Typeface
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

val Ink = Color(0xFF0B0B0C)
val Charcoal = Color(0xFF181819)
val Slate = Color(0xFF29292C)
val Gold = Color(0xFFF2B90C)
val Bone = Color(0xFFF5F0E5)

private val colors = darkColorScheme(
    primary = Gold,
    onPrimary = Ink,
    primaryContainer = Gold,
    onPrimaryContainer = Ink,
    secondary = Color(0xFFF0C85E),
    onSecondary = Ink,
    secondaryContainer = Charcoal,
    onSecondaryContainer = Bone,
    tertiary = Gold,
    onTertiary = Ink,
    tertiaryContainer = Gold,
    onTertiaryContainer = Ink,
    background = Ink,
    onBackground = Bone,
    surface = Charcoal,
    onSurface = Bone,
    surfaceDim = Ink,
    surfaceBright = Slate,
    surfaceContainerLowest = Ink,
    surfaceContainerLow = Charcoal,
    surfaceContainer = Charcoal,
    surfaceContainerHigh = Slate,
    surfaceContainerHighest = Slate,
    surfaceVariant = Slate,
    onSurfaceVariant = Color(0xFFD0CCC2),
    inverseSurface = Slate,
    inverseOnSurface = Bone,
    inversePrimary = Gold,
    outline = Color(0xFF969188),
    error = Color(0xFFFFB4AB),
    onError = Color(0xFF690005)
)

private val Condensed = FontFamily(Typeface.create("sans-serif-condensed", Typeface.BOLD))
private val Reading = FontFamily(Typeface.create("sans-serif", Typeface.NORMAL))

private val paperTypography = Typography(
    displayLarge = TextStyle(fontFamily = Condensed, fontWeight = FontWeight.Black, fontSize = 57.sp, lineHeight = 64.sp),
    headlineLarge = TextStyle(fontFamily = Condensed, fontWeight = FontWeight.Black),
    headlineMedium = TextStyle(fontFamily = Condensed, fontWeight = FontWeight.Black),
    headlineSmall = TextStyle(fontFamily = Condensed, fontWeight = FontWeight.Black),
    titleLarge = TextStyle(fontFamily = Condensed, fontWeight = FontWeight.Black),
    titleMedium = TextStyle(fontFamily = Condensed, fontWeight = FontWeight.Bold),
    bodyLarge = TextStyle(fontFamily = Reading),
    bodyMedium = TextStyle(fontFamily = Reading),
    bodySmall = TextStyle(fontFamily = Reading),
    labelLarge = TextStyle(fontFamily = Reading, fontWeight = FontWeight.Bold),
    labelMedium = TextStyle(fontFamily = Reading, fontWeight = FontWeight.Medium)
)

private val paperShapes = Shapes(
    extraSmall = androidx.compose.foundation.shape.RoundedCornerShape(2.dp),
    small = androidx.compose.foundation.shape.RoundedCornerShape(4.dp),
    medium = androidx.compose.foundation.shape.RoundedCornerShape(6.dp),
    large = androidx.compose.foundation.shape.RoundedCornerShape(8.dp),
    extraLarge = androidx.compose.foundation.shape.RoundedCornerShape(12.dp)
)

@Composable
fun PaperClockTheme(content: @Composable () -> Unit) = MaterialTheme(
    colorScheme = colors,
    typography = paperTypography,
    shapes = paperShapes,
    content = content
)
