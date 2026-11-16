package app.mypeople.ui

import android.content.Intent
import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import app.mypeople.AppGraph
import app.mypeople.data.StoreState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun TransferControls(graph: AppGraph, state: StoreState, feedback: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var selected by remember { mutableStateOf<Uri?>(null) }
    // Transfer secrets, like device tokens, must never enter saved-instance state.
    var password by remember { mutableStateOf("") }
    var error by remember { mutableStateOf<String?>(null) }
    var busy by remember { mutableStateOf(false) }
    val choose = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        if (uri != null) { selected = uri; password = graph.settings.transferPassword; error = null }
    }
    JournalCard {
        Column(Modifier.padding(20.dp), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Sync with Mac", style = MaterialTheme.typography.headlineSmall)
            Text(if (state.pending.isEmpty()) "No queued edits" else "${state.pending.size} ${if (state.pending.size == 1) "edit" else "edits"} ready to send", style = MaterialTheme.typography.titleMedium)
            Text("Last sync · ${syncDate(state.lastSync) ?: "Not yet"}", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            BluetoothPairing(graph, state, feedback)
        }
    }
    SettingsDisclosure("Transfer files", "Import memory or share queued edits without QR") {
        OutlinedButton(enabled = state.ready && !busy, onClick = { choose.launch(arrayOf("*/*")) }, modifier = Modifier.fillMaxWidth()) { Text("Import memory file") }
        OutlinedButton(enabled = state.offlineSource != null && state.pending.isNotEmpty() && !busy, modifier = Modifier.fillMaxWidth(), onClick = {
            busy = true
            scope.launch {
                try {
                    val file = graph.offline.editsFile()
                    val uri = FileProvider.getUriForFile(context, "${context.packageName}.transfers", file)
                    val intent = Intent(Intent.ACTION_SEND).setType("application/octet-stream")
                        .putExtra(Intent.EXTRA_STREAM, uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    context.startActivity(Intent.createChooser(intent, "Send edits to your Mac"))
                    feedback("Choose Bluetooth. Edits stay queued until your Mac sends back an updated memory file.")
                } catch (e: CancellationException) { throw e }
                catch (_: Exception) { feedback("Couldn’t export edits. Your queue is still safe on this phone.") }
                finally { busy = false }
            }
        }) { Text(if (busy) "Preparing…" else "Share queued edits") }
        Text("Encrypted transfers, not full phone backups. Shared edits stay queued until your Mac returns updated memory.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    }
    selected?.let { uri ->
        AlertDialog(onDismissRequest = { if (!busy) { selected = null; password = "" } }, title = { Text("Unlock your memory") }, text = {
            Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text("Use the transfer passphrase from your Mac. Published memory is replaced; queued edits from the same Mac are kept.", style = MaterialTheme.typography.bodyMedium)
                OutlinedTextField(password, { password = it; error = null }, label = { Text("Transfer passphrase") }, enabled = !busy, singleLine = true, keyboardOptions = androidx.compose.foundation.text.KeyboardOptions(keyboardType = androidx.compose.ui.text.input.KeyboardType.Password), visualTransformation = PasswordVisualTransformation(), modifier = Modifier.fillMaxWidth())
                Text("The passphrase is remembered in app-private storage for exporting edits. App backups are disabled.", style = MaterialTheme.typography.bodySmall)
                error?.let { Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodySmall) }
                if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
            }
        }, confirmButton = {
            FilledTonalButton(enabled = password.length >= 12 && !busy, onClick = {
                busy = true
                scope.launch {
                    try {
                        graph.offline.importMemory(uri, password)
                        selected = null; password = ""
                        feedback("Memory imported. Unacknowledged edits were kept on this phone.")
                    } catch (e: CancellationException) { throw e }
                    catch (e: IllegalArgumentException) { error = e.message ?: "Couldn’t read this memory file." }
                    catch (_: Exception) { error = "Couldn’t import this file. Your memory and queued edits haven’t been replaced." }
                    finally { busy = false }
                }
            }) { Text(if (busy) "Importing…" else "Import") }
        }, dismissButton = { TextButton(enabled = !busy, onClick = { selected = null; password = "" }) { Text("Cancel") } })
    }
}
