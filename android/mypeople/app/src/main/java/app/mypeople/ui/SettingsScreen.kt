package app.mypeople.ui

import app.mypeople.ui.icons.*

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.unit.dp
import app.mypeople.AppGraph
import app.mypeople.data.StoreState
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun SettingsScreen(graph: AppGraph, state: StoreState, scrollToTopRequest: Long = 0, onBack: () -> Unit = {}, feedback: (String) -> Unit) {
    val lastSync = state.lastSync?.let { raw -> runCatching { DateTimeFormatter.ofPattern("MMM d, yyyy · h:mm a").withZone(ZoneId.systemDefault()).format(Instant.parse(raw)) }.getOrNull() }
    val scroll = rememberScrollState()
    OnScrollToTopRequest(scrollToTopRequest) { scroll.scrollTo(0) }
    Column(Modifier.fillMaxSize().imePadding().verticalScroll(scroll).testTag("settings-scroll")) {
        IconButton(onClick = onBack, modifier = Modifier.padding(start = KinSpace.s1, top = KinSpace.s1)) { Icon(Icons.AutoMirrored.Filled.ArrowBack, "Back") }
        Heading("On your terms", "Your Mac. Your people. Your memory.")
        Column(Modifier.padding(horizontal = KinSpace.s4), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            ContactsSettings(graph, state, feedback)
            TransferControls(graph, state, feedback)
            Surface(shape = RoundedCornerShape(KinRadius.xl), color = MaterialTheme.colorScheme.surfaceContainerLow) {
                Column(Modifier.fillMaxWidth().padding(24.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                    Icon(Icons.Outlined.PhonelinkLock, null, Modifier.size(28.dp))
                    Text("Your memory,\nwith you.", style = MaterialTheme.typography.headlineSmall)
                    Text("${state.records.people.size} people · ${state.records.events.size} facts\nAvailable to browse offline", style = MaterialTheme.typography.bodyMedium)
                }
            }
            Section("Storage")
            JournalCard {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Column(verticalArrangement = Arrangement.spacedBy(4.dp)) {
                        Text("Last synced with your Mac", style = MaterialTheme.typography.titleSmall)
                        Text(lastSync ?: "Not yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Text("${state.pending.size} edit${if (state.pending.size == 1) "" else "s"} waiting to go to your Mac", style = MaterialTheme.typography.bodyMedium)
                    state.lastError?.let {
                        Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.errorContainer) {
                            Text(it, Modifier.padding(16.dp), style = MaterialTheme.typography.bodySmall)
                        }
                    }
                }
            }
            Section("Private by default")
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                Icon(Icons.Outlined.Shield, null, tint = MaterialTheme.colorScheme.primary, modifier = Modifier.padding(top = 4.dp).size(22.dp))
                Text("Messages stay on your Mac. This phone stores only published people, facts, short evidence quotes, and queued edits in app-private storage.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
            Text("MyPeople · a little memory goes a long way", Modifier.padding(vertical = 24.dp), style = MaterialTheme.typography.labelSmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.height(8.dp))
        }
    }
}
