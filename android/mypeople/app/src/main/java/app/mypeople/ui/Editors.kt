package app.mypeople.ui

import app.mypeople.ui.icons.*

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.toggleable
import androidx.compose.ui.Alignment
import androidx.compose.ui.semantics.Role
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.serialization.json.*
import kotlin.math.roundToInt

@Composable
fun Choice(label: String, selected: String, options: List<String>, onSelect: (String) -> Unit) {
    var expanded by remember { mutableStateOf(false) }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(label, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Box {
            OutlinedButton(onClick = { expanded = true }, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), shape = MaterialTheme.shapes.small) {
                Text(selected.replace('_', ' ').replaceFirstChar { it.uppercase() }, Modifier.weight(1f))
                Icon(Icons.Outlined.ExpandMore, null)
            }
            DropdownMenu(expanded, { expanded = false }) {
                options.forEach { value -> DropdownMenuItem(text = { Text(value) }, onClick = { onSelect(value); expanded = false }) }
            }
        }
    }
}

@Composable
fun PersonEditor(mode: String, id: Int, person: Person, graph: AppGraph, close: () -> Unit) {
    var text by rememberSaveable { mutableStateOf(if (mode == "Rename") person.name else "") }
    var type by rememberSaveable { mutableStateOf("other") }
    var date by rememberSaveable { mutableStateOf("") }
    var category by rememberSaveable { mutableStateOf(person.category) }
    var closeness by rememberSaveable { mutableFloatStateOf(person.closeness.toFloat()) }
    var autoCloseness by rememberSaveable { mutableStateOf(false) }
    var cadence by rememberSaveable { mutableStateOf(person.cadence_days?.roundToInt()?.toString().orEmpty()) }
    var muted by rememberSaveable { mutableStateOf(person.muted) }
    val relationship = mode == "Relationship settings"
    val dateValid = date.isBlank() || normalizeDate(date).isNotEmpty()
    val cadenceValid = cadence.isBlank() || (cadence.toDoubleOrNull()?.let { it.isFinite() && it > 0 } == true)
    val valid = if (relationship) cadenceValid else text.isNotBlank() && (mode != "Add fact" || dateValid)
    fun send(kind: String, extra: JsonObjectBuilder.() -> Unit) {
        graph.edit(kind, buildJsonObject { put("person_id", id); extra() }); close()
    }
    AlertDialog(onDismissRequest = close, icon = { Icon(if (relationship) Icons.Outlined.Tune else Icons.Outlined.EditNote, null) }, title = { Text(mode) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            when {
                relationship -> {
                    Choice("Category", category, listOf("Automatic") + categories) { category = it }
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(autoCloseness, role = Role.Checkbox, onValueChange = { autoCloseness = it }).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(autoCloseness, onCheckedChange = null)
                        Text("Infer closeness automatically", Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyMedium)
                    }
                    if (!autoCloseness) {
                        Text("Closeness · ${(closeness * 100).roundToInt()}%")
                        Slider(closeness, { closeness = it })
                    }
                    OutlinedTextField(cadence, { cadence = it }, label = { Text("Contact cadence in days") }, supportingText = { Text("Leave blank to infer automatically") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Decimal), isError = !cadenceValid, singleLine = true, modifier = Modifier.fillMaxWidth())
                    Row(Modifier.fillMaxWidth().heightIn(min = 48.dp).toggleable(muted, role = Role.Checkbox, onValueChange = { muted = it }).padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(muted, onCheckedChange = null)
                        Text("Mute nudges and upcoming", Modifier.padding(start = 12.dp), style = MaterialTheme.typography.bodyMedium)
                    }
                }
                else -> {
                    if (mode == "Nicknames") {
                        Text("Remove a nickname, or add another below.")
                        person.aliases.forEach { alias ->
                            TextButton(onClick = { send("alias_remove") { put("alias", alias) } }) { Text("Remove “$alias”") }
                        }
                    }
                    if (mode == "Add fact") Choice("Type", type, eventTypes) { type = it }
                    OutlinedTextField(text, { text = it }, label = { Text(when (mode) { "Rename" -> "Name"; "Nicknames" -> "Nickname"; "Add note" -> "What would you like to remember?"; else -> "Fact" }) }, minLines = if (mode == "Add note") 3 else 1, modifier = Modifier.fillMaxWidth())
                    if (mode == "Add fact") OutlinedTextField(date, { date = it }, label = { Text("Date (optional)") }, supportingText = { Text("YYYY, YYYY-MM, YYYY-MM-DD or --MM-DD") }, isError = !dateValid, singleLine = true)
                    if (mode == "Add note") Text("Saved on this contact as you wrote it, and sent to your Mac at your next sync.", style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }, confirmButton = {
        FilledTonalButton(enabled = valid, onClick = {
            when (mode) {
                "Rename" -> send("rename") { put("name", text.trim()) }
                "Nicknames" -> send("alias_add") { put("alias", text.trim()) }
                "Add fact" -> send("event_add") { put("type", type); put("value", text.trim()); put("date", date.trim()) }
                "Add note" -> send("note") { put("text", text.trim()) }
                else -> send("relationship") {
                    put("category", if (category == "Automatic") JsonNull else JsonPrimitive(category))
                    put("closeness", if (autoCloseness) JsonNull else JsonPrimitive(closeness.toDouble()))
                    put("cadence_days", cadence.toDoubleOrNull()?.let(::JsonPrimitive) ?: JsonNull)
                    put("muted", muted)
                }
            }
        }) { Text(if (mode == "Add note") "Queue note" else "Save") }
    }, dismissButton = { TextButton(onClick = close) { Text("Cancel") } })
}
