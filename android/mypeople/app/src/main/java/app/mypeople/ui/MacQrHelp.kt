package app.mypeople.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier

@Composable
internal fun MacQrHelp(onClose: () -> Unit) {
    AlertDialog(onDismissRequest = onClose, title = { Text("Open a QR on your Mac") }, text = {
        Column(Modifier.verticalScroll(rememberScrollState()), verticalArrangement = Arrangement.spacedBy(KinSpace.s3)) {
            Text("In the MyPeople CLI folder, run:")
            Surface(color = MaterialTheme.colorScheme.surfaceContainerHigh, shape = MaterialTheme.shapes.medium) {
                SelectionContainer {
                    Text("uv run --extra bluetooth mypeople transfer qr", Modifier.padding(KinSpace.s3), style = MaterialTheme.typography.bodyMedium)
                }
            }
            Text("Leave the command running and your Mac awake. Keep both devices nearby and approve Bluetooth pairing if asked.")
            Text("QR expired? Stop the command and run it again. Only scan a QR from a Mac you trust.", style = MaterialTheme.typography.bodySmall)
        }
    }, confirmButton = { TextButton(onClick = onClose) { Text("Done") } })
}
