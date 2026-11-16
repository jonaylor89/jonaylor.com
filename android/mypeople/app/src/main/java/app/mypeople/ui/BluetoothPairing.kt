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
import androidx.compose.ui.semantics.*
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
    var help by remember { mutableStateOf(false) }
    var transferError by remember { mutableStateOf<String?>(null) }
    var permissionError by remember { mutableStateOf(false) }
    fun showError(message: String, permissions: Boolean = false) { transferError = message; permissionError = permissions }
    var receiving by remember { mutableStateOf(false) }
    var transfer by remember { mutableStateOf(BluetoothProgress(BluetoothPhase.CONNECTING)) }
    DisposableEffect(graph) { onDispose { graph.bluetooth.cancel() } }
    fun receive() {
        val current = offer ?: return
        transferError = null
        receiving = true; transfer = BluetoothProgress(BluetoothPhase.CONNECTING)
        scope.launch {
            try {
                val result = graph.bluetooth.sync(current) { next -> scope.launch { transfer = next } }
                offer = null
                val remaining = graph.store.state.value.pending.size
                val twoVersions = graph.store.state.value.records.people.values.count { it.contact_conflicts.isNotEmpty() }
                val toReview = if (twoVersions > 0) " $twoVersions contact(s) have two versions to choose between in Review." else ""
                feedback(when {
                    !result.bidirectional -> "Memory imported. This older QR does not upload edits; use a fresh QR for two-way sync."
                    !result.peerConfirmed -> "Updated memory imported. The final Mac confirmation was interrupted; retrying sync is safe."
                    remaining > 0 -> "Synced with your Mac. $remaining request(s) still queued for a later attempt."
                    else -> "Sync complete. Phone edits and updated memory are saved on both devices."
                } + toReview)
            } catch (e: CancellationException) { throw e }
            catch (e: IllegalArgumentException) { showError(e.message ?: "Couldn’t import that memory."); offer = null }
            catch (_: Exception) { showError("Bluetooth connection interrupted. Keep both devices nearby, approve pairing prompts, and scan a fresh QR."); offer = null }
            finally { receiving = false }
        }
    }
    val bluetoothPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) receive() else showError("Nearby devices access is needed. Enable it in MyPeople’s app permissions, then try Sync with Mac again.", permissions = true)
    }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        if (granted) scanning = true else cameraDenied = true
    }
    transferError?.let { message ->
        Surface(color = MaterialTheme.colorScheme.errorContainer, shape = MaterialTheme.shapes.medium) {
            Text(message, Modifier.padding(KinSpace.s3).semantics { liveRegion = LiveRegionMode.Polite }, style = MaterialTheme.typography.bodyMedium)
        }
        if (permissionError) TextButton(onClick = { context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))) }) { Text("App permissions") }
    }
    Button(enabled = state.ready && !scanning && !receiving, modifier = Modifier.fillMaxWidth().heightIn(min = 56.dp), onClick = {
        transferError = null
        if (ContextCompat.checkSelfPermission(context, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) scanning = true
        else cameraPermission.launch(Manifest.permission.CAMERA)
    }) { Text(if (transferError != null) "Scan a fresh Mac QR" else "Scan Mac QR") }
    TextButton(onClick = { help = true }) { Text("Where do I find the QR?") }
    if (help) MacQrHelp(onClose = { help = false })
    if (cameraDenied) AlertDialog(onDismissRequest = { cameraDenied = false }, title = { Text("Allow camera access") }, text = {
        Text("Camera access is needed to scan your Mac’s QR. Enable Camera in MyPeople’s app permissions.")
    }, confirmButton = {
        TextButton(onClick = {
            cameraDenied = false
            context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null)))
        }) { Text("App settings") }
    }, dismissButton = { TextButton(onClick = { cameraDenied = false }) { Text("Cancel") } })
    if (scanning) QrCamera(onScanned = { raw ->
        scanning = false
        try { offer = BluetoothOffer.parse(raw) }
        catch (_: Exception) { showError("That isn’t a current MyPeople Bluetooth QR. Generate a fresh QR on your Mac.") }
    }, onClose = { scanning = false }, onError = {
        scanning = false
        showError("Couldn’t open the camera. Check Camera permission and the camera privacy switch in Android Quick Settings.", permissions = true)
    })
    offer?.let { current ->
        SyncConfirmation(
            name = current.name,
            version = current.version,
            pendingCount = state.pending.size,
            foreignQueue = state.pending.isNotEmpty() && state.offlineSource != current.source,
            receiving = receiving,
            transfer = transfer,
            onConfirm = {
                if (Build.VERSION.SDK_INT >= 31 && ContextCompat.checkSelfPermission(context, Manifest.permission.BLUETOOTH_CONNECT) != PackageManager.PERMISSION_GRANTED) bluetoothPermission.launch(Manifest.permission.BLUETOOTH_CONNECT)
                else receive()
            },
            onCancel = { if (receiving) graph.bluetooth.cancel() else offer = null },
            error = transferError,
            onPermissions = if (permissionError && transferError != null) ({ context.startActivity(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.fromParts("package", context.packageName, null))) }) else null,
        )
    }
}
