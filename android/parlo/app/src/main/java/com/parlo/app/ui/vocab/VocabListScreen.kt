package com.parlo.app.ui.vocab

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.automirrored.rounded.HelpOutline
import androidx.compose.material.icons.rounded.AutoAwesome
import androidx.compose.material.icons.rounded.Check
import androidx.compose.material.icons.rounded.Close
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.HourglassBottom
import androidx.compose.material.icons.rounded.Lightbulb
import androidx.compose.material.icons.rounded.Spellcheck
import androidx.compose.material.icons.rounded.Style
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Surface
import com.parlo.app.model.RetrievalSchedule
import com.parlo.app.ui.components.LanguageMonogram
import com.parlo.app.ui.components.Overline
import com.parlo.app.ui.components.ParloSnackbarHost
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSpacing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material.icons.filled.Style
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.parlo.app.ParloApp
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.data.db.VocabSource
import kotlinx.coroutines.launch

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun VocabListScreen(onBack: () -> Unit) {
    val container = ParloApp.container(LocalContext.current)
    val repo = container.vocab
    val all by repo.observeAll().collectAsStateWithLifecycle(initialValue = emptyList())
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    var flashcardMode by remember { mutableStateOf(false) }
    val suggested = all.filter { it.isSuggested }
    val kept = all.filterNot { it.isSuggested }
    val due = kept.filter { it.nextReviewAt <= System.currentTimeMillis() }
    val grouped = (if (flashcardMode) due else kept).groupBy { it.language }.toSortedMap()

    /** Runs [action], then offers Undo for a few seconds. */
    fun undoable(message: String, action: suspend () -> Unit, undo: suspend () -> Unit) {
        scope.launch {
            action()
            val r = snackbar.showSnackbar(message, actionLabel = "Undo", duration = SnackbarDuration.Short)
            if (r == SnackbarResult.ActionPerformed) undo()
        }
    }

    Scaffold(
        snackbarHost = { ParloSnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("Vocabulary", style = MaterialTheme.typography.headlineMedium) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
                actions = {
                    FilterChip(
                        selected = flashcardMode,
                        onClick = { flashcardMode = !flashcardMode },
                        label = { Text("Flashcards") },
                        leadingIcon = { Icon(Icons.Rounded.Style, null, Modifier.size(FilterChipDefaults.IconSize)) },
                        modifier = Modifier.padding(end = 8.dp),
                    )
                },
            )
        },
    ) { padding ->
        if (all.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text(
                    "No words yet.\nWords you ask about or get stuck on are picked up automatically during a walk, and you can always say \"save that word\".",
                    textAlign = TextAlign.Center,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(32.dp),
                )
            }
            return@Scaffold
        }
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(ParloSpacing.space4), verticalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
            if (suggested.isNotEmpty()) {
                item(key = "header-suggested") {
                    val snapshot = suggested
                    SuggestedHeader(
                        count = suggested.size,
                        onKeepAll = { undoable("Kept ${snapshot.size} words", { repo.keepAllSuggested() }, { repo.unkeep(snapshot) }) },
                        onDismissAll = { undoable("Skipped ${snapshot.size} words", { repo.dismissAllSuggested() }, { repo.restore(snapshot) }) },
                    )
                }
                itemsIndexed(suggested, key = { _, it -> "s-${it.id}" }) { i, v ->
                    SuggestedCard(
                        v, last = i == suggested.lastIndex,
                        onKeep = { undoable("Kept “${v.word}”", { repo.keep(v) }, { repo.unkeep(listOf(v)) }) },
                        onDismiss = { undoable("Skipped “${v.word}”", { repo.delete(v) }, { repo.restore(listOf(v)) }) },
                    )
                }
                if (kept.isNotEmpty()) {
                    item(key = "header-kept") {
                        Overline("Saved", color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = ParloSpacing.space6))
                    }
                }
            }
            if (flashcardMode) item(key = "retrieval_help") {
                Text(if (due.isEmpty()) "You're caught up. Your words will return when they're due." else
                    "Try saying the word before revealing it. Rate what you actually recalled; today's repeats don't count as delayed recall.",
                    style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = ParloSpacing.space2))
            }
            grouped.forEach { (language, words) ->
                item(key = "header-$language") {
                    Row(Modifier.padding(top = ParloSpacing.space4, bottom = ParloSpacing.space2), verticalAlignment = Alignment.CenterVertically) {
                        LanguageMonogram(language, size = 32.dp)
                        Spacer(Modifier.width(ParloSpacing.space3))
                        Text("$language · ${words.size}", style = MaterialTheme.typography.titleMedium)
                    }
                }
                itemsIndexed(words, key = { _, it -> it.id }) { i, v ->
                    if (flashcardMode) Flashcard(v, onReview = { recalled -> scope.launch { container.learning.recordReview(v.id, recalled) } },
                        modifier = Modifier.padding(bottom = ParloSpacing.space3))
                    else VocabCard(v, ParloShape.grouped(i, words.size),
                        onDelete = { undoable("Deleted “${v.word}”", { repo.delete(v) }, { repo.restore(listOf(v)) }) })
                }
            }
        }
    }
}

/** Top of the suggested tray, on Sunpath's container: machine-suggested, so labelled with the sparkle. */
@Composable
private fun SuggestedHeader(count: Int, onKeepAll: () -> Unit, onDismissAll: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        color = scheme.secondaryContainer, contentColor = scheme.onSecondaryContainer,
        shape = RoundedCornerShape(topStart = 28.dp, topEnd = 28.dp),
        modifier = Modifier.fillMaxWidth().padding(top = ParloSpacing.space2),
    ) {
        Column(Modifier.padding(start = ParloSpacing.space5, end = ParloSpacing.space2, top = ParloSpacing.space4, bottom = ParloSpacing.space2)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Icon(Icons.Rounded.AutoAwesome, null, Modifier.size(20.dp))
                Spacer(Modifier.width(ParloSpacing.space2))
                Text("$count suggested from your walks", style = MaterialTheme.typography.titleMedium, modifier = Modifier.weight(1f))
            }
            Text("Picked up automatically. Keep what's useful.", style = MaterialTheme.typography.bodyMedium)
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                val c = ButtonDefaults.textButtonColors(contentColor = scheme.onSecondaryContainer)
                TextButton(onClick = onDismissAll, colors = c) { Text("Skip all") }
                TextButton(onClick = onKeepAll, colors = c) { Text("Keep all") }
            }
        }
    }
}

@Composable
private fun SuggestedCard(v: VocabEntity, last: Boolean, onKeep: () -> Unit, onDismiss: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(
        color = scheme.secondaryContainer,
        shape = if (last) RoundedCornerShape(bottomStart = 28.dp, bottomEnd = 28.dp) else RoundedCornerShape(0.dp),
        modifier = Modifier.fillMaxWidth(),
    ) {
        Surface(
            color = scheme.surfaceContainerLowest,
            shape = if (last) RoundedCornerShape(topStart = 4.dp, topEnd = 4.dp, bottomStart = 20.dp, bottomEnd = 20.dp) else ParloShape.extraSmall,
            modifier = Modifier.fillMaxWidth().padding(start = ParloSpacing.space2, end = ParloSpacing.space2, bottom = if (last) ParloSpacing.space2 else 0.dp)
                .semantics { contentDescription = "Suggested ${v.word}" },
        ) {
            Row(Modifier.padding(start = ParloSpacing.space4, top = ParloSpacing.space3, bottom = ParloSpacing.space3, end = ParloSpacing.space2), verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space1)) {
                    Text(v.word, style = Parlo.type.phraseLarge)
                    if (v.translation.isNotBlank()) Text(v.translation, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                    if (v.exampleSentence.isNotBlank()) Text(v.exampleSentence, style = Parlo.type.phraseGloss, color = scheme.onSurfaceVariant)
                    ReasonTag(v.reason.ifBlank { sourceLabel(v) })
                }
                IconButton(onClick = onDismiss, modifier = Modifier.semantics { contentDescription = "Skip ${v.word}" }) { Icon(Icons.Rounded.Close, null) }
                FilledIconButton(onClick = onKeep, modifier = Modifier.semantics { contentDescription = "Keep ${v.word}" }) { Icon(Icons.Rounded.Check, null) }
            }
        }
    }
}

/** Why a word was picked up, with an icon so the reason reads without colour. */
@Composable
private fun ReasonTag(reason: String) {
    val r = reason.lowercase()
    val icon = when {
        "correct" in r -> Icons.Rounded.Spellcheck
        "ask" in r || "mean" in r -> Icons.AutoMirrored.Rounded.HelpOutline
        "paus" in r || "stuck" in r || "hesit" in r -> Icons.Rounded.HourglassBottom
        else -> Icons.Rounded.Lightbulb
    }
    Surface(shape = ParloShape.medium, color = MaterialTheme.colorScheme.surfaceContainerHigh, contentColor = MaterialTheme.colorScheme.onSurfaceVariant) {
        Row(Modifier.padding(horizontal = ParloSpacing.space2, vertical = ParloSpacing.space1), verticalAlignment = Alignment.CenterVertically) {
            Icon(icon, null, Modifier.size(14.dp))
            Spacer(Modifier.width(ParloSpacing.space1))
            Text(reason, style = MaterialTheme.typography.labelMedium)
        }
    }
}

private fun sourceLabel(v: VocabEntity) = when (v.source) {
    VocabSource.TUTOR.name -> "Noted by the tutor"
    VocabSource.MINED.name -> "Found in your transcript"
    else -> "Saved by you"
}

@Composable
private fun VocabCard(v: VocabEntity, shape: androidx.compose.ui.graphics.Shape, onDelete: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(shape = shape, color = scheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = ParloSpacing.space4, top = ParloSpacing.space3, bottom = ParloSpacing.space3, end = ParloSpacing.space1), verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(v.word, style = Parlo.type.phraseLarge)
                    if (v.source != VocabSource.MANUAL.name) {
                        Icon(Icons.Rounded.AutoAwesome, "Captured automatically", tint = scheme.onSurfaceVariant, modifier = Modifier.padding(start = 6.dp).size(14.dp))
                    }
                }
                if (v.translation.isNotBlank()) Text(v.translation, style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
                if (v.exampleSentence.isNotBlank()) Text(v.exampleSentence, style = Parlo.type.phraseGloss, color = scheme.onSurfaceVariant)
            }
            IconButton(onClick = onDelete) { Icon(Icons.Rounded.Delete, "Delete", tint = scheme.onSurfaceVariant) }
        }
    }
}

/**
 * Production first: the meaning in your language, say it aloud, reveal the phrase, then rate your own
 * recall. Each rating says when the word returns. A self-rating, not a score.
 */
@Composable
private fun Flashcard(v: VocabEntity, onReview: (Boolean) -> Unit, modifier: Modifier = Modifier) {
    var revealed by remember(v.id) { mutableStateOf(false) }
    val scheme = MaterialTheme.colorScheme
    val now = System.currentTimeMillis()
    fun returns(remembered: Boolean): String {
        val (_, due) = RetrievalSchedule.next(v.reviewStage, v.lastReviewedAt, remembered, now)
        val days = ((due - now + RetrievalSchedule.DAY / 2) / RetrievalSchedule.DAY).toInt()
        return if (days <= 1) "tomorrow" else "in $days days"
    }
    Surface(
        onClick = { revealed = !revealed },
        shape = ParloShape.extraLargeIncreased,
        color = scheme.surfaceContainerLowest,
        shadowElevation = 1.dp,
        modifier = modifier.fillMaxWidth(),
    ) {
        Column(Modifier.padding(ParloSpacing.space5), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space3)) {
            Overline("Say it in ${v.language}", color = scheme.onSurfaceVariant)
            Text(v.translation.ifBlank { v.word }, style = MaterialTheme.typography.titleLarge)
            AnimatedVisibility(visible = revealed) {
                Column(verticalArrangement = Arrangement.spacedBy(ParloSpacing.space1)) {
                    Text(v.word, style = Parlo.type.phraseHero, color = scheme.onSurface)
                    if (v.exampleSentence.isNotBlank()) Text(v.exampleSentence, style = Parlo.type.phraseGloss, color = scheme.onSurfaceVariant)
                }
            }
            if (!revealed) {
                Text("Tap to reveal", style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant)
            } else {
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
                    RatingButton("Missed", returns(false), RoundedCornerShape(topStartPercent = 50, bottomStartPercent = 50, topEndPercent = 20, bottomEndPercent = 20),
                        scheme.surfaceContainerHighest, scheme.onSurface, Modifier.weight(1f)) { onReview(false) }
                    RatingButton("Got it", returns(true), RoundedCornerShape(topStartPercent = 20, bottomStartPercent = 20, topEndPercent = 50, bottomEndPercent = 50),
                        scheme.primary, scheme.onPrimary, Modifier.weight(1f)) { onReview(true) }
                }
            }
            ReviewLadder(v.reviewStage, reviewed = v.lastReviewedAt != null)
        }
    }
}

@Composable
private fun RatingButton(label: String, returns: String, shape: androidx.compose.ui.graphics.Shape, bg: androidx.compose.ui.graphics.Color, fg: androidx.compose.ui.graphics.Color, modifier: Modifier, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = shape, color = bg, contentColor = fg, modifier = modifier.heightIn(min = 56.dp)) {
        Column(Modifier.padding(vertical = ParloSpacing.space2), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.Center) {
            Text(label, style = MaterialTheme.typography.labelLarge)
            Text(returns, style = MaterialTheme.typography.bodySmall)
        }
    }
}

/** Six rising pills for the 1/3/7/14/30/60-day stages: reached filled, later outlined, the current one labelled. */
@Composable
private fun ReviewLadder(stage: Int, reviewed: Boolean) {
    val days = listOf(1, 3, 7, 14, 30, 60)
    val current = stage.coerceIn(days.indices)
    val stages = Parlo.colors.fixed.reviewStages
    val outline = MaterialTheme.colorScheme.outline
    Row(
        Modifier.semantics(mergeDescendants = true) { contentDescription = "Review stage ${current + 1} of 6, every ${days[current]} days" },
        horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space2), verticalAlignment = Alignment.Bottom,
    ) {
        days.forEachIndexed { i, d ->
            val reached = reviewed && i <= current
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                Box(
                    Modifier.width(14.dp).height((12 + i * 4).dp)
                        .then(if (reached) Modifier.background(stages[i], ParloShape.full) else Modifier.border(1.dp, outline, ParloShape.full)),
                )
                Text("$d d", style = MaterialTheme.typography.labelSmall,
                    color = if (i == current && reviewed) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
