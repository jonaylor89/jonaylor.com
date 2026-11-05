package app.mypeople.ui

import app.mypeople.ui.icons.*

import androidx.compose.foundation.clickable
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.*
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import androidx.compose.ui.platform.LocalLocale

@Composable
fun HomeScreen(records: Records, graph: AppGraph, scrollToTopRequest: Long = 0, openPeople: () -> Unit = {}, openSettings: () -> Unit = {}, loading: Boolean = false, openPerson: (Int) -> Unit) {
    var tab by rememberSaveable { mutableIntStateOf(0) }
    val today = LocalDate.now()
    val largeText = LocalDensity.current.fontScale > 1.3f
    val locale = LocalLocale.current.platformLocale
    val moments = remember(records, today) { records.moments(today) }
    val upcoming = remember(records, today) { records.upcomingSoon(today) }
    val recent = remember(records) { records.recentlyInTouch() }
    val todayList = rememberLazyListState()
    val upcomingList = rememberLazyListState()
    val list = if (tab == 0) todayList else upcomingList
    OnScrollToTopRequest(scrollToTopRequest) { list.scrollToItem(0) }
    // One scrolling canvas keeps the page usable at large font sizes, too.
    key(tab) {
        LazyColumn(state = list, modifier = Modifier.testTag("home-list"), contentPadding = PaddingValues(bottom = 28.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
            item { Heading("Keep people close.", "A little memory. A reason to reach out.", onAccount = openSettings) }
            stickyHeader {
                Surface(color = MaterialTheme.colorScheme.surface) {
                    Box(Modifier.padding(vertical = 8.dp)) { JournalTabs(tab, listOf("Today", "Upcoming")) { tab = it } }
                }
            }
            if (loading) item { SavedRowsPlaceholder() }
            else when (tab) {
                0 -> {
                    item {
                        Surface(Modifier.fillMaxWidth().padding(horizontal = KinSpace.s4, vertical = KinSpace.s2), shape = RoundedCornerShape(KinRadius.xl), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                            Column(Modifier.padding(KinSpace.s5), verticalArrangement = Arrangement.spacedBy(KinSpace.s4)) {
                                Text(today.format(DateTimeFormatter.ofPattern("EEEE · MMMM yyyy", locale)), style = MaterialTheme.typography.labelMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                                if (largeText) {
                                    Text(today.dayOfMonth.toString(), style = MaterialTheme.typography.displaySmall)
                                    Text("Small moments. Lasting connections.", style = MaterialTheme.typography.titleLarge)
                                } else Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(KinSpace.s5)) {
                                    Text(today.dayOfMonth.toString(), style = MaterialTheme.typography.displaySmall)
                                    Text("Small moments.\nLasting connections.", style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
                                }
                                Text(if (moments.isEmpty()) "No nudges today. Reconnect at your own pace." else "${moments.size} reason${if (moments.size == 1) "" else "s"} to reach out, when it feels right.", style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                    if (moments.isEmpty() && recent.isEmpty()) item {
                        EmptyState("A quiet day", "Nothing needs a nudge. A familiar name can be a good place to start.", "Explore your people", openPeople)
                    }
                    items(moments, key = { it.key }) { (key, moment) ->
                        val person = records.people.getValue(moment.person_id)
                        JournalCard(Modifier.padding(horizontal = KinSpace.s4)) {
                            PersonRow(person, graph, if (moment.surfaced_on == today.toString()) "A moment for today" else formatDate(moment.surfaced_on)) { openPerson(moment.person_id) }
                            Column(Modifier.padding(start = 20.dp, end = 20.dp, bottom = 16.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                                Text(moment.reason, style = MaterialTheme.typography.bodyLarge)
                                moment.context?.takeIf { it.isNotBlank() }?.let { Text(it, style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant) }
                                FlowRow(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                    fun status(value: String) = graph.edit("moment_status", buildJsonObject { put("key", key); put("status", value) })
                                    FilledTonalButton(onClick = { status("done") }) { Icon(Icons.Outlined.Check, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text("Done") }
                                    TextButton(onClick = { status("dismissed") }) { Text("Dismiss") }
                                }
                            }
                        }
                    }
                    if (recent.isNotEmpty()) {
                        item { Row(Modifier.padding(horizontal = KinSpace.s4), verticalAlignment = Alignment.CenterVertically) {
                            Text("Recently in touch", Modifier.weight(1f), style = MaterialTheme.typography.titleLarge)
                            TextButton(onClick = openPeople) { Text("View all") }
                        } }
                        item { JournalCard(Modifier.padding(horizontal = KinSpace.s4)) {
                            recent.forEachIndexed { index, (id, person) ->
                                PersonRow(person, graph, "Last contact · ${formatDate(person.last_contact?.take(10))}") { openPerson(id) }
                                if (index < recent.lastIndex) Spacer(Modifier.height(KinSpace.half))
                            }
                        } }
                    }
                }
                else -> {
                    item { SectionHeader("The next 60 days") }
                    if (upcoming.isEmpty()) item { EmptyState("Room to be spontaneous", "Birthdays, anniversaries, trips and dated plans will appear here.") }
                    items(upcoming, key = { it.eventId }) { item ->
                        JournalCard(Modifier.padding(horizontal = KinSpace.s4)) {
                            Column(Modifier.fillMaxWidth().clickable { openPerson(item.event.person_id) }.padding(20.dp), verticalArrangement = Arrangement.spacedBy(12.dp)) {
                                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                                    Icon(Icons.Outlined.Event, null, tint = MaterialTheme.colorScheme.tertiary, modifier = Modifier.size(18.dp))
                                    Text(formatDate(item.on.toString()), style = MaterialTheme.typography.labelLarge, color = MaterialTheme.colorScheme.tertiary)
                                }
                                Text(records.people.getValue(item.event.person_id).name, style = MaterialTheme.typography.headlineSmall)
                                MetaLabel(item.label, date = item.event.type in setOf("birthday", "loss", "wedding", "engagement", "birth"))
                                Text(item.event.value, style = MaterialTheme.typography.bodyMedium)
                            }
                        }
                    }
                }
            }
        }
    }
}

