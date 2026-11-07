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
            Text("Merge decision needs review", style = MaterialTheme.typography.titleMedium)
            Text("These records were merged, but an older decision still says they are different people. This is not a disagreement about a phone number.", style = MaterialTheme.typography.bodyMedium)
            Button(onClick = { reviewing = person }) { Text("Resolve merge decision") }
        }
    }
    reviewing?.let { expected -> MergeDecisionDialog(expected, graph) { reviewing = null } }
}

@Composable
private fun MergeDecisionDialog(person: Person, graph: AppGraph, close: () -> Unit) {
    val scope = rememberCoroutineScope()
    val duplicates = remember(person) { person.contactCard().withoutDuplicatePhones().removed }
    val onlyMergeConflicts = person.mergeDecisionConflicts().size == person.contact_conflicts.size
    val canCleanPhones = onlyMergeConflicts && !person.trashed
    val records = person.contact_aliases.size + 1
    var keepMerged by remember { mutableStateOf<Boolean?>(null) }
    var cleanPhones by remember { mutableStateOf(duplicates > 0 && canCleanPhones) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    AlertDialog(
        onDismissRequest = { if (!busy) close() },
        title = { Text("Resolve merge decision") },
        text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
                Text(person.name, style = MaterialTheme.typography.titleMedium)
                Text("Are these records one person, or should they stay separate? Both choices preserve facts and edit history.")
                val names = (listOf(person.name) + person.aliases).distinct()
                if (names.size > 1) Text("Saved names: ${names.joinToString(" · ")}", style = MaterialTheme.typography.bodySmall)
                Column(Modifier.selectableGroup()) {
                    MergeChoice("Keep one merged contact", keepMerged == true, !busy) { keepMerged = true }
                    MergeChoice("Restore $records separate contact records", keepMerged == false, !busy) { keepMerged = false }
                }
                if (keepMerged == true) {
                    Text("Clears the older keep-separate decision. The current merged contact stays in place.", style = MaterialTheme.typography.bodySmall)
                    if (duplicates > 0 && canCleanPhones) Row(Modifier.fillMaxWidth().toggleable(cleanPhones, enabled = !busy, role = Role.Checkbox, onValueChange = { cleanPhones = it })) {
                        Checkbox(cleanPhones, onCheckedChange = null, enabled = !busy)
                        Text("Also remove $duplicates duplicate phone ${if (duplicates == 1) "field" else "fields"}", Modifier.padding(top = 12.dp))
                    }
                    if (!onlyMergeConflicts) Text("Other details still need a choice. Phone cleanup will be available once those conflicts are resolved.", style = MaterialTheme.typography.bodySmall)
                } else if (keepMerged == false) {
                    Text("Restores the original records using their existing field ownership. Saved edits stay with the records that own them. This can bring back duplicate-looking contacts; no facts or history are deleted.", style = MaterialTheme.typography.bodySmall)
                }
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        },
        confirmButton = {
            TextButton(enabled = !busy && keepMerged != null, onClick = { scope.launch {
                busy = true; error = null
                try {
                    graph.resolveMergeDecision(person, keepMerged == true, keepMerged == true && cleanPhones && canCleanPhones)
                    close()
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { error = graph.editError(e) }
                finally { busy = false }
            } }) { Text(if (busy) "Saving…" else if (keepMerged == false) "Restore separate records" else "Keep merged contact") }
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
internal fun DuplicatePhoneAction(person: Person, id: Int, graph: AppGraph) {
    val duplicates = remember(person) { person.contactCard().withoutDuplicatePhones().removed }
    if (duplicates == 0) return
    var expected by remember { mutableStateOf<Person?>(null) }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    Column(verticalArrangement = Arrangement.spacedBy(KinSpace.s1)) {
        OutlinedButton(enabled = person.contact_conflicts.isEmpty(), onClick = { expected = person; error = null }) { Text("Remove $duplicates duplicate phone ${if (duplicates == 1) "field" else "fields"}") }
        if (person.contact_conflicts.isNotEmpty()) Text("Resolve the conflicts above to finish phone cleanup.", style = MaterialTheme.typography.bodySmall)
    }
    expected?.let { snapshot ->
        AlertDialog(onDismissRequest = { if (!busy) expected = null }, title = { Text("Remove duplicate phone fields?") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                Text("Keeps one entry for each equivalent number and combines its labels and default setting. Different extensions and uncertain country codes are not guessed. Originals remain in history.")
                error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
            }
        }, confirmButton = { TextButton(enabled = !busy, onClick = { scope.launch {
            busy = true; error = null
            try { graph.cleanDuplicatePhones(id, snapshot); expected = null }
            catch (e: CancellationException) { throw e }
            catch (e: Exception) { error = graph.editError(e) }
            finally { busy = false }
        } }) { Text(if (busy) "Saving…" else "Remove duplicates") } }, dismissButton = { TextButton(enabled = !busy, onClick = { expected = null }) { Text("Cancel") } })
    }
}
