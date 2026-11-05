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
import app.mypeople.data.validateServerUrl
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter

@Composable
fun SettingsScreen(graph: AppGraph, state: StoreState, scrollToTopRequest: Long = 0, onBack: () -> Unit = {}, feedback: (String) -> Unit) {
    var url by rememberSaveable { mutableStateOf(graph.settings.serverUrl) }
    // Credentials never enter saved-instance state or navigation arguments.
    var token by remember { mutableStateOf(graph.settings.token) }
    var error by remember { mutableStateOf<String?>(null) }
    var saving by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()
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
            Section("Sync & storage")
            JournalCard {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp), verticalAlignment = Alignment.CenterVertically) {
                        Icon(if (state.lastError != null) Icons.Outlined.CloudOff else Icons.Outlined.Sync, null, tint = MaterialTheme.colorScheme.primary)
                        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(4.dp)) {
                            Text(if (state.syncing) "Refreshing your memory…" else if (state.offlineSource != null) "Last imported" else "Last synced", style = MaterialTheme.typography.titleMedium)
                            Text(lastSync ?: "Not yet", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                        }
                    }
                    HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant)
                    Text("${state.pending.size} pending operation${if (state.pending.size == 1) "" else "s"}", style = MaterialTheme.typography.titleMedium)
                    Text(if (state.replicatedContacts) "Contact changes are complete and saved locally. Sync exchanges missing history with your other devices; it does not approve your edits." else if (state.pending.isNotEmpty()) "Edits are saved on this phone. Sent edits stay here until your Mac applies them." else "Edits you make here are queued for your Mac. Nothing is sent on your behalf.", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    state.lastError?.let {
                        Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.errorContainer) {
                            Column(Modifier.padding(16.dp), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                                Text("Couldn’t sync", style = MaterialTheme.typography.titleSmall)
                                Text(it, style = MaterialTheme.typography.bodySmall)
                                Text("Your saved memory is still here. Check your connection and try again.", style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                    FilledTonalButton(enabled = graph.settings.configured && state.offlineSource == null && !state.syncing, onClick = { graph.sync.now() }, modifier = Modifier.fillMaxWidth()) {
                        Icon(Icons.Outlined.Sync, null, Modifier.size(18.dp)); Spacer(Modifier.width(8.dp)); Text(if (state.syncing) "Syncing…" else "Sync now")
                    }
                }
            }
            Text(if (state.offlineSource != null) "Scan your Mac’s QR to sync both ways over Bluetooth. Edits stay queued until updated memory acknowledges them. Nothing is sent automatically." else "With a server connection, refreshes when you open MyPeople, after edits, and about every 15 minutes with a network. Android may defer background work to save battery.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            Section("Optional server connection")
            JournalCard {
                Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(16.dp)) {
                    OutlinedTextField(url, { url = it; error = null }, label = { Text("Server URL") }, placeholder = { Text("https://your-server.tailnet.ts.net") }, keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false), singleLine = true, modifier = Modifier.fillMaxWidth())
                    OutlinedTextField(token, { token = it; error = null }, label = { Text("Phone device token") }, leadingIcon = { Icon(Icons.Outlined.Key, null) }, visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false), singleLine = true, modifier = Modifier.fillMaxWidth())
                    Text("Use HTTPS, usually with Tailscale Serve. Only the emulator may use http://10.0.2.2:8765. Never use a Mac-role token on this phone.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium) }
                    Button(enabled = !saving && state.ready, modifier = Modifier.fillMaxWidth(), onClick = {
                        error = validateServerUrl(url)
                        if (error == null) scope.launch {
                            saving = true
                            try { graph.configure(url, token); feedback("Connection saved. Syncing…") }
                            catch (e: IllegalArgumentException) { error = e.message }
                            catch (_: Exception) { error = "Couldn't save your connection. Try again." }
                            finally { saving = false }
                        }
                    }) { Text(if (saving) "Saving…" else "Save connection") }
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
