package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.*
import androidx.compose.ui.unit.dp
import app.mypeople.data.BluetoothPhase
import app.mypeople.data.BluetoothProgress

/** Presentation only: Bluetooth permission and transfer lifetime stay with the caller. */
@Composable
internal fun SyncConfirmation(
    name: String,
    version: Int,
    pendingCount: Int,
    foreignQueue: Boolean,
    receiving: Boolean,
    transfer: BluetoothProgress,
    onConfirm: () -> Unit,
    onCancel: () -> Unit,
    error: String? = null,
    onPermissions: (() -> Unit)? = null,
) {
    val committing = transfer.phase == BluetoothPhase.IMPORTING || transfer.phase == BluetoothPhase.CONFIRMING
    val title = when (transfer.phase) {
        BluetoothPhase.CONNECTING -> "Connecting over Bluetooth"
        BluetoothPhase.SENDING_EDITS -> "Sending your edits"
        BluetoothPhase.WAITING_FOR_MAC -> "Updating memory on your Mac"
        BluetoothPhase.RECEIVING_MEMORY -> "Receiving updated memory"
        BluetoothPhase.IMPORTING -> "Saving your memory…"
        BluetoothPhase.CONFIRMING -> "Confirming sync…"
    }
    AlertDialog(onDismissRequest = { if (!receiving) onCancel() }, title = { Text(if (receiving) title else if (version >= 2) "Sync with your Mac?" else "Receive your Mac’s memory?", modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text(name.take(80), style = MaterialTheme.typography.titleMedium)
            error?.let { Text(it, color = MaterialTheme.colorScheme.error, modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }) }
            onPermissions?.let { TextButton(onClick = it) { Text("App permissions") } }
            Text(when {
                receiving -> "Keep your Mac awake and both devices nearby."
                foreignQueue -> "These queued edits belong to another database or sync method. Sync them with their original Mac before switching."
                version >= 2 -> "Send $pendingCount queued ${if (pendingCount == 1) "edit" else "edits"} and receive updated memory. Only connect to a Mac you trust: the complete memory and history are exchanged."
                else -> "This older QR only downloads memory. Your queued edits will be kept; generate a fresh QR for two-way sync."
            })
            if (receiving) {
                if (transfer.total > 0 && !committing) {
                    LinearProgressIndicator(progress = { transfer.done.toFloat() / transfer.total }, modifier = Modifier.fillMaxWidth())
                    Text("${transfer.done * 100 / transfer.total}%", style = MaterialTheme.typography.bodySmall)
                } else {
                    LinearProgressIndicator(Modifier.fillMaxWidth())
                    Text(when (transfer.phase) {
                        BluetoothPhase.WAITING_FOR_MAC -> "Your Mac is applying edits and preparing updated memory. This may take a few minutes."
                        BluetoothPhase.IMPORTING -> "Verifying and saving memory and receipts together."
                        BluetoothPhase.CONFIRMING -> "Confirming that both devices finished."
                        else -> "Approve any OS Bluetooth pairing prompts."
                    }, style = MaterialTheme.typography.bodySmall)
                }
            }
        }
    }, confirmButton = {
        if (!receiving) FilledTonalButton(enabled = !foreignQueue, onClick = onConfirm) { Text(if (version >= 2) "Sync with Mac" else "Receive memory") }
    }, dismissButton = {
        TextButton(enabled = !committing || !receiving, onClick = onCancel) { Text(if (receiving) "Cancel transfer" else "Cancel") }
    })
}
