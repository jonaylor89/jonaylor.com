package app.mypeople.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.launch
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** Exact attribution edge selection, not a destructive copy of a flattened contact card. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun SplitContactDialog(person: Person, graph: AppGraph, close: () -> Unit, opened: (String) -> Unit) {
    var selection by remember(person.contact_uid) { mutableStateOf<GraphSelection?>(null) }
    var selected by remember { mutableStateOf(setOf<String>()) }
    var name by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    var review by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    LaunchedEffect(person.contact_uid) {
        runCatching { graph.store.associations(person.contact_uid) }.onSuccess { selection = it }.onFailure { error = it.message }
    }
    ModalBottomSheet(onDismissRequest = { if (!saving) close() }) {
        Column(Modifier.fillMaxWidth().padding(horizontal = 24.dp).padding(bottom = 24.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            Text(if (review) "Review split" else "Separate another person", style = MaterialTheme.typography.headlineSmall)
            Text("Move only the selected associations from ${person.name}. Original objects and attribution history remain available on every device.", style = MaterialTheme.typography.bodyMedium)
            OutlinedTextField(value = name, onValueChange = { name = it }, label = { Text("New person's name") }, singleLine = true, enabled = !saving, modifier = Modifier.fillMaxWidth())
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            val rows = selection?.associations.orEmpty().filter { !review || it.id in selected }
            if (selection == null && error == null) CircularProgressIndicator()
            LazyColumn(Modifier.fillMaxWidth().weight(1f, fill = false).heightIn(max = 420.dp)) {
                items(rows, key = { it.id }) { row ->
                    Row(Modifier.fillMaxWidth().clickable(enabled = !saving && !review) { selected = if (row.id in selected) selected - row.id else selected + row.id }.padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
                        Checkbox(checked = row.id in selected, enabled = !saving && !review, onCheckedChange = { checked -> selected = if (checked) selected + row.id else selected - row.id })
                        Column {
                            Text(row.kind.replace('_', ' '), style = MaterialTheme.typography.labelMedium)
                            Text(row.label, style = MaterialTheme.typography.bodyMedium)
                        }
                    }
                }
            }
            Text("${selected.size} selected · ${selection?.associations?.size?.minus(selected.size) ?: 0} stay with ${person.name}", style = MaterialTheme.typography.labelLarge)
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                TextButton(onClick = { if (review) review = false else close() }, enabled = !saving) { Text(if (review) "Back" else "Cancel") }
                Button(enabled = !saving && name.isNotBlank() && selected.isNotEmpty() && selection != null, onClick = {
                    if (!review) review = true else {
                        saving = true
                        scope.launch {
                            runCatching { graph.store.split(selection!!, name, selected.sorted()) }.onSuccess { id ->
                                val uid = graph.store.state.value.records.people.getValue(id).contact_uid
                                opened(uid)
                            }.onFailure { error = it.message; saving = false }
                        }
                    }
                }) { Text(if (saving) "Saving…" else if (review) "Move associations" else "Review split") }
            }
            if (person.can_undo_merge && !review) TextButton(enabled = !saving, onClick = {
                saving = true
                scope.launch {
                    runCatching { graph.submitEdit("merge_undo", buildJsonObject { put("contact_uid", person.contact_uid) }) }
                        .onSuccess { close() }.onFailure { error = it.message; saving = false }
                }
            }) { Text("Retract merge assertions instead") }
        }
    }
}
