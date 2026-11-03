package com.parlo.app.ui.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Slider
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextAlign
import com.parlo.app.model.Encouragement
import com.parlo.app.ui.theme.ParloSpacing
import kotlin.math.roundToInt

/** Preview while dragging; commit once on release so a live walk isn't interrupted at every tick. */
@Composable
internal fun EncouragementControl(value: Encouragement, onChange: (Encouragement) -> Unit) {
    var draft by remember(value) { mutableIntStateOf(value.ordinal) }
    val tone = Encouragement.entries[draft]
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space2)) {
        Text("Encouragement", style = MaterialTheme.typography.titleMedium)
        Text(tone.label, style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.primary)
        Text(tone.description, style = MaterialTheme.typography.bodyMedium)
        Slider(
            value = draft.toFloat(),
            onValueChange = { draft = it.roundToInt().coerceIn(Encouragement.entries.indices) },
            onValueChangeFinished = {
                val selected = Encouragement.entries[draft]
                if (selected != value) onChange(selected)
            },
            valueRange = 0f..Encouragement.entries.lastIndex.toFloat(),
            steps = Encouragement.entries.size - 2,
            modifier = Modifier.fillMaxWidth().testTag("encouragement_slider").semantics {
                contentDescription = "Encouragement"
                stateDescription = tone.label
            },
        )
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space4)) {
            Text(Encouragement.entries.first().label, style = MaterialTheme.typography.bodySmall, modifier = Modifier.weight(1f))
            Text(Encouragement.entries.last().label, style = MaterialTheme.typography.bodySmall,
                modifier = Modifier.weight(1f), textAlign = TextAlign.End)
        }
        Text("Example response", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Text("“${tone.example}”", style = MaterialTheme.typography.bodyMedium)
        Text("Always adult-to-adult, in every language. Changes tone, not difficulty or corrections. The tutor still leads at every setting.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
}
