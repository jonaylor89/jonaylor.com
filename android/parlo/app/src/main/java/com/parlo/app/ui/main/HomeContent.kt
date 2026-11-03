package com.parlo.app.ui.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.rounded.Forum
import androidx.compose.material.icons.rounded.Route
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.ui.MainUiState
import com.parlo.app.ui.theme.ParloSpacing

/** Home's decision hierarchy. The hosting Scaffold reserves the measured height of its Start bar. */
@Composable
internal fun HomeContent(
    ui: MainUiState,
    onSelectLanguage: (String) -> Unit,
    onAddLanguage: () -> Unit,
    onWalkSettings: () -> Unit,
    onModeSelected: (Boolean) -> Unit,
    onWordSelected: (VocabEntity) -> Unit,
    onOpenJourney: () -> Unit,
    onOpenVocab: () -> Unit,
    onOpenHistory: () -> Unit,
    modifier: Modifier = Modifier,
    statusContent: @Composable () -> Unit = {},
) {
    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(horizontal = ParloSpacing.space4)
            .testTag("home_content"),
        verticalArrangement = Arrangement.spacedBy(ParloSpacing.space4),
    ) {
        statusContent()
        LanguageJourneyPicker(ui.config, ui.languages, onSelectLanguage, onAddLanguage)
        NextWalkCard(ui.config, ui.lastWalk, onWalkSettings)
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
            Text("Practice mode", style = MaterialTheme.typography.labelLarge)
            ConnectedChoice(
                options = listOf(true, false), selected = ui.config.followPlan,
                label = { if (it) "Guided practice" else "Just chat" },
                icon = { if (it) Icons.Rounded.Route else Icons.Rounded.Forum },
                onSelect = onModeSelected,
                modifier = Modifier.testTag("practice_mode"),
            )
        }
        if (ui.lastWalk != null) {
            LastWalkCard(ui.lastWalk, onWordSelected, onOpenVocab)
        } else if (ui.suggestedVocab > 0) {
            ReviewCard(ui.suggestedVocab, onOpenVocab)
        }
        JourneyStatus(ui, onOpenJourney)
        if (ui.live.transcript.isNotEmpty() && ui.lastWalk == null) {
            TextButton(onClick = onOpenHistory) { Text("Read your conversation") }
        }
        Spacer(Modifier.height(ParloSpacing.space2))
    }
}
