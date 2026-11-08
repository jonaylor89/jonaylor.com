package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** One item, one destination, one commit. Evidence suggestions are optional to inspect. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
internal fun MoveContactItemsSheet(
    person: Person,
    selection: GraphSelection,
    anchorId: String,
    graph: AppGraph,
    close: () -> Unit,
    moved: (ContactMove, String) -> Unit,
) {
    val anchor = selection.associations.single { it.id == anchorId }
    val suggested = remember(anchorId) { selection.movingWith(anchorId) }
    var selected by remember(anchorId) { mutableStateOf(suggested) }
    var query by remember(anchorId) { mutableStateOf("") }
    var destination by remember(anchorId) { mutableStateOf<Person?>(null) }
    var showMoving by remember { mutableStateOf(false) }
    var showOthers by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var searchFailed by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    // Capture this sheet's snapshot. Concurrent graph changes are rejected at commit.
    val people = remember(selection) { graph.store.state.value.records.people }
    val matches by produceState<List<Person>>(emptyList(), query, destination) {
        value = emptyList()
        searchFailed = false
        if (destination == null && query.trim().length >= 2) {
            try {
                value = withContext(Dispatchers.IO) {
                    people.values.asSequence().filter {
                        ensureActive()
                        !it.trashed && it.contact_uid != person.contact_uid && person.contact_uid !in it.contact_aliases &&
                            (it.name.contains(query.trim(), ignoreCase = true) || it.contactFields().any { field -> field.value.contains(query.trim(), ignoreCase = true) })
                    }.take(6).toList()
                }
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { searchFailed = true; error = "Couldn't search existing contacts. Close this sheet and try again." }
        }
    }
    val movingRows = selection.associations.filter { it.id in selected && it.id != anchorId }
    val otherRows = selection.associations.filter { it.id !in selected }
    val stayingDetails = otherRows.filter { it.kind == "has_contact_point" || it.isProfile }
    val targetName = destination?.name ?: query.trim()
    ModalBottomSheet(sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true), onDismissRequest = { if (!saving) close() }) {
        Column(Modifier.fillMaxWidth().fillMaxHeight(.94f).imePadding()) {
            LazyColumn(Modifier.weight(1f).fillMaxWidth(), contentPadding = PaddingValues(horizontal = KinSpace.s5), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
                item {
                    Text("Move this item", style = MaterialTheme.typography.headlineSmall)
                    Text(anchor.label, style = MaterialTheme.typography.titleMedium)
                    Text("Currently with ${person.name}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    anchor.url?.let { url -> TextButton(onClick = { openLink(context, url) }) { Text("Open link ↗") } }
                }
                item {
                    val chosen = destination
                    if (chosen == null) {
                        OutlinedTextField(query, onValueChange = { query = it; error = null }, enabled = !saving, singleLine = true,
                            label = { Text("Who does this belong to?") }, placeholder = { Text("Search or name a new person") },
                            modifier = Modifier.fillMaxWidth().testTag("move-destination"))
                    } else {
                        JournalCard {
                            Row(Modifier.padding(KinSpace.s4), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
                                Avatar(chosen, graph)
                                Column(Modifier.weight(1f)) {
                                    Text(chosen.name, style = MaterialTheme.typography.titleMedium)
                                    Text("Existing contact", style = MaterialTheme.typography.labelMedium)
                                }
                                TextButton(enabled = !saving, onClick = { destination = null }) { Text("Change") }
                            }
                        }
                    }
                }
                if (destination == null) {
                    if (matches.isNotEmpty()) item { Text("Existing contacts", style = MaterialTheme.typography.labelLarge) }
                    items(matches, key = { it.contact_uid }) { match ->
                        PersonRow(match, graph, match.contactFields().firstOrNull { it.kind in setOf("phone", "email") }?.value,
                            modifier = Modifier.testTag("move-to-${match.contact_uid}")) { if (!saving) { destination = match; error = null } }
                    }
                    if (query.isNotBlank()) item {
                        Text("Or create “${query.trim()}” using the button below.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                item {
                    HorizontalDivider()
                    Text("Moving with it", style = MaterialTheme.typography.titleMedium)
                    Text(if (movingRows.isEmpty()) "Just this item. Nothing else is selected to move."
                        else "${movingRows.count { it.id in suggested }} related items · ${movingRows.count { it.id !in suggested }} added by you",
                        style = MaterialTheme.typography.bodyMedium)
                    if (movingRows.isNotEmpty()) TextButton(enabled = !saving, onClick = { showMoving = !showMoving }) { Text(if (showMoving) "Hide related items" else "See what's moving") }
                }
                if (showMoving) items(movingRows, key = { "moving-${it.id}" }) { row ->
                    MoveReviewRow(row, checked = true, enabled = !saving) { selected = selected - row.id }
                }
                item {
                    HorizontalDivider()
                    Text("Stays with ${person.name}", style = MaterialTheme.typography.titleMedium)
                    if (stayingDetails.isNotEmpty()) Text(stayingDetails.take(3).joinToString("\n") { it.label }, style = MaterialTheme.typography.bodyMedium)
                    if (stayingDetails.size > 3) Text("And ${stayingDetails.size - 3} other numbers or accounts", style = MaterialTheme.typography.bodySmall)
                    Text("Everything else stays unless you choose it or its recorded evidence links exclusively to this item. Original records and history are preserved.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    if (otherRows.isNotEmpty()) TextButton(enabled = !saving, onClick = { showOthers = !showOthers }, modifier = Modifier.testTag("move-other-items")) { Text(if (showOthers) "Hide other items" else "Choose anything else to move") }
                }
                if (showOthers) items(otherRows, key = { "other-${it.id}" }) { row ->
                    MoveReviewRow(row, checked = false, enabled = !saving) { selected = selected + row.id; showMoving = true }
                }
            }
            Surface(shadowElevation = KinElevation.level1) {
                Column {
                    error?.let { message -> Text(message, Modifier.padding(horizontal = KinSpace.s4, vertical = KinSpace.s2), color = MaterialTheme.colorScheme.error) }
                    Row(Modifier.fillMaxWidth().padding(KinSpace.s4), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
                        TextButton(enabled = !saving, onClick = close) { Text("Cancel") }
                        Button(enabled = !saving && !searchFailed && targetName.isNotBlank(), modifier = Modifier.weight(1f).testTag("move-confirm"), onClick = {
                            saving = true
                            scope.launch {
                                try {
                                    val result = graph.store.moveContactItems(selection, selected, destination?.contact_uid, targetName)
                                    moved(result, targetName)
                                } catch (e: CancellationException) { throw e }
                                catch (e: Exception) { error = graph.editError(e); saving = false }
                            }
                        }) { Text(if (saving) "Moving…" else if (destination == null && targetName.isNotBlank()) "Create $targetName & move" else if (targetName.isNotBlank()) "Move to $targetName" else "Move") }
                    }
                }
            }
        }
    }
}

@Composable
private fun MoveReviewRow(row: GraphAssociation, checked: Boolean, enabled: Boolean, toggle: () -> Unit) {
    Row(Modifier.fillMaxWidth().toggleable(checked, enabled = enabled, role = Role.Checkbox, onValueChange = { toggle() }).padding(vertical = KinSpace.s2), verticalAlignment = Alignment.CenterVertically) {
        Checkbox(checked, onCheckedChange = null, enabled = enabled)
        Text(row.label, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium)
    }
}

/** The contact's editing surface: ownership is corrected where the item is displayed. */
@Composable
internal fun ContactOwnershipRow(row: GraphAssociation, move: () -> Unit) {
    val context = LocalContext.current
    JournalCard(Modifier.padding(bottom = KinSpace.half)) {
        Column(Modifier.padding(KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
            Text(when (row.kind) {
                "has_contact_point" -> "Number or account"
                "has_note" -> "Note"
                "subject_of" -> if (row.isProfile) "Profile" else "Fact"
                "participant" -> "Conversation or interaction"
                "has_name" -> "Name"
                "has_asset" -> "Photo or attachment"
                else -> "Preferences"
            }, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Text(row.label, style = MaterialTheme.typography.titleMedium)
            if (row.detail.isNotBlank()) Text(row.detail, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            FlowRow(horizontalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                row.url?.let { url -> TextButton(onClick = { openLink(context, url) }) { Text("Open link ↗") } }
                TextButton(onClick = move, modifier = Modifier.testTag("reassign-${row.id}")) { Text("Belongs to someone else…") }
            }
        }
    }
}
