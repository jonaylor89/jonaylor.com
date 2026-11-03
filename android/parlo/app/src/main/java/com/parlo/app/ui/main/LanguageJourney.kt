package com.parlo.app.ui.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Add
import androidx.compose.material.icons.rounded.Flag
import androidx.compose.material3.Icon
import androidx.compose.material3.Surface
import com.parlo.app.ui.components.LanguageSegment
import com.parlo.app.ui.components.Overline
import com.parlo.app.ui.components.nativeNameOf
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSpacing
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import com.parlo.app.data.LearningRepository
import com.parlo.app.model.SessionConfig
import com.parlo.app.ui.MainUiState

/** Languages are separate ongoing journeys, not presets that overwrite one another. */
@Composable
internal fun LanguageJourneyPicker(
    config: SessionConfig,
    languages: List<SessionConfig>,
    onSelect: (String) -> Unit,
    onMore: () -> Unit,
) {
    val choices = (listOf(config.language) + languages.map { it.language })
        .filter { it.isNotBlank() }
        .distinctBy(LearningRepository::key)
    val rowState = rememberLazyListState()
    LaunchedEffect(config.language) { rowState.scrollToItem(0) }
    Column(Modifier.fillMaxWidth().testTag("language_journeys"), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Text("Which language today?", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
            TextButton(onClick = onMore) {
                Icon(Icons.Rounded.Add, null, Modifier.size(18.dp))
                Spacer(Modifier.width(ParloSpacing.space1))
                Text("Add language")
            }
        }
        LazyRow(
            state = rowState,
            horizontalArrangement = Arrangement.spacedBy(ParloSpacing.hair),
            verticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth().selectableGroup().testTag("your_languages"),
        ) {
            itemsIndexed(choices, key = { _, l -> LearningRepository.key(l) }) { i, language ->
                val selected = language.equals(config.language, true)
                LanguageSegment(
                    language = language,
                    selected = selected,
                    index = i,
                    count = choices.size,
                    onClick = { onSelect(language) },
                    modifier = Modifier.testTag("journey_${LearningRepository.key(language)}"),
                )
            }
        }
    }
}

/** The journey for the current language: the learner's goal in their words and the latest dated checkpoint. */
@Composable
internal fun JourneyStatus(ui: MainUiState, onOpen: () -> Unit) {
    val scheme = MaterialTheme.colorScheme
    Surface(shape = ParloShape.large, color = scheme.surfaceContainer, modifier = Modifier.fillMaxWidth()) {
        Column(Modifier.padding(ParloSpacing.space4), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
            Overline(
                "Your goal · ${nativeNameOf(ui.config.language)}",
                color = scheme.secondary, icon = Icons.Rounded.Flag,
            )
            Text(ui.goal.ifBlank { "What would you like to be able to do?" }, style = MaterialTheme.typography.titleLarge,
                color = if (ui.goal.isBlank()) scheme.onSurfaceVariant else scheme.onSurface)
            Text(if (ui.lastPractisedAt == null) "A new chapter in ${ui.config.language}" else
                "${ui.walkCount} completed walk${if (ui.walkCount == 1) "" else "s"} in ${ui.config.language}",
                style = MaterialTheme.typography.bodyMedium, color = scheme.onSurfaceVariant)
            ui.learningEpisodes.firstOrNull { it.demonstrated.isNotBlank() }?.let {
                Row(horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space3)) {
                    Text(LearningRepository.date(it.occurredAt), style = MaterialTheme.typography.labelMedium, color = scheme.secondary, modifier = Modifier.padding(top = 2.dp))
                    Text(it.demonstrated, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
                }
            }
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End) {
                TextButton(onClick = onOpen, modifier = Modifier.testTag("learning_journal")) { Text("Your journey") }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun LearningJournalSheet(
    ui: MainUiState,
    onSaveGoal: (String) -> Unit,
    onForget: (Long) -> Unit,
    onHistory: () -> Unit,
    onDismiss: () -> Unit,
) {
    var goal by remember(ui.config.language, ui.goal) { mutableStateOf(ui.goal) }
    var forget by remember { mutableStateOf<Long?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        LazyColumn(Modifier.fillMaxWidth().padding(horizontal = 20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item {
                Text("Your ${ui.config.language} journey", style = MaterialTheme.typography.headlineSmall)
                Text("A continuing conversation, at your pace.", style = MaterialTheme.typography.bodyMedium)
            }
            item {
                OutlinedTextField(value = goal, onValueChange = { goal = it.take(500) }, label = { Text("My learning goal") },
                    placeholder = { Text("For example, feel comfortable in everyday conversations") }, modifier = Modifier.fillMaxWidth())
                Row {
                    Button(onClick = { onSaveGoal(goal) }, enabled = goal.trim() != ui.goal) { Text("Save goal") }
                    TextButton(onClick = onHistory) { Text("Conversation history") }
                }
            }
            item {
                HorizontalDivider()
                Spacer(Modifier.height(12.dp))
                Text("What Parlo remembers", style = MaterialTheme.typography.titleMedium)
                Text("Dated observations, not permanent grades. Recent successes should replace old assumptions. You can exclude any walk below.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (ui.learningEpisodes.isEmpty()) item {
                Text("Your history is saved as you talk. Teaching checkpoints appear after background processing; you don't need to wait before your next walk.")
            }
            items(ui.learningEpisodes, key = { it.id }) { episode ->
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("${LearningRepository.date(episode.occurredAt)} · Walk ${episode.sessionId} · Turns ${episode.fromTurnId}–${episode.throughTurnId}",
                        style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.secondary)
                    Text(episode.summary)
                    if (episode.demonstrated.isNotBlank()) Text("Observed: ${episode.demonstrated}", style = MaterialTheme.typography.bodyMedium)
                    if (episode.practise.isNotBlank()) Text("Try again later: ${episode.practise}", style = MaterialTheme.typography.bodyMedium)
                    if (episode.nextStep.isNotBlank()) Text("Possible next step: ${episode.nextStep}", style = MaterialTheme.typography.bodySmall)
                    TextButton(onClick = { forget = episode.sessionId }) { Text("Exclude this walk from memory") }
                    HorizontalDivider()
                }
            }
            item { LearningBackupControls(enabled = !ui.live.isActive) }
            item { Spacer(Modifier.height(32.dp)) }
        }
    }
    forget?.let { id ->
        AlertDialog(onDismissRequest = { forget = null }, title = { Text("Exclude this walk?") },
            text = { Text("Parlo will stop using this walk's transcript and teaching checkpoints as memory, in every language. The transcript and saved vocabulary remain available to you. Your next conversation will use the updated memory.") },
            confirmButton = { TextButton(onClick = { onForget(id); forget = null }) { Text("Exclude walk") } },
            dismissButton = { TextButton(onClick = { forget = null }) { Text("Cancel") } })
    }
}
