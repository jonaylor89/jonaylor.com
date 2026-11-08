package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.selectableGroup
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
internal fun MergeDecisionPrompt(person: Person, graph: AppGraph) {
    var reviewing by remember { mutableStateOf<Person?>(null) }
    Surface(shape = MaterialTheme.shapes.large, color = MaterialTheme.colorScheme.secondaryContainer) {
        Column(Modifier.fillMaxWidth().padding(KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            Text("Earlier separation decision", style = MaterialTheme.typography.titleMedium)
            Text("An older decision marked some source records as different people. Having more than one phone number is not a conflict, and repeated entries can be cleaned up without deciding this.", style = MaterialTheme.typography.bodyMedium)
            Button(onClick = { reviewing = person }) { Text("Review earlier decision") }
        }
    }
    reviewing?.let { expected -> MergeDecisionDialog(expected, graph) { reviewing = null } }
}

@Composable
private fun MergeDecisionDialog(person: Person, graph: AppGraph, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val (phoneState, retryPhones) = rememberContactPhonePreview(person, graph)
    val preview = phoneState.preview
    val duplicates = preview?.cleanup?.removed ?: 0
    val onlyMergeConflicts = person.mergeDecisionConflicts().size == person.contact_conflicts.size
    val canCleanPhones = onlyMergeConflicts && !person.trashed && preview != null
    val records = person.contact_aliases.size + 1
    var keepMerged by remember { mutableStateOf<Boolean?>(null) }
    var cleanPhones by remember { mutableStateOf(true) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) close() },
        title = { Text("Review earlier decision") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
                Text(person.name, style = MaterialTheme.typography.titleMedium)
                Text("Do the numbers and details below correctly describe this person? Two different numbers can both belong to the same person.")
                if (preview != null) {
                    PhoneNumbersPreview(preview)
                    EarlierSeparationPreview(preview)
                }
                else if (phoneState.failed) TextButton(onClick = retryPhones) { Text("Retry phone preview") }
                else Text("Checking phone entries…")
                Text("The warning comes from an earlier keep-separate decision, not from having multiple phone numbers.", style = MaterialTheme.typography.bodySmall)
                val names = (listOf(person.name) + person.aliases).distinct()
                if (names.size > 1) Text("Saved names: ${names.joinToString(" · ")}", style = MaterialTheme.typography.bodySmall)
                Column(Modifier.selectableGroup()) {
                    MergeChoice("These details belong to one person", keepMerged == true, !busy) { keepMerged = true }
                    MergeChoice("These details belong to different people", keepMerged == false, !busy) { keepMerged = false }
                }
                if (keepMerged == true) {
                    Text("Clears the older keep-separate decision. The current merged contact stays in place.", style = MaterialTheme.typography.bodySmall)
                    if (duplicates > 0 && canCleanPhones) Row(Modifier.fillMaxWidth().toggleable(cleanPhones, enabled = !busy, role = Role.Checkbox, onValueChange = { cleanPhones = it })) {
                        Checkbox(cleanPhones, onCheckedChange = null, enabled = !busy)
                        Text("Also remove $duplicates duplicate phone ${if (duplicates == 1) "field" else "fields"}", Modifier.padding(top = 12.dp))
                    }
                    if (!onlyMergeConflicts) Text("Other details still need a choice. Phone cleanup will be available once those conflicts are resolved.", style = MaterialTheme.typography.bodySmall)
                } else if (keepMerged == false) {
                    Text("Restores all $records original contact records using their existing field ownership. Saved edits stay with the records that own them. This can bring back duplicate-looking contacts; no facts or history are deleted.", style = MaterialTheme.typography.bodySmall)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && keepMerged != null && preview != null, onClick = { scope.launch {
                busy = true; error = null
                try {
                    graph.resolveMergeDecision(person, keepMerged == true, keepMerged == true && cleanPhones && canCleanPhones)
                    close()
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { error = graph.editError(e) }
                finally { busy = false }
            } }) { Text(if (busy) "Saving…" else if (keepMerged == false) "Restore $records separate records" else "Keep this contact") }
        },
        dismissButton = { TextButton(enabled = !busy, onClick = close) { Text("Cancel") } },
    )
}

@Composable
private fun MergeChoice(label: String, selected: Boolean, enabled: Boolean, choose: () -> Unit) {
    Row(Modifier.fillMaxWidth().selectable(selected, enabled = enabled, role = Role.RadioButton, onClick = choose).padding(vertical = KinSpace.s2)) {
        RadioButton(selected, onClick = null, enabled = enabled)
        Text(label, Modifier.padding(start = KinSpace.s2, top = 12.dp))
    }
}

@Composable
internal fun DuplicatePhoneAction(person: Person, id: Int, graph: AppGraph, preview: ContactPhonePreview) {
    val duplicates = preview.cleanup.removed
    if (duplicates == 0) return
    var expected by remember { mutableStateOf<Person?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(KinSpace.s1)) {
        Text("${preview.entries} saved phone entries · ${preview.numbers.size} distinct numbers", style = MaterialTheme.typography.bodySmall)
        OutlinedButton(enabled = person.canCleanDuplicatePhones(), onClick = { expected = person; error = null }) {
            Text("Remove $duplicates repeated ${if (duplicates == 1) "entry" else "entries"}")
        }
        if (!person.canCleanDuplicatePhones()) Text("A conflicting detail needs a choice before phone cleanup.", style = MaterialTheme.typography.bodySmall)
        else if (person.mergeDecisionConflicts().isNotEmpty()) Text("Phone cleanup leaves the earlier separation decision unchanged.", style = MaterialTheme.typography.bodySmall)
    }
    expected?.let { snapshot ->
        AlertDialog(onDismissRequest = { if (!busy) expected = null }, title = { Text("Keep these numbers, remove repeats?") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                Text(snapshot.name, style = MaterialTheme.typography.titleMedium)
                PhoneNumbersPreview(preview)
                Text("${preview.entries} saved phone entries → ${preview.remainingEntries} entries after cleanup", style = MaterialTheme.typography.titleSmall)
                Text("Removes $duplicates repeated entries, not distinct numbers. All ${preview.numbers.size} numbers above stay. Labels and default settings are combined; original entries remain in history.")
                if (snapshot.mergeDecisionConflicts().isNotEmpty()) Text("This does not confirm a merge or separate any contact records.", style = MaterialTheme.typography.bodySmall)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }, confirmButton = { TextButton(enabled = !busy, onClick = { scope.launch {
            busy = true; error = null
            try { graph.cleanDuplicatePhones(id, snapshot); expected = null }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = graph.editError(e) }
            finally { busy = false }
        } }) { Text(if (busy) "Saving…" else "Remove repeated entries") } }, dismissButton = { TextButton(enabled = !busy, onClick = { expected = null }) { Text("Cancel") } })
    }
}
