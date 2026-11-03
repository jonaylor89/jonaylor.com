package com.parlo.app.ui.main

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloSpacing

/** Exploration is the default action; removing a saved word is an explicit secondary choice. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun VocabularyWordSheet(word: VocabEntity, onDismiss: () -> Unit, onOpenVocab: () -> Unit, onRemove: () -> Unit) {
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
        containerColor = MaterialTheme.colorScheme.surfaceContainerHigh) {
        Column(Modifier.fillMaxWidth().verticalScroll(rememberScrollState())
            .padding(horizontal = ParloSpacing.space5).padding(bottom = ParloSpacing.space8).testTag("word_details"),
            verticalArrangement = Arrangement.spacedBy(ParloSpacing.space4)) {
            Text(word.language, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.secondary)
            SelectionContainer {
                Column(verticalArrangement = Arrangement.spacedBy(ParloSpacing.space3)) {
                    Text(word.word, style = Parlo.type.phraseLarge)
                    if (word.translation.isNotBlank()) Text(word.translation, style = MaterialTheme.typography.titleLarge)
                    if (word.exampleSentence.isNotBlank()) {
                        Text("From your conversation", style = MaterialTheme.typography.labelLarge)
                        Text(word.exampleSentence, style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            Button(onClick = onOpenVocab, modifier = Modifier.fillMaxWidth()) { Text("Review in Vocabulary") }
            TextButton(onClick = onRemove, colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)) {
                Text("Remove saved word")
            }
        }
    }
}
