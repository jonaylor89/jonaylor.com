package com.parlo.app.ui.main

import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.input.PasswordVisualTransformation
import com.parlo.app.ParloApp
import com.parlo.app.data.LearningRepository
import com.parlo.app.data.LearningWorker
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** SAF keeps file ownership with the learner; a forgotten backup password cannot be recovered. */
@Composable
internal fun LearningBackupControls(enabled: Boolean) {
    val context = LocalContext.current
    val container = ParloApp.container(context)
    val scope = rememberCoroutineScope()
    var mode by remember { mutableStateOf<String?>(null) }
    var password by remember { mutableStateOf("") }
    var confirmation by remember { mutableStateOf("") }
    var pendingPassword by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var message by remember { mutableStateOf("") }

    val export = rememberLauncherForActivityResult(ActivityResultContracts.CreateDocument("application/octet-stream")) { uri ->
        val secret = pendingPassword.toCharArray()
        pendingPassword = ""
        if (uri == null) { secret.fill('\u0000'); return@rememberLauncherForActivityResult }
        scope.launch {
            busy = true
            try {
                check(!container.liveWalk.value.isActive) { "End your walk before backing up" }
                withContext(Dispatchers.IO) {
                    context.contentResolver.openOutputStream(uri)?.use { container.learningBackup.export(it, secret) }
                        ?: error("Couldn't open the backup file")
                }
                message = "Encrypted backup saved. Keep your password somewhere safe."
            } catch (e: CancellationException) { throw e }
            catch (e: Exception) { message = "Backup failed: ${e.message}" }
            finally { secret.fill('\u0000'); busy = false }
        }
    }
    val restore = rememberLauncherForActivityResult(ActivityResultContracts.OpenDocument()) { uri ->
        val secret = pendingPassword.toCharArray()
        pendingPassword = ""
        if (uri == null) { secret.fill('\u0000'); return@rememberLauncherForActivityResult }
        scope.launch {
            busy = true
            try {
                check(!container.liveWalk.value.isActive) { "End your walk before restoring" }
                withContext(Dispatchers.IO) {
                    context.contentResolver.openInputStream(uri)?.use { container.learningBackup.restore(it, secret) }
                        ?: error("Couldn't open the backup file")
                }
                LearningWorker.enqueue(context)
                message = "Learning journeys restored. Your Gemini key wasn't changed."
            } catch (e: CancellationException) { throw e }
            catch (_: Exception) { message = "Couldn't restore. Check the password and that this is an intact Parlo backup. Learning data is unchanged unless import completed."
            } finally { secret.fill('\u0000'); busy = false }
        }
    }

    Column {
        Text("Protect your progress", style = MaterialTheme.typography.titleMedium)
        Text("Local history does not survive losing this phone or uninstalling Parlo. Save an encrypted backup somewhere safe; it includes every language but never your API key.",
            style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        Row {
            TextButton(enabled = enabled && !busy, onClick = { password = ""; confirmation = ""; mode = "export" }) { Text("Save backup") }
            TextButton(enabled = enabled && !busy, onClick = { password = ""; confirmation = ""; mode = "restore" }) { Text("Restore backup") }
        }
        if (busy) LinearProgressIndicator(Modifier.fillMaxWidth())
        if (message.isNotBlank()) Text(message, style = MaterialTheme.typography.bodySmall)
    }
    mode?.let { action ->
        val saving = action == "export"
        AlertDialog(onDismissRequest = { mode = null; password = ""; confirmation = "" },
            title = { Text(if (saving) "Encrypt your backup" else "Replace learning data?") },
            text = {
                Column {
                    Text(if (saving) "Choose at least 12 characters. This password cannot be recovered. You'll choose where to save the file next." else
                        "Restoring replaces ALL current conversations, vocabulary and language journeys with the backup. Save a current backup first. Your Gemini key stays unchanged.")
                    OutlinedTextField(value = password, onValueChange = { password = it }, label = { Text("Backup password") },
                        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true)
                    if (saving) OutlinedTextField(value = confirmation, onValueChange = { confirmation = it }, label = { Text("Confirm password") },
                        visualTransformation = PasswordVisualTransformation(), keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password), singleLine = true)
                }
            },
            confirmButton = {
                TextButton(enabled = if (saving) password.length >= 12 && password == confirmation else password.isNotEmpty(), onClick = {
                    pendingPassword = password
                    password = ""; confirmation = ""; mode = null
                    if (saving) export.launch("parlo-${LearningRepository.date(System.currentTimeMillis())}.parlo")
                    else restore.launch(arrayOf("application/octet-stream", "application/gzip", "*/*"))
                }) { Text(if (saving) "Choose location" else "Choose backup and replace") }
            },
            dismissButton = { TextButton(onClick = { mode = null; password = ""; confirmation = "" }) { Text("Cancel") } })
    }
}
