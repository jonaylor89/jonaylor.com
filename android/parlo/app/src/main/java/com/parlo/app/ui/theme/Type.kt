@file:OptIn(ExperimentalTextApi::class)

package com.parlo.app.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.ExperimentalTextApi
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontVariation
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp
import com.parlo.app.R

/*
 * Three families, three jobs (design system "Typography"):
 *  - Bricolage Grotesque: Parlo's personality (display, headlines, the in-walk state word).
 *  - Atkinson Hyperlegible Next: all UI. Titles and labels are bold, never medium, so they survive sunlight.
 *  - Literata: the language you are learning, always. Android falls back to Noto Serif/Sans for
 *    CJK, Arabic and Devanagari glyphs Literata lacks.
 * All three are bundled variable fonts; each Font pins its weight and optical size axes.
 */

private fun bricolage(weight: Int, opsz: Float) = Font(
    R.font.bricolage_grotesque,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight), FontVariation.Setting("opsz", opsz)),
)

private fun atkinson(weight: Int) = Font(
    R.font.atkinson_hyperlegible_next,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight)),
)

private fun literata(weight: Int, opsz: Float) = Font(
    R.font.literata,
    weight = FontWeight(weight),
    variationSettings = FontVariation.Settings(FontVariation.weight(weight), FontVariation.Setting("opsz", opsz)),
)

/** Display sizes (36sp+): optical size tuned for large settings. */
val DisplayFamily = FontFamily(bricolage(600, 48f), bricolage(700, 48f), bricolage(800, 48f))

/** Headlines (24–32sp). */
val HeadlineFamily = FontFamily(bricolage(600, 28f), bricolage(700, 28f))

val SansFamily = FontFamily(atkinson(400), atkinson(500), atkinson(700), atkinson(800))

/** Target-language text at reading sizes (transcripts, glosses). */
val PhraseFamily = FontFamily(literata(400, 18f), literata(500, 18f), literata(700, 18f))

/** Target-language text at hero sizes (phrase cards, flashcard answers). */
val PhraseDisplayFamily = FontFamily(literata(400, 36f), literata(500, 36f))

private fun style(family: FontFamily, size: Int, line: Int, weight: Int, tracking: TextUnit) =
    TextStyle(fontFamily = family, fontSize = size.sp, lineHeight = line.sp, fontWeight = FontWeight(weight), letterSpacing = tracking)

internal val ParloTypography = Typography(
    displayLarge = style(DisplayFamily, 57, 64, 700, (-0.25).sp),
    displayMedium = style(DisplayFamily, 45, 52, 700, 0.sp),
    displaySmall = style(DisplayFamily, 36, 44, 700, 0.sp),
    headlineLarge = style(HeadlineFamily, 32, 40, 600, 0.sp),
    headlineMedium = style(HeadlineFamily, 28, 36, 600, 0.sp),
    headlineSmall = style(HeadlineFamily, 24, 32, 600, 0.sp),
    titleLarge = style(SansFamily, 22, 28, 700, 0.sp),
    titleMedium = style(SansFamily, 16, 24, 700, 0.15.sp),
    titleSmall = style(SansFamily, 14, 20, 700, 0.1.sp),
    bodyLarge = style(SansFamily, 16, 24, 400, 0.15.sp),
    bodyMedium = style(SansFamily, 14, 20, 400, 0.2.sp),
    bodySmall = style(SansFamily, 12, 16, 400, 0.3.sp),
    labelLarge = style(SansFamily, 14, 20, 700, 0.1.sp),
    labelMedium = style(SansFamily, 12, 16, 700, 0.4.sp),
    labelSmall = style(SansFamily, 11, 16, 700, 0.5.sp),
)

/** Parlo styles Material doesn't name. Target language is serif, your language is sans: never mix them in one run. */
@Immutable
data class ParloTextStyles(
    /** The single word under the voice orb, read at arm's length in one glance. */
    val walkState: TextStyle = style(DisplayFamily, 40, 44, 800, (-0.5).sp),
    /** A target-language phrase on a phrase card or flashcard. */
    val phraseHero: TextStyle = style(PhraseDisplayFamily, 34, 42, 500, (-0.2).sp),
    /** Native language names in pickers; vocabulary headwords. */
    val phraseLarge: TextStyle = style(PhraseFamily, 22, 30, 500, 0.sp),
    /** Target-language transcript turns. */
    val phraseBody: TextStyle = style(PhraseFamily, 18, 28, 400, 0.sp),
    /** Romanisation/IPA under a phrase. Never italic: many scripts have none. */
    val phraseGloss: TextStyle = style(PhraseFamily, 14, 20, 400, 0.sp),
)
