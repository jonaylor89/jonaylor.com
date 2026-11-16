package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import app.mypeople.data.CONTACT_DESCRIPTION_LIMIT

@Composable
internal fun ContactDescriptionEntry(description: String, busy: Boolean, change: (String) -> Unit, manually: () -> Unit) {
    Text("Start with a sentence.", style = MaterialTheme.typography.headlineSmall)
    Text("A name, how to reach them, a little context.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
    TextField(description, change, enabled = !busy, label = { Text("Contact description") },
        placeholder = { Text("John Doe from SoAndSo Startup, +11234567890. Met at Climate Week.") },
        supportingText = { Text("${description.length}/$CONTACT_DESCRIPTION_LIMIT · One person at a time") },
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        minLines = 3, maxLines = 6, shape = RoundedCornerShape(KinRadius.xl),
        colors = TextFieldDefaults.colors(focusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow, unfocusedContainerColor = MaterialTheme.colorScheme.surfaceContainerLow,
            focusedIndicatorColor = MaterialTheme.colorScheme.primary, unfocusedIndicatorColor = Color.Transparent, disabledIndicatorColor = Color.Transparent),
        modifier = Modifier.fillMaxWidth())
    Text("Processed on this device with Android’s installed model. Review before saving.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    TextButton(onClick = manually) { Text("Add manually") }
    if (busy) Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
        CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        Text("Creating an editable draft…", style = MaterialTheme.typography.bodyMedium)
    }
}

@Composable
internal fun ContactDescriptionSource(description: String) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Text("Review before saving. Only the fields below are saved, not this original text.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    TextButton(onClick = { expanded = !expanded }) { Text(if (expanded) "Hide original description" else "Show original description") }
    if (expanded) SelectionContainer { Text(description, style = MaterialTheme.typography.bodyMedium) }
}
