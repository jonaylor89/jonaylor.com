package app.mypeople.ui

import app.mypeople.ui.icons.*

import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import app.mypeople.ui.icons.Symbols
import android.widget.Toast
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import kotlinx.coroutines.launch
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.serialization.json.*
import kotlin.math.roundToInt

@OptIn(ExperimentalMaterial3Api::class, ExperimentalFoundationApi::class)
@Composable
fun PersonScreen(routeId: Int?, state: StoreState, graph: AppGraph, onBack: () -> Unit) {
    val records = state.records
    var rememberedUid by rememberSaveable(routeId) { mutableStateOf(records.people[routeId]?.contact_uid.orEmpty()) }
    if (rememberedUid.isEmpty() && records.people[routeId]?.contact_uid?.isNotEmpty() == true) rememberedUid = records.people[routeId]!!.contact_uid
    val id = if (rememberedUid.isNotEmpty()) records.people.entries.firstOrNull { it.value.contact_uid == rememberedUid || rememberedUid in it.value.contact_aliases }?.key else routeId?.takeIf { it in records.people }
    val person = records.people[id]
    var editContact by rememberSaveable(routeId) { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    var dialog by rememberSaveable(id) { mutableStateOf<String?>(null) }
    var evidence by remember { mutableStateOf<Event?>(null) }
    var evidenceKey by remember { mutableStateOf<String?>(null) }
    var forget by remember { mutableStateOf<String?>(null) }
    val scope = rememberCoroutineScope()
    val context = LocalContext.current
    val list = rememberLazyListState()
    val collapsed by remember { derivedStateOf { list.firstVisibleItemIndex > 0 } }
    // The whole screen wears this person's palette.
    CompositionLocalProvider(LocalPersonPalette provides person?.let { personPalette(it.paletteSeed()) }) {
    Column {
        TopAppBar(windowInsets = WindowInsets(0, 0, 0, 0), colors = TopAppBarDefaults.topAppBarColors(containerColor = MaterialTheme.colorScheme.surface), title = {
            // The hero collapses into the top bar once it scrolls away.
            AnimatedVisibility(collapsed && person != null, enter = fadeIn(KinMotion.effects()), exit = fadeOut(KinMotion.effects())) {
                Text(person?.name.orEmpty(), style = MaterialTheme.typography.titleLarge, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
        }, navigationIcon = {
            IconButton(onClick = onBack) { Icon(Symbols.ArrowBack, "Back") }
        }, actions = {
            if (person != null && id != null) {
                val favorite = person.card?.favorite == true
                IconButton(onClick = { scope.launch { runCatching { graph.saveContact(person.contactCard().copy(favorite = !favorite), id, person.contact_uid, expectedPerson = person) }.onFailure { Toast.makeText(context, "Could not save favorite", Toast.LENGTH_SHORT).show() } } }) {
                    Icon(if (favorite) Symbols.StarFilled else Symbols.Star, if (favorite) "Remove from favorites" else "Add to favorites", tint = if (favorite) LocalPersonPalette.current?.accent ?: LocalContentColor.current else LocalContentColor.current)
                }
                IconButton(onClick = { editContact = true }) { Icon(Symbols.Edit, "Edit contact") }
                Box {
                    IconButton(onClick = { menu = true }) { Icon(Symbols.MoreVert, "More options") }
                    DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                        listOf("Rename", "Nicknames", "Add fact", "Add note", "Relationship settings").forEach { label ->
                            DropdownMenuItem(text = { Text(label) }, onClick = { menu = false; dialog = label })
                        }
                        HorizontalDivider()
                        listOf("extract" to "Read new messages", "find_profiles" to "Find profiles", "photos" to "Refresh photos").forEach { (kind, label) ->
                            val pending = state.pending.any { it.kind == kind && (kind == "photos" || it.payload.int("person_id") == id) }
                            DropdownMenuItem(enabled = !pending, text = { Text(if (pending) "$label · Requested" else label) }, onClick = {
                                menu = false
                                graph.edit(kind, buildJsonObject { put("person_id", id) })
                            })
                        }
                    }
                }
            }
        })
        if (person == null || id == null) {
            EmptyState("Person unavailable", "They may have been merged or removed. Go back to your people.", "Back to people", onBack)
            return@Column
        }
        val events = remember(records, id) { records.eventsFor(id).entries.toList() }
        val profile = remember(events) { currentProfile(events.map { it.value }) }
        LazyColumn(state = list, contentPadding = PaddingValues(start = KinSpace.s4, end = KinSpace.s4, bottom = KinSpace.s8)) {
            item { ContactHero(person, profile, graph) }
            item { Box(Modifier.padding(top = KinSpace.s4)) { ContactActions(person, edit = { editContact = true }) } }
            item {
                FlowRow(Modifier.padding(top = KinSpace.s3), horizontalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                    FilledTonalButton(onClick = { dialog = "Add note" }) { Icon(Icons.Outlined.EditNote, null, Modifier.size(18.dp)); Spacer(Modifier.width(KinSpace.s2)); Text("Add a note") }
                    OutlinedButton(onClick = { dialog = "Add fact" }) { Icon(Icons.Outlined.Add, null, Modifier.size(18.dp)); Spacer(Modifier.width(KinSpace.s2)); Text("Add fact") }
                }
            }
            item { ContactDetails(person, id, graph, edit = { editContact = true }) }
            item { Section("Your relationship") }
            item {
                JournalCard {
                    Column(Modifier.padding(KinSpace.s5), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(KinSpace.s2), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                            MetaLabel(person.category.replaceFirstChar { it.uppercase() })
                            if (person.muted) MetaLabel("Nudges muted")
                        }
                        Text("Closeness · ${(person.closeness * 100).roundToInt()}%", style = MaterialTheme.typography.labelLarge)
                        LinearProgressIndicator(progress = { person.closeness.toFloat().coerceIn(0f, 1f) }, modifier = Modifier.fillMaxWidth(), color = LocalPersonPalette.current?.accent ?: MaterialTheme.colorScheme.primary, trackColor = MaterialTheme.colorScheme.surfaceContainerHigh)
                        Text(person.cadence_days?.let { "Usually talk every ~${it.roundToInt()} days" } ?: "Still learning your rhythm", style = MaterialTheme.typography.bodyMedium)
                        Text("Last contact · ${formatDate(person.last_contact?.take(10))}\nTrend · ${person.trend}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        if (person.channels.isNotEmpty()) Text(person.channels.joinToString(" · ") { "${it.channel} ${it.count}" }, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        TextButton(onClick = { dialog = "Relationship settings" }, contentPadding = PaddingValues(0.dp)) { Text("Adjust your rhythm") }
                    }
                }
            }
            val links = records.profiles.values.filter { it.person_id == id && it.status == "confirmed" }
            if (links.isNotEmpty()) {
                item { Section("Around the web") }
                itemsIndexed(links, key = { _, link -> link.url }) { index, link ->
                    Surface(onClick = { openLink(context, link.url) }, modifier = Modifier.fillMaxWidth().padding(bottom = KinSpace.half), shape = segmentShape(index, links.size), color = journalSurfaceColor()) {
                        Column(Modifier.padding(KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s1)) {
                            Text(link.site, style = MaterialTheme.typography.titleMedium)
                            Text(link.url, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.primary)
                            Text("Confirmed by you", style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            item {
                Section("The story so far")
                Text("Every fact has a source. Tap to look closer.", Modifier.padding(bottom = KinSpace.s3), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            if (events.isEmpty()) item {
                Text("No facts yet. Add one above, or ask your Mac to read new messages below.", Modifier.padding(vertical = KinSpace.s4), style = MaterialTheme.typography.bodyMedium)
            }
            itemsIndexed(events, key = { _, entry -> entry.key }) { index, (eventId, event) ->
                Surface(Modifier.padding(bottom = KinSpace.half), shape = segmentShape(index, events.size), color = journalSurfaceColor()) {
                    Column(Modifier.fillMaxWidth().combinedClickable(onClickLabel = "View evidence", onLongClickLabel = "Forget fact", onClick = { evidenceKey = eventId; evidence = event }, onLongClick = { if (!eventId.startsWith("-")) forget = eventId }).padding(KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                        Text(formatDate(event.date), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        Text(event.value, style = MaterialTheme.typography.bodyLarge)
                        Row(horizontalArrangement = Arrangement.spacedBy(KinSpace.s2), verticalAlignment = Alignment.CenterVertically) {
                            Icon(Icons.Outlined.FormatQuote, null, Modifier.size(16.dp), tint = LocalPersonPalette.current?.accent ?: MaterialTheme.colorScheme.onSurfaceVariant)
                            Text("${event.type} · ${event.source}${if (eventId.startsWith("-")) " · Waiting for your Mac" else ""}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                }
            }
            item {
                Section("Tend to this memory")
                Text("Your Mac does the reading. This phone only requests it.", Modifier.padding(bottom = KinSpace.s3), style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            items(listOf("extract" to "Read new messages", "find_profiles" to "Find profiles", "photos" to "Refresh photos")) { (kind, label) ->
                val pending = state.pending.any { it.kind == kind && (kind == "photos" || it.payload.int("person_id") == id) }
                OutlinedButton(modifier = Modifier.fillMaxWidth().padding(bottom = KinSpace.s2), enabled = !pending, onClick = { graph.edit(kind, buildJsonObject { put("person_id", id) }) }) {
                    Text(if (pending) "$label\nRequested · waiting for your Mac" else label)
                }
            }
        }
        if (editContact) ContactEditor(graph, id, person.contactCard(), close = { editContact = false })
        dialog?.let { mode -> PersonEditor(mode, id, person, graph) { dialog = null } }
        evidence?.let { event ->
            AlertDialog(onDismissRequest = { evidence = null }, icon = { Icon(Icons.Outlined.FormatQuote, null) }, title = { Text("Behind this fact") }, text = {
                Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Text(event.value, style = MaterialTheme.typography.bodyLarge)
                    Surface(shape = MaterialTheme.shapes.medium, color = MaterialTheme.colorScheme.secondaryContainer) {
                        Text(event.evidence?.takeIf { it.isNotBlank() }?.let { "“$it”" } ?: "No evidence quote was published for this fact.", Modifier.padding(16.dp), style = MaterialTheme.typography.bodyMedium)
                    }
                    Text("${event.source} · said on ${formatDate(event.said_at?.take(10))}", style = MaterialTheme.typography.bodySmall)
                }
            }, confirmButton = { TextButton(onClick = { evidence = null }) { Text("Close") } }, dismissButton = {
                if (evidenceKey?.startsWith("-") == false) TextButton(onClick = { forget = evidenceKey; evidence = null }) { Text("Forget fact", color = MaterialTheme.colorScheme.error) }
            })
        }
        forget?.let { eventId ->
            AlertDialog(onDismissRequest = { forget = null }, title = { Text("Forget this fact?") }, text = { Text("It will be marked as wrong when your Mac next syncs.") },
                confirmButton = { TextButton(onClick = { graph.edit("event_forget", buildJsonObject { put("event_id", eventId.toInt()) }); forget = null }) { Text("Forget", color = MaterialTheme.colorScheme.error) } },
                dismissButton = { TextButton(onClick = { forget = null }) { Text("Cancel") } })
        }
    }
    }
}

/**
 * The top of a person's screen: their avatar, their name as display type, one meta line and
 * up to three chips, on their wash. Actions live below it, never inside.
 */
@Composable
private fun ContactHero(person: Person, profile: Map<String, Event>, graph: AppGraph) {
    val palette = LocalPersonPalette.current
    val fontScale = LocalDensity.current.fontScale
    // The palette blooms in on first open.
    var bloomed by remember { mutableStateOf(false) }
    LaunchedEffect(Unit) { bloomed = true }
    val wash by animateColorAsState(if (bloomed) palette?.wash ?: MaterialTheme.colorScheme.surfaceContainerLow else MaterialTheme.colorScheme.surface, KinMotion.spatialSlow(), label = "bloom")
    val card = person.contactCard()
    val meta = card.phonetic.ifBlank { null } ?: person.aliases.takeIf { it.isNotEmpty() }?.joinToString(" · ")
        ?: listOf(card.title, card.organization).filter { it.isNotBlank() }.joinToString(" · ").ifBlank { null } ?: profile["job"]?.value
    var wraps by remember(person.name) { mutableStateOf(false) }
    val nameStyle = when {
        fontScale > 1.5f -> MaterialTheme.typography.headlineLarge
        wraps -> MaterialTheme.typography.displaySmall
        else -> MaterialTheme.typography.displayMedium
    }
    Surface(Modifier.fillMaxWidth(), shape = RoundedCornerShape(KinRadius.xxl), color = wash) {
        Column(Modifier.padding(start = KinSpace.s6, end = KinSpace.s6, top = KinSpace.s8, bottom = KinSpace.s6), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(KinSpace.s4)) {
            Avatar(person, graph, if (fontScale > 1.5f) KinSize.avatarLg else KinSize.avatarXl)
            Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(KinSpace.s1)) {
                Text(person.name, Modifier.semantics { heading() }, style = nameStyle, textAlign = TextAlign.Center, onTextLayout = { if (!wraps && it.lineCount > 1) wraps = true })
                if (meta != null) Text(meta, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant, textAlign = TextAlign.Center)
            }
            val chips = listOfNotNull(
                person.category.takeIf { it != "unknown" }?.replaceFirstChar { it.uppercase() },
                "Favorite".takeIf { card.favorite },
                "Nudges muted".takeIf { person.muted },
            ).take(3)
            if (chips.isNotEmpty()) FlowRow(horizontalArrangement = Arrangement.spacedBy(KinSpace.s2, Alignment.CenterHorizontally)) { chips.forEach { MetaLabel(it) } }
        }
    }
}
