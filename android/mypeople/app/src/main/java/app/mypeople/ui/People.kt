package app.mypeople.ui

import app.mypeople.ui.icons.*
import android.content.Intent
import android.net.Uri
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyRow
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.receiveAsFlow
import java.text.NumberFormat

@Composable
fun PeopleScreen(records: Records, graph: AppGraph, scrollToTopRequest: Long = 0, loading: Boolean = false, canEdit: Boolean = true, openSettings: () -> Unit = {}, openPerson: (Int) -> Unit) {
    var query by rememberSaveable { mutableStateOf("") }
    var sort by rememberSaveable { mutableStateOf("name") }
    var create by rememberSaveable { mutableStateOf(false) }
    var chooseLetter by rememberSaveable { mutableStateOf(false) }
    var preview by remember { mutableStateOf<Char?>(null) }
    val results = remember(records, query, sort) { records.searchPeople(query, sort) }
    val alphabetical = sort != "closeness"
    val sections = remember(results, alphabetical) { records.sections(query, sort, results) }
    val sectionStarts = remember(sections) { sections.associateBy { it.firstIndex } }
    // Each row's place in its section card, for the segmented corners.
    val sectionOf = remember(sections, results) {
        val owner = IntArray(results.size); sections.forEachIndexed { s, section -> for (i in section.firstIndex until section.firstIndex + section.count) owner[i] = s }; owner
    }
    val favorites = remember(records) { records.favorites() }
    val showFavorites = query.isEmpty() && sort == "name" && favorites.isNotEmpty() && !loading
    // The favorites row sits above the first result.
    val offset = if (showFavorites) 1 else 0
    val list = rememberLazyListState()
    val jumps = remember { Channel<Int>(Channel.CONFLATED) }
    val count by rememberUpdatedState(results.size)
    val rowOffset by rememberUpdatedState(offset)
    val keyboard = LocalSoftwareKeyboardController.current
    val focus = LocalFocusManager.current
    val context = LocalContext.current
    val number = remember { NumberFormat.getIntegerInstance() }
    val profileByPerson = remember(records) { records.profileByPerson() }
    val firstVisible by remember { derivedStateOf { (list.firstVisibleItemIndex - rowOffset).coerceAtLeast(0) } }
    val lastVisible by remember { derivedStateOf { ((list.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: 0) - rowOffset).coerceAtLeast(0) } }
    val currentLetter = results.getOrNull(firstVisible)?.let { contactLetter(it.value.name) }
    val hasRail = sections.size > 1
    val largeText = LocalDensity.current.fontScale > 1.3f
    val previewSize = 64.dp * LocalDensity.current.fontScale.coerceIn(1f, 2f)
    var fabExpanded by remember { mutableStateOf(true) }
    LaunchedEffect(list) {
        var previous = 0 to 0
        snapshotFlow { list.firstVisibleItemIndex to list.firstVisibleItemScrollOffset }.collect { current ->
            fabExpanded = current.first < previous.first || (current.first == previous.first && current.second <= previous.second) || current == (0 to 0)
            previous = current
        }
    }
    fun jump(index: Int) {
        keyboard?.hide(); focus.clearFocus()
        jumps.trySend(index)
    }
    LaunchedEffect(list) {
        jumps.receiveAsFlow().collectLatest { index -> if (count > 0) list.scrollToItem(index.coerceIn(0, count - 1) + rowOffset) }
    }
    OnScrollToTopRequest(scrollToTopRequest) { keyboard?.hide(); focus.clearFocus(); list.scrollToItem(0) }
    // Reset on an actual filter change, not on a normal tab return or configuration change.
    val filter = "$sort:$query"
    var previousFilter by rememberSaveable { mutableStateOf(filter) }
    LaunchedEffect(filter) {
        if (filter != previousFilter) { previousFilter = filter; list.scrollToItem(0) }
    }
    if (create) ContactEditor(graph, close = { create = false }, saved = openPerson)
    if (chooseLetter) PeopleLetterChooser(sections, jump = { jump(it.firstIndex) }, close = { chooseLetter = false })

    Box(Modifier.fillMaxSize()) {
        Column(Modifier.fillMaxSize()) {
            // The search bar is the title: it never scrolls away.
            KinSearchBar(query, { query = it }, scrolled = list.canScrollBackward, modifier = Modifier.padding(horizontal = KinSpace.s4).padding(top = KinSpace.s2, bottom = KinSpace.s2), onAccount = openSettings)
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(horizontal = KinSpace.s4), horizontalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                listOf("name" to "A–Z", "favorites" to "Favorites", "closeness" to "Closest", "trash" to "Trash").forEach { (value, label) ->
                    FilterChip(selected = sort == value, onClick = { sort = value }, label = { Text(label) }, shape = RoundedCornerShape(KinRadius.sm),
                        leadingIcon = if (sort == value) { { Icon(Symbols.Check, null, Modifier.size(18.dp)) } } else null,
                        colors = FilterChipDefaults.filterChipColors(selectedContainerColor = MaterialTheme.colorScheme.secondaryContainer, selectedLabelColor = MaterialTheme.colorScheme.onSecondaryContainer, selectedLeadingIconColor = MaterialTheme.colorScheme.onSecondaryContainer))
                }
            }
            Row(Modifier.fillMaxWidth().padding(start = KinSpace.s4, end = KinSpace.s1), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s1)) {
                val range = if (results.isEmpty()) "No results" else "${number.format(firstVisible.coerceAtMost(results.lastIndex) + 1)}–${number.format((lastVisible + 1).coerceAtMost(results.size))} of ${number.format(results.size)}"
                Text(when {
                    sort == "trash" -> "${number.format(results.size)} in trash"
                    largeText && results.isNotEmpty() -> "${((lastVisible + 1).coerceAtMost(results.size) * 100L / results.size)}%"
                    else -> range
                }, Modifier.weight(1f).semantics { contentDescription = range }, maxLines = 1, overflow = TextOverflow.Ellipsis, style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                if (hasRail) TextButton(onClick = { chooseLetter = true }, modifier = Modifier.semantics { contentDescription = "Choose a letter" }) { Text("A–Z") }
                IconButton(enabled = results.isNotEmpty() && list.canScrollBackward, onClick = { jump(0) }) { EdgeJumpIcon(toBottom = false) }
                IconButton(enabled = results.isNotEmpty() && list.canScrollForward, onClick = { jump(results.lastIndex) }) { EdgeJumpIcon(toBottom = true) }
            }
            Box(Modifier.weight(1f).fillMaxWidth()) {
                Row(Modifier.fillMaxSize()) {
                    LazyColumn(state = list, modifier = Modifier.weight(1f).fillMaxHeight().testTag("people-list"), contentPadding = PaddingValues(start = KinSpace.s4, end = if (hasRail) 0.dp else KinSpace.s4, top = KinSpace.s1, bottom = 96.dp)) {
                        if (showFavorites) item(key = "favorites") { FavoritesRow(favorites, graph, openPerson) }
                        if (loading) item(key = "reading-local-contacts") { SavedRowsPlaceholder() }
                        else if (results.isEmpty()) item(key = "empty") { EmptyState("No one found", if (records.people.isEmpty()) "Create someone below, or import your address book in Settings." else "Try another name, number or email.") }
                        itemsIndexed(results, key = { _, entry -> entry.key }, contentType = { _, _ -> "person" }) { index, (id, person) ->
                            Column {
                                sectionStarts[index]?.let { section ->
                                    SectionHeader(if (section.letter == '#') "#" else section.letter.toString(), number.format(section.count), modifier = Modifier.semantics { contentDescription = if (section.letter == '#') "Numbers & symbols" else "Section ${section.letter}" })
                                }
                                val section = sections.getOrNull(sectionOf.getOrElse(index) { 0 })
                                val shape = if (section != null) segmentShape(index - section.firstIndex, section.count) else segmentShape(index, results.size)
                                val profile = profileByPerson[id].orEmpty()
                                val detail = profile["job"]?.value ?: profile["move"]?.value ?: person.contactFields().firstOrNull()?.value
                                Surface(Modifier.fillMaxWidth().padding(bottom = KinSpace.half), shape = shape, color = journalSurfaceColor()) {
                                    PersonRow(person, graph, detail?.takeIf { it.isNotBlank() && it != person.name }, trailing = remember(person) { quickCall(person, context) }) { openPerson(id) }
                                }
                            }
                        }
                    }
                    if (hasRail) PeopleFastScroll(sections, preview ?: currentLetter, onJump = { jump(it.firstIndex) }, onPreview = { preview = it }, modifier = Modifier.fillMaxHeight().padding(bottom = 80.dp))
                }
                // The scrub bubble wears the cookie, offset from the thumb.
                androidx.compose.animation.AnimatedVisibility(visible = preview != null, modifier = Modifier.align(Alignment.CenterEnd).padding(end = 64.dp), enter = fadeIn(KinMotion.effects()) + scaleIn(KinMotion.spatialFast()), exit = fadeOut(KinMotion.effects()) + scaleOut(KinMotion.spatialFast())) {
                    Box(Modifier.size(previewSize).shadow(KinElevation.level2, cookieShape()).background(MaterialTheme.colorScheme.secondaryContainer, cookieShape()), contentAlignment = Alignment.Center) {
                        Text(preview?.toString().orEmpty(), style = MaterialTheme.typography.displaySmall, color = MaterialTheme.colorScheme.onSecondaryContainer)
                    }
                }
            }
        }
        Box(Modifier.align(Alignment.BottomEnd).padding(KinSpace.s4)) {
            KinFab("Create contact", Symbols.PersonAdd, expanded = fabExpanded, enabled = canEdit && !loading) { create = true }
        }
    }
}

/** A one-tap call when the person has a number we can dial safely; hidden otherwise. */
private fun quickCall(person: Person, context: android.content.Context): (@Composable () -> Unit)? {
    val card = person.contactCard()
    val phone = card.fields.filter { it.kind == "phone" }.sortedByDescending { it.preferred }.firstOrNull() ?: return null
    if (!card.canNormalizePhone(phone)) return null
    val target = phoneCallTarget(phone.value, phone.region.ifEmpty { card.region }) ?: return null
    return {
        IconButton(onClick = { openIntent(context, Intent.ACTION_DIAL, Uri.fromParts("tel", target, null)) }) {
            Icon(Symbols.Call, "Call ${person.name}", tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

/** Favorites: one horizontally scrolling row of first names, each in their own colour. */
@Composable
private fun FavoritesRow(favorites: List<Map.Entry<Int, Person>>, graph: AppGraph, openPerson: (Int) -> Unit) {
    Column(Modifier.fillMaxWidth().padding(bottom = KinSpace.s2)) {
        SectionHeader("Favorites")
        LazyRow(horizontalArrangement = Arrangement.spacedBy(KinSpace.s2), contentPadding = PaddingValues(end = KinSpace.s4)) {
            items(favorites, key = { it.key }) { (id, person) ->
                val palette = personPalette(person.paletteSeed())
                Surface(onClick = { openPerson(id) }, modifier = Modifier.width(96.dp).semantics { contentDescription = "Favorite: ${person.name}" }, shape = RoundedCornerShape(KinRadius.lgPlus), color = palette.wash) {
                    Column(Modifier.padding(horizontal = KinSpace.s2, vertical = KinSpace.s3), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                        Avatar(person, graph, KinSize.avatarMd, AvatarShape.Cookie)
                        Text(person.card?.given?.ifBlank { null } ?: person.name.substringBefore(' '), style = MaterialTheme.typography.titleSmall, textAlign = TextAlign.Center, maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                }
            }
        }
    }
}
