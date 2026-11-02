package com.parlo.app.ui.history

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.rounded.Delete
import androidx.compose.material.icons.rounded.VisibilityOff
import androidx.compose.material3.Surface
import com.parlo.app.ui.components.LanguageMonogram
import com.parlo.app.ui.components.Overline
import com.parlo.app.ui.components.ParloSnackbarHost
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSpacing
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.filled.AutoAwesome
import androidx.compose.material.icons.filled.Delete
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.TextButton
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.SnackbarDuration
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.SnackbarResult
import androidx.compose.material3.Text
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
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import com.parlo.app.ParloApp
import com.parlo.app.data.VocabCapture
import com.parlo.app.data.db.SessionEntity
import com.parlo.app.model.Level
import com.parlo.app.model.Speaker
import com.parlo.app.model.TranscriptTurn
import com.parlo.app.ui.main.TurnBubble
import kotlinx.coroutines.launch
import java.text.DateFormat
import java.util.Date

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionHistoryScreen(onBack: () -> Unit, onOpen: (Long) -> Unit) {
    val repo = ParloApp.container(LocalContext.current).sessions
    val sessions by repo.observeSessions().collectAsStateWithLifecycle(initialValue = emptyList())
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }
    // Deletion is deferred until the Undo snackbar times out, so undo is just "don't delete".
    var pendingDelete by remember { mutableStateOf(setOf<Long>()) }
    val visible = sessions.filterNot { it.id in pendingDelete }

    fun deleteWithUndo(id: Long) {
        pendingDelete = pendingDelete + id
        scope.launch {
            val r = snackbar.showSnackbar("Walk deleted", actionLabel = "Undo", duration = SnackbarDuration.Short)
            if (r != SnackbarResult.ActionPerformed) repo.deleteSession(id)
            pendingDelete = pendingDelete - id
        }
    }

    Scaffold(
        snackbarHost = { ParloSnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text("Past walks", style = MaterialTheme.typography.headlineMedium) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        if (visible.isEmpty()) {
            Box(Modifier.fillMaxSize().padding(padding), contentAlignment = Alignment.Center) {
                Text("No walks yet.\nEvery walk's transcript and recap lands here.", textAlign = TextAlign.Center, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            return@Scaffold
        }
        val grouped = visible.groupBy { weekLabel(it.startedAt) }
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(ParloSpacing.space4), verticalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
            grouped.forEach { (week, list) ->
                item(key = "week-$week") {
                    Overline(week, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(top = ParloSpacing.space4, bottom = ParloSpacing.space2))
                }
                itemsIndexed(list, key = { _, it -> it.id }) { i, s ->
                    SessionCard(s, ParloShape.grouped(i, list.size), onClick = { onOpen(s.id) }, onDelete = { deleteWithUndo(s.id) })
                }
            }
        }
    }
}

/** Monogram · recap-written title · date, duration and outcome. Excluded walks keep their row, dimmed and tagged. */
@Composable
private fun SessionCard(s: SessionEntity, shape: androidx.compose.ui.graphics.Shape, onClick: () -> Unit, onDelete: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(onClick = onClick, shape = shape, color = scheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
        Row(Modifier.padding(start = ParloSpacing.space4, top = ParloSpacing.space3, bottom = ParloSpacing.space3, end = ParloSpacing.space1), verticalAlignment = Alignment.CenterVertically) {
            LanguageMonogram(s.language, dimmed = !s.remember)
            Spacer(Modifier.width(ParloSpacing.space4))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text("${sessionTitle(s.language, s.dialect)} · ${Level.parse(s.level).label}", style = MaterialTheme.typography.titleMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(
                    "${formatDate(s.startedAt)} · ${formatDuration(s.durationMs)}" + when {
                        s.interrupted -> " · Interrupted, progress saved"
                        s.endedAt == null -> " · In progress"
                        else -> ""
                    },
                    style = MaterialTheme.typography.bodySmall,
                    color = scheme.onSurfaceVariant,
                )
                s.recap?.takeIf { it.isNotBlank() }?.let {
                    Text(it.replace('\n', ' '), style = MaterialTheme.typography.bodyMedium, maxLines = 2, overflow = TextOverflow.Ellipsis)
                }
                if (!s.remember) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(Icons.Rounded.VisibilityOff, null, Modifier.size(14.dp), tint = scheme.onSurfaceVariant)
                        Spacer(Modifier.width(ParloSpacing.space1))
                        Text("Not remembered", style = MaterialTheme.typography.labelMedium, color = scheme.onSurfaceVariant)
                    }
                }
            }
            IconButton(onClick = onDelete) { Icon(Icons.Rounded.Delete, "Delete walk", tint = scheme.onSurfaceVariant) }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SessionDetailScreen(sessionId: Long, onBack: () -> Unit) {
    val container = ParloApp.container(LocalContext.current)
    val repo = container.sessions
    val capture = container.vocabCapture
    val data by repo.observeSessionWithTurns(sessionId).collectAsStateWithLifecycle(initialValue = null)
    val mining by capture.mining.collectAsStateWithLifecycle()
    val s = data?.session
    var excludeMemory by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val snackbar = remember { SnackbarHostState() }

    Scaffold(
        snackbarHost = { ParloSnackbarHost(snackbar) },
        topBar = {
            TopAppBar(
                title = { Text(s?.let { it.dialect.ifBlank { it.language } } ?: "Walk", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = { IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") } },
            )
        },
    ) { padding ->
        val turns = data?.turns.orEmpty().sortedBy { it.id }
        LazyColumn(Modifier.fillMaxSize().padding(padding), contentPadding = PaddingValues(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
            if (s != null) {
                item {
                    Text(
                        "${Level.parse(s.level).label} · ${formatDate(s.startedAt)} · ${formatDuration(s.durationMs)} · ${turns.size} turns",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(bottom = 8.dp),
                    )
                }
                if (!s.recap.isNullOrBlank()) {
                    item {
                        Card(Modifier.fillMaxWidth(), shape = ParloShape.extraLarge, colors = CardDefaults.cardColors(containerColor = MaterialTheme.colorScheme.tertiaryContainer)) {
                            Column(Modifier.padding(ParloSpacing.space5), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
                                Overline("Recap", color = MaterialTheme.colorScheme.onTertiaryContainer)
                                Text(s.recap, style = MaterialTheme.typography.bodyLarge, color = MaterialTheme.colorScheme.onTertiaryContainer)
                            }
                        }
                    }
                }
                item {
                    AssistChip(enabled = s.remember, onClick = { excludeMemory = true },
                        label = { Text(if (s.remember) "Exclude this walk from memory" else "Excluded from tutor memory") })
                }
                if (s.endedAt != null && s.remember) {
                    item {
                        AssistChip(
                            enabled = sessionId !in mining,
                            onClick = {
                                scope.launch {
                                    val msg = when (val o = capture.mine(sessionId, force = true)) {
                                        is VocabCapture.Outcome.Found -> "${o.count} new word${if (o.count == 1) "" else "s"} waiting in Vocabulary"
                                        VocabCapture.Outcome.NothingNew -> "Nothing new to suggest"
                                        VocabCapture.Outcome.TooShort -> "Too short a conversation to mine"
                                        VocabCapture.Outcome.NoApiKey -> "Add a Gemini key in Settings first"
                                        is VocabCapture.Outcome.Failed -> "Couldn't find words: ${o.message}"
                                    }
                                    snackbar.showSnackbar(msg)
                                }
                            },
                            label = { Text(if (sessionId in mining) "Finding words…" else "Find words in this walk") },
                            leadingIcon = { Icon(Icons.Filled.AutoAwesome, null) },
                            modifier = Modifier.padding(bottom = 8.dp),
                        )
                    }
                }
            }
            items(turns, key = { it.id }) { t ->
                TurnBubble(
                    TranscriptTurn(
                        id = t.id,
                        speaker = runCatching { Speaker.valueOf(t.speaker) }.getOrDefault(Speaker.SYSTEM),
                        text = t.text,
                        timestampMs = t.timestamp,
                    ),
                )
            }
        }
    }
    if (excludeMemory) {
        AlertDialog(onDismissRequest = { excludeMemory = false }, title = { Text("Exclude this walk?") },
            text = { Text("Future conversations won't use this walk's transcript or teaching checkpoints as memory. Your transcript and saved vocabulary remain available to you.") },
            confirmButton = { TextButton(onClick = {
                scope.launch { container.learning.forgetSession(sessionId) }
                excludeMemory = false
            }) { Text("Exclude walk") } },
            dismissButton = { TextButton(onClick = { excludeMemory = false }) { Text("Cancel") } })
    }
}

private fun formatDate(ms: Long): String = DateFormat.getDateTimeInstance(DateFormat.MEDIUM, DateFormat.SHORT).format(Date(ms))

private fun formatDuration(ms: Long): String {
    val m = ms / 60_000
    return when {
        m >= 60 -> "${m / 60} h ${m % 60} min"
        m >= 1 -> "$m min"
        else -> "under a minute"
    }
}

private fun weekLabel(ms: Long): String {
    val now = java.util.Calendar.getInstance()
    val then = java.util.Calendar.getInstance().apply { timeInMillis = ms }
    val sameYear = now.get(java.util.Calendar.YEAR) == then.get(java.util.Calendar.YEAR)
    val weekDiff = if (sameYear) now.get(java.util.Calendar.WEEK_OF_YEAR) - then.get(java.util.Calendar.WEEK_OF_YEAR) else Int.MAX_VALUE
    return when {
        weekDiff <= 0 && sameYear -> "This week"
        weekDiff == 1 -> "Last week"
        else -> java.text.SimpleDateFormat("MMMM yyyy", java.util.Locale.getDefault()).format(Date(ms))
    }
}

/** "Castilian Spanish", or "Italian · Standard" when the accent alone doesn't name the language. */
internal fun sessionTitle(language: String, dialect: String): String = when {
    dialect.isBlank() -> language
    language.isBlank() || dialect.contains(language, ignoreCase = true) -> dialect
    else -> "$language · $dialect"
}
