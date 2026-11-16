package app.mypeople.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.StoreState
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun SettingsScreen(graph: AppGraph, state: StoreState, scrollToTopRequest: Long = 0, onBack: () -> Unit = {}, feedback: (String) -> Unit) {
    val scroll = rememberScrollState()
    OnScrollToTopRequest(scrollToTopRequest) { scroll.scrollTo(0) }
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(scroll).testTag("settings-scroll")) {
        Row(Modifier.fillMaxWidth().padding(KinSpace.s1), verticalAlignment = Alignment.CenterVertically) {
            IconButton(onClick = onBack) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
            Text("Settings", style = MaterialTheme.typography.titleLarge)
        }
        Column(Modifier.padding(horizontal = KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
            state.lastError?.let {
                Surface(shape = RoundedCornerShape(KinRadius.md), color = MaterialTheme.colorScheme.errorContainer) {
                    Column(Modifier.fillMaxWidth().padding(KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s2)) {
                        Text(it, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite })
                        if (!state.ready) TextButton(onClick = { graph.openMemory() }) { Text("Retry opening memory") }
                    }
                }
            }
            TransferControls(graph, state, feedback)
            ContactsSettings(graph, state, feedback)
            SettingsDisclosure("Storage & privacy", "${state.records.people.size} people · ${state.records.events.size} facts on this phone") {
                Text("Saved in app-private storage. No internet access or automatic sync.", style = MaterialTheme.typography.bodyMedium)
                Text("Data moves only when you scan a Mac QR or choose a file. Android contacts integration shares contact details with apps that have Contacts permission.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                state.offlineSource?.let { Text("Memory revision ${state.offlineRevision}", style = MaterialTheme.typography.bodySmall) }
            }
            Spacer(Modifier.height(KinSpace.s4))
        }
    }
}

/** A full-width, labelled disclosure; hidden controls keep their owning screen's state. */
@Composable
fun SettingsDisclosure(title: String, summary: String, content: @Composable ColumnScope.() -> Unit) {
    var expanded by rememberSaveable { mutableStateOf(false) }
    Surface(shape = RoundedCornerShape(KinRadius.xl), color = MaterialTheme.colorScheme.surfaceContainerLow) {
        Column(Modifier.fillMaxWidth()) {
            Row(
                Modifier.fillMaxWidth().clickable(role = Role.Button, onClickLabel = if (expanded) "Collapse $title" else "Expand $title") { expanded = !expanded }
                    .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                    .padding(KinSpace.s4),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(KinSpace.s3),
            ) {
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(KinSpace.s1)) {
                    Text(title, style = MaterialTheme.typography.titleMedium)
                    Text(summary, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                }
                Text(if (expanded) "−" else "+", style = MaterialTheme.typography.titleLarge, modifier = Modifier.clearAndSetSemantics {})
            }
            if (expanded) Column(Modifier.padding(start = KinSpace.s4, end = KinSpace.s4, bottom = KinSpace.s4), verticalArrangement = Arrangement.spacedBy(KinSpace.s3), content = content)
        }
    }
}

internal fun syncDate(raw: String?): String? = raw?.let {
    runCatching { DateTimeFormatter.ofPattern("MMM d, yyyy · h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(it)) }.getOrNull()
}
