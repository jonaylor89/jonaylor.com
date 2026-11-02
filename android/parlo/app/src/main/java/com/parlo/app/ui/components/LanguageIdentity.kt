package com.parlo.app.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.selection.selectable
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.parlo.app.model.LanguageCatalog
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloMotion
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.theme.ParloSpacing
import com.parlo.app.ui.theme.PhraseFamily
import com.parlo.app.ui.theme.TongueTone
import java.util.Locale

/** A language's own name in its own script ("Português", "日本語"), or what the learner typed. */
fun nativeNameOf(language: String): String = LanguageCatalog.find(language)?.nativeName?.ifBlank { null } ?: language

/**
 * Two letters for Latin, Greek and Cyrillic scripts ("Pt", "Es"), one character otherwise ("日", "ع").
 * Flags mark places, never languages, so this is what identifies a language at a glance.
 */
fun monogramOf(language: String): String {
    val name = nativeNameOf(language).trim().ifBlank { return "?" }
    val first = name.codePointAt(0)
    val script = Character.UnicodeScript.of(first)
    val alphabetic = script == Character.UnicodeScript.LATIN || script == Character.UnicodeScript.GREEK || script == Character.UnicodeScript.CYRILLIC
    if (!alphabetic) return String(Character.toChars(first))
    val letters = name.filter { it.isLetter() }
    return letters.take(1).uppercase(Locale.ROOT) + letters.drop(1).take(1).lowercase(Locale.ROOT)
}

/** Stable for the life of the install: a hash of the language's key onto the eight tones. */
fun tongueIndexOf(language: String): Int = Math.floorMod(language.trim().lowercase(Locale.ROOT).hashCode(), 8)

@Composable
fun tongueOf(language: String): TongueTone = Parlo.colors.tongues[tongueIndexOf(language)]

/** Monogram disc in the language's tone, glyph in the phrase family. */
@Composable
fun LanguageMonogram(language: String, modifier: Modifier = Modifier, size: Dp = ParloSize.monogram, dimmed: Boolean = false, ring: Boolean = false) {
    val tone = tongueOf(language)
    Box(
        modifier
            .size(size)
            .alpha(if (dimmed) 0.45f else 1f)
            .then(if (ring) Modifier.border(BorderStroke(2.dp, tone.accent), CircleShape) else Modifier)
            .padding(if (ring) 3.dp else 0.dp)
            .background(tone.container, CircleShape),
        contentAlignment = Alignment.Center,
    ) {
        val glyph = monogramOf(language)
        Text(
            glyph,
            color = tone.onContainer,
            style = Parlo.type.phraseLarge.copy(fontFamily = PhraseFamily, fontSize = (size.value * if (glyph.length > 1) 0.4f else 0.46f).sp, lineHeight = (size.value * 0.5f).sp),
            maxLines = 1,
        )
    }
}

/**
 * Home's answer to "Which language today?": a connected group of saved languages. The selected one widens
 * to a full pill with its native name and accent; the rest show only their monogram.
 */
@Composable
fun LanguageSegment(
    language: String,
    detail: String,
    selected: Boolean,
    index: Int,
    count: Int,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val scheme = MaterialTheme.colorScheme
    val container by animateColorAsState(if (selected) scheme.primaryContainer else scheme.surfaceContainerHighest, ParloMotion.effects(), label = "seg")
    val content = if (selected) scheme.onPrimaryContainer else scheme.onSurface
    Surface(
        shape = ParloShape.connected(index, count, selected),
        color = container,
        contentColor = content,
        modifier = modifier
            .heightIn(min = 60.dp)
            .selectable(selected = selected, onClick = onClick, role = Role.RadioButton)
            .semantics { if (!selected) contentDescription = language }
            .animateContentSize(ParloMotion.spatial()),
    ) {
        Row(
            Modifier.padding(start = 8.dp, end = if (selected) 20.dp else 8.dp, top = 8.dp, bottom = 8.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space3),
        ) {
            LanguageMonogram(language)
            if (selected) {
                Column(Modifier.widthIn(max = 200.dp)) {
                    Text(nativeNameOf(language), style = Parlo.type.phraseLarge.copy(fontSize = 18.sp, lineHeight = 24.sp), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    if (detail.isNotBlank()) {
                        Text(detail.uppercase(), style = MaterialTheme.typography.labelSmall, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
