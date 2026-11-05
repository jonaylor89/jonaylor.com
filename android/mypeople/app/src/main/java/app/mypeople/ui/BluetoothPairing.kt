package app.mypeople.ui

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import app.mypeople.AppGraph
import app.mypeople.data.BluetoothOffer
import app.mypeople.data.BluetoothPhase
import app.mypeople.data.BluetoothProgress
import app.mypeople.data.StoreState
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch

@Composable
fun BluetoothPairing(graph: AppGraph, state: StoreState, feedback: (String) -> Unit) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    var offer by remember { mutableStateOf<BluetoothOffer?>(null) }
    var scanning by remember { mutableStateOf(false) }
    var cameraDenied by remember { mutableStateOf(false) }
    var receiving by remember { mutableStateOf(false) }
    var transfer by remember { mutableStateOf(BluetoothProgress(BluetoothPhase.CONNECTING)) }
    DisposableEffect(graph) { onDispose { graph.bluetooth.cancel() } }
    fun receive() {
        val current = offer ?: return
        receiving = true; transfer = BluetoothProgress(BluetoothPhase.CONNECTING)
        scope.launch {
            try {
                val result = graph.bluetooth.sync(current) { next -> scope.launch { transfer = next } }
                offer = null
                val remaining = graph.store.state.value.pending.size
                feedback(when {
                    !result.bidirectional -> "Memory imported. This older QR does not upload edits; use a fresh QR for two-way sync."
                    !result.peerConfirmed -> "Updated memory imported. The final Mac confirmation was interrupted; retrying sync is safe."
                    remaining > 0 -> "Synced with your Mac. $remaining request(s) still queued for a later attempt."
                    else -> "Sync complete. Phone edits and updated memory are saved on both devices."
                })
            } catch (e: CancellationException) { throw e }
            catch (e: IllegalArgumentException) { feedback(e.message ?: "Couldn’t import that memory."); offer = null }
            catch (_: Exception) { feedback("Bluetooth connection interrupted. Keep both devices nearby, approve pairing prompts, and scan a fresh QR."); offer = null }
            finally { receiving = false }
        }
    }
    val bluetoothPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) receive() else feedback("Nearby devices access is needed for Bluetooth transfer.")
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanning = true else cameraDenied = true
    }
    Button(enabled = state.ready && !scanning && !receiving, modifier = Modifier.fillMaxWidth(), onClick = {
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }) { Text("Scan Mac QR") }
    Text("On your Mac: mypeople transfer qr. One scan sends your edits and returns updated memory—no files to move or import commands.", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
    if (cameraDenied) AlertDialog(onDismissRequest = { cameraDenied = false }, title = { Text("Allow camera access") }, text = {
        Text("MyPeople needs Camera permission to scan your Mac’s QR. If Android no longer shows the permission prompt, enable Camera in MyPeople’s app permissions.")
    }, confirmButton = {
        TextButton(onClick = {
            cameraDenied = false
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
        }) { Text("App settings") }
    }, dismissButton = { TextButton(onClick = { cameraDenied = false }) { Text("Cancel") } })
    if (scanning) QrCamera(onScanned = { raw ->
        scanning = false
        try { offer = BluetoothOffer.parse(raw) }
        catch (_: Exception) { feedback("That isn’t a current MyPeople Bluetooth QR. Generate a fresh QR on your Mac.") }
    }, onClose = { scanning = false }, onError = {
        scanning = false
        feedback("Couldn’t open the camera. Check Camera permission and the camera privacy switch in Android Quick Settings.")
    })
    offer?.let { current ->
        val committing = transfer.phase == BluetoothPhase.IMPORTING || transfer.phase == BluetoothPhase.CONFIRMING
        val foreignQueue = state.pending.isNotEmpty() && state.offlineSource != current.source
        val title = when (transfer.phase) {
            BluetoothPhase.CONNECTING -> "Connecting over Bluetooth"
            BluetoothPhase.SENDING_EDITS -> "Sending your edits"
            BluetoothPhase.WAITING_FOR_MAC -> "Updating memory on your Mac"
            BluetoothPhase.RECEIVING_MEMORY -> "Receiving updated memory"
            BluetoothPhase.IMPORTING -> "Saving your memory…"
            BluetoothPhase.CONFIRMING -> "Confirming sync…"
        }
        AlertDialog(onDismissRequest = { if (!receiving) offer = null }, title = { Text(if (receiving) title else if (current.version == 2) "Sync with your Mac?" else "Receive your Mac’s memory?") }, text = {
            Column(verticalArrangement = Arrangement.spacedBy(14.dp)) {
                Text(when {
                    receiving -> "Keep both devices nearby. Edits stay safely queued until the return snapshot acknowledges them."
                    foreignQueue -> "These queued edits belong to another database or sync method. Sync them with their original Mac before switching."
                    current.version == 2 -> "${current.name.take(80)}\n\nSend ${state.pending.size} queued edit(s), then receive fresh memory and confirmations in this same connection. Raw messages stay on your Mac."
                    else -> "This older QR only downloads memory. Your queued edits will be kept; generate a fresh QR for two-way sync."
                })
                if (receiving) {
                    if (transfer.total > 0 && !committing) {
                        LinearProgressIndicator(progress = { transfer.done.toFloat() / transfer.total }, modifier = Modifier.fillMaxWidth())
                        Text("${transfer.done * 100 / transfer.total}%", style = MaterialTheme.typography.bodySmall)
                    } else {
                        LinearProgressIndicator(Modifier.fillMaxWidth())
                        Text(when (transfer.phase) {
                            BluetoothPhase.WAITING_FOR_MAC -> "Your Mac is applying edits and preparing fresh memory. Notes and enrichment may take longer."
                            BluetoothPhase.IMPORTING -> "Verifying and saving memory and receipts together."
                            BluetoothPhase.CONFIRMING -> "Confirming that both devices finished."
                            else -> "Approve any OS Bluetooth pairing prompts."
                        }, style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
        }, confirmButton = {
            if (!receiving) FilledTonalButton(enabled = !foreignQueue, onClick = {
                if (Build.VERSION.SDK_INT >= 31 && ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) bluetoothPermission.launch(Manifest.permission.BLUETOOTH_CONNECT)
                else receive()
            }) { Text(if (current.version == 2) "Sync with Mac" else "Receive memory") }
        }, dismissButton = {
            TextButton(enabled = !committing || !receiving, onClick = { if (receiving) graph.bluetooth.cancel() else offer = null }) { Text(if (receiving) "Cancel transfer" else "Cancel") }
        })
    }
}
