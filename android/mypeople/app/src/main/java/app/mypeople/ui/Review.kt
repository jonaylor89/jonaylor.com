package app.mypeople.ui

import app.mypeople.ui.icons.*

import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material.icons.Icons
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.serialization.json.*
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun ReviewScreen(records: Records, graph: AppGraph, scrollToTopRequest: Long = 0, loading: Boolean = false, openSettings: () -> Unit = {}, openPerson: (Int) -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val context = LocalContext.current
    val profiles = remember(records) { records.suggestedProfiles() }
    // What was already shown is read once per visit, so "New" doesn't vanish while you look.
    val seen = remember { graph.settings.seenDuplicates }
    val unordered = remember(records) { records.duplicateGroups() }
    val groups = remember(unordered, seen) { unordered.sortedBy { duplicateRank(it.key, seen) } }
    val latest by rememberUpdatedState(unordered)
    DisposableEffect(Unit) { onDispose { graph.settings.seenDuplicates = seen.orEmpty() + latest.map { it.key } } }
    val fresh = groups.count { duplicateRank(it.key, seen) < 2 }
    val versions = remember(records) { records.people.entries.filter { it.value.contact_conflicts.isNotEmpty() }.sortedBy { it.value.name.lowercase() } }
    val mergeDecisions = versions.count { it.value.mergeDecisionConflicts().isNotEmpty() }
    val valueConflicts = versions.count { entry -> entry.value.contact_conflicts.any { (field, choices) -> !isMergeDecisionConflict(field, choices) } }
    val versionsList = rememberLazyListState()
    val profilesList = rememberLazyListState()
    val duplicatesList = rememberLazyListState()
    val list = when (tab) { 0 -> profilesList; 1 -> duplicatesList; else -> versionsList }
    OnScrollToTopRequest(scrollToTopRequest) { list.scrollToItem(0) }
    key(tab) {
        LazyColumn(state = list, modifier = Modifier.testTag("review-list"), contentPadding = PaddingValues(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
            item { Heading("A second look", "Good memory starts with getting people right.", onAccount = openSettings) }
            stickyHeader {
                Surface(color = MaterialTheme.colorScheme.surface) {
                    Box(Modifier.padding(vertical = 8.dp)) { JournalTabs(tab, listOf("Profiles", "Duplicates", if (versions.isEmpty()) "Decisions" else "Decisions (${versions.size})")) { tab = it } }
                }
            }
            item {
                Column(Modifier.padding(horizontal = KinSpace.s4, vertical = 8.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                    Text(if (tab == 2) "$mergeDecisions earlier separation decisions · $valueConflicts contacts with conflicting values" else if (tab == 0) "${profiles.size} suggested profiles" else "${groups.size} groups to review" + if (fresh > 0) " · $fresh new" else "", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    Text(if (tab == 2) "Review merge decisions or independently edited details here. Nothing is chosen for you, and previous values stay in history." else if (tab == 0) "A suggestion is never a confirmed identity. Even a supported assessment needs your confirmation." else "Compare the details before combining records. Similar names don’t always mean the same person.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
            }
            if (tab == 0) {
                if (loading) item { SavedRowsPlaceholder() }
                else if (profiles.isEmpty()) item { EmptyState("All caught up", "Suggested public profiles will appear here for your review.") }
                items(profiles, key = { it.key }) { (id, profile) ->
                    JournalCard(Modifier.padding(horizontal = KinSpace.s4)) {
                        PersonRow(records.people.getValue(profile.person_id), graph, "${profile.site} · Suggested") { openPerson(profile.person_id) }
                        HorizontalDivider(Modifier.padding(horizontal = 20.dp), color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = .5f))
                        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                            if (profile.title.isNotBlank()) Text(profile.title, style = MaterialTheme.typography.titleLarge)
                            TextButton(onClick = { openLink(context, profile.url) }, contentPadding = PaddingValues(0.dp)) {
                                Text(profile.url, Modifier.weight(1f), style = MaterialTheme.typography.bodyMedium, maxLines = 3, overflow = TextOverflow.Ellipsis)
                                Spacer(Modifier.width(12.dp)); Icon(Icons.Outlined.OpenInNew, null, Modifier.size(18.dp))
                            }
                            MetaLabel("Assessment · ${profile.assessment}")
                            Text(profile.reason, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                fun status(value: String) = graph.edit("profile_status", buildJsonObject { put("profile_id", id.toIntOrNull()?.let(::JsonPrimitive) ?: JsonPrimitive(id)); put("status", value) })
                                FilledTonalButton(onClick = { status("confirmed") }) { Text("Confirm identity") }
                                TextButton(onClick = { status("rejected") }) { Text("Reject") }
                            }
                        }
                    }
                }
            } else if (tab == 2) {
                if (loading) item { SavedRowsPlaceholder() }
                else if (versions.isEmpty()) item { EmptyState("Nothing to reconcile", "Your devices agree. Edits to the same detail on two devices will appear here.") }
                items(versions, key = { it.key }) { (id, person) ->
                    JournalCard(Modifier.padding(horizontal = KinSpace.s4)) {
                        PersonRow(person, graph, person.contactConflictSummary()) { openPerson(id) }
                        if (person.mergeDecisionConflicts().isNotEmpty()) Box(Modifier.padding(KinSpace.s4)) { MergeDecisionPrompt(person, graph) }
                    }
                }
            } else {
                if (loading) item { SavedRowsPlaceholder() }
                else if (groups.isEmpty()) item { EmptyState("No duplicates to review", "People with potentially overlapping identities will appear side by side here.") }
                items(groups, key = { it.key }) { (key, group) ->
                    val badge = when (duplicateRank(key, seen)) { 0 -> "From changes on this phone"; 1 -> "New since you last looked"; else -> null }
                    Box(Modifier.padding(horizontal = KinSpace.s4)) { DuplicateGroup(key, group, records, graph, openPerson, badge) }
                }
            }
        }
    }
}

@Composable
private fun DuplicateGroup(key: String, group: Dupes, records: Records, graph: AppGraph, openPerson: (Int) -> Unit, badge: String? = null) {
    var selected by rememberSaveable(key, group.person_ids) { mutableStateOf(emptyList<Int>()) }
    var confirm by remember { mutableStateOf<List<Int>?>(null) }
    var merging by remember { mutableStateOf(false) }
    var mergeError by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val ids = group.person_ids.filter { it in records.people }
    JournalCard {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            badge?.let { MetaLabel(it) }
            Text("One person, or different people?", style = MaterialTheme.typography.titleLarge)
            Text("Swipe to compare · select records to combine", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                ids.forEach { id ->
                    val person = records.people.getValue(id)
                    Surface(Modifier.width(248.dp), shape = MaterialTheme.shapes.medium, color = if (id in selected) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surfaceContainer) {
                        Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(10.dp)) {
                            Row(verticalAlignment = Alignment.CenterVertically) {
                                Avatar(person, graph)
                                Spacer(Modifier.weight(1f))
                                Checkbox(id in selected, { checked -> selected = if (checked) selected + id else selected - id }, modifier = Modifier.semantics { contentDescription = "Select ${person.name}" })
                            }
                            TextButton(onClick = { openPerson(id) }, contentPadding = PaddingValues(0.dp)) { Text(person.name, style = MaterialTheme.typography.titleMedium) }
                            Text("Record #$id", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                            person.contactFields().forEach { Text(if (it.kind == "phone") formatPhone(it.value) else "${it.value} (${it.kind})", style = MaterialTheme.typography.bodySmall) }
                            Text(person.channels.joinToString(" · ") { "${it.channel} ${it.count}" }.ifEmpty { "No conversations" }, style = MaterialTheme.typography.bodySmall)
                            Text("First · ${formatDate(person.first_contact?.take(10))}\nLast · ${formatDate(person.last_contact?.take(10))}", style = MaterialTheme.typography.bodySmall)
                            currentProfile(records.eventsFor(id).values)["job"]?.let { Text(it.value, style = MaterialTheme.typography.bodyMedium) }
                        }
                    }
                }
            }
            group.clues.forEach { Text("• $it", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
            FilledTonalButton(enabled = selected.size >= 2, onClick = { mergeError = null; confirm = selected }, modifier = Modifier.fillMaxWidth()) { Text("Merge selected (${selected.size})") }
            OutlinedButton(onClick = { mergeError = null; confirm = ids }, modifier = Modifier.fillMaxWidth()) { Text("Merge all ${ids.size} records") }
            TextButton(onClick = { graph.edit("distinct", buildJsonObject {
                putJsonArray("person_ids") { ids.forEach { add(it) } }
                // People created on this phone have no Mac id yet; the Mac finds them by contact.
                putJsonArray("contact_uids") { ids.forEach { add(records.people[it]?.contact_uid.orEmpty()) } }
            }) }, modifier = Modifier.fillMaxWidth()) { Text("Not the same person") }
        }
    }
    confirm?.let { chosen ->
        AlertDialog(onDismissRequest = { if (!merging) confirm = null }, title = { Text("Merge ${chosen.size} people?") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    Text("Their facts, identifiers and history will be combined on your Mac. The record with the most conversation history is kept. You can request undo from the kept person’s page, provided those records have not changed since merging.")
                    if (merging) LinearProgressIndicator(Modifier.fillMaxWidth())
                    mergeError?.let { Text(it, color = MaterialTheme.colorScheme.error) }
                }
            },
            confirmButton = { TextButton(enabled = !merging, onClick = {
                scope.launch {
                    merging = true; mergeError = null
                    try {
                        graph.submitEdit("merge", buildJsonObject { putJsonArray("person_ids") { chosen.forEach { add(it) } } })
                        confirm = null
                    } catch (e: CancellationException) { throw e }
                    catch (e: Exception) { mergeError = graph.editError(e) }
                    finally { merging = false }
                }
            }) { Text(if (merging) "Preparing…" else "Merge") } },
            dismissButton = { TextButton(enabled = !merging, onClick = { confirm = null }) { Text("Cancel") } })
    }
}

/** Groups found on this phone first, then ones not shown before, then the rest in the Mac's order. */
private fun duplicateRank(key: String, seen: Set<String>?): Int = when {
    key.startsWith(LOCAL_DUPES_PREFIX) -> 0
    seen != null && key !in seen -> 1
    else -> 2
}

/** Merge this contact with any other, for duplicates the review didn't suggest. */
@Composable
internal fun MergeWithDialog(id: Int, records: Records, graph: AppGraph, onClose: () -> Unit, onMerged: () -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var chosen by remember { mutableStateOf<Int?>(null) }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
    val matches = remember(records, query) {
        records.people.entries.filter { it.key != id && !it.value.trashed && query.isNotBlank() && it.value.name.contains(query.trim(), ignoreCase = true) }
            .sortedBy { it.value.name.lowercase() }.take(30)
    }
    AlertDialog(onDismissRequest = { if (!busy) onClose() }, title = { Text("Merge ${records.people[id]?.name.orEmpty()} with…") }, text = {
        Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
            OutlinedTextField(query, { query = it; chosen = null }, label = { Text("Search people") }, singleLine = true, modifier = Modifier.fillMaxWidth().testTag("merge-search"))
            LazyColumn(Modifier.heightIn(max = 280.dp)) {
                items(matches, key = { it.key }) { (other, person) ->
                    Surface(onClick = { chosen = other }, modifier = Modifier.fillMaxWidth(), shape = MaterialTheme.shapes.medium,
                        color = if (chosen == other) MaterialTheme.colorScheme.secondaryContainer else MaterialTheme.colorScheme.surface) {
                        Text(person.name, Modifier.padding(12.dp), style = MaterialTheme.typography.bodyLarge)
                    }
                }
            }
            Text("Their details, notes and facts are combined, and your other devices follow when they sync.", style = MaterialTheme.typography.bodySmall)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error) }
        }
    }, confirmButton = {
        TextButton(enabled = chosen != null && !busy, onClick = {
            val other = chosen ?: return@TextButton
            scope.launch {
                busy = true; error = null
                try {
                    graph.submitEdit("merge", buildJsonObject { putJsonArray("person_ids") { add(id); add(other) } })
                    onMerged()
                } catch (e: CancellationException) { throw e }
                catch (e: Exception) { error = graph.editError(e) }
                finally { busy = false }
            }
        }) { Text(if (busy) "Merging…" else "Merge") }
    }, dismissButton = { TextButton(enabled = !busy, onClick = onClose) { Text("Cancel") } })
}
