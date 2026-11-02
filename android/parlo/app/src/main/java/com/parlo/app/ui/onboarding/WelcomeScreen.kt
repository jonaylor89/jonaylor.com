package com.parlo.app.ui.onboarding

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material.icons.filled.Headphones
import androidx.compose.material.icons.filled.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import com.parlo.app.ui.SetupStatus
import com.parlo.app.ui.components.StepRow
import com.parlo.app.ui.components.DevelopmentBuildNotice
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.components.OrbState
import com.parlo.app.ui.components.VoiceOrb
import androidx.compose.material.icons.automirrored.rounded.DirectionsWalk
import com.parlo.app.ui.theme.ParloSpacing

private const val AI_STUDIO_KEYS = "https://aistudio.google.com/app/apikey"

/** First run: what Parlo is, then a two-step connect. Voice, appearance and model stay in Settings. */
@Composable
fun WelcomeScreen(status: SetupStatus, maskedKey: String, onPasteKey: (String) -> Unit, onStart: () -> Unit, modifier: Modifier = Modifier, languageChoice: (@Composable () -> Unit)? = null) {
    val context = LocalContext.current
    val connected = status == SetupStatus.READY
    Column(modifier.fillMaxSize().verticalScroll(rememberScrollState()).padding(24.dp).testTag("welcome"), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space4)) {
        Spacer(Modifier.height(12.dp))
        // The voice orb is Parlo's only character: here it is listening, waiting for you.
        VoiceOrb(OrbState.LISTENING, size = 96.dp)
        DevelopmentBuildNotice()
        Text("Learn a language on your walk.", style = MaterialTheme.typography.displaySmall)
        Text(
            "Parlo is a voice tutor you talk to, with earbuds or out loud. It runs on your own free Gemini key, so there's no account, and nothing leaves your phone except calls to Gemini.",
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        languageChoice?.invoke()
        Column(verticalArrangement = Arrangement.spacedBy(ParloSpacing.hair)) {
            StepRow(
                done = status != SetupStatus.NO_KEY,
                icon = Icons.AutoMirrored.Filled.OpenInNew,
                title = "Get a free key",
                body = "Opens Google AI Studio. Copy the key it gives you.",
                modifier = Modifier.testTag("step_get_key"),
                shape = ParloShape.grouped(0, 2),
                onClick = { context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(AI_STUDIO_KEYS)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)) },
            )
            StepRow(
                done = connected,
                icon = Icons.Filled.ContentPaste,
                title = when (status) {
                    SetupStatus.READY -> "Connected"
                    SetupStatus.CHECKING -> "Checking your key…"
                    SetupStatus.BAD_KEY -> "That key didn't work. Paste it again"
                    SetupStatus.OFFLINE -> "Couldn't reach Gemini. Paste again to retry"
                    SetupStatus.NO_MODEL -> "No voice model found for this key"
                    SetupStatus.NO_KEY -> "Paste your key"
                },
                body = if (maskedKey.isNotBlank()) "$maskedKey · Parlo picks the voice model for you" else "Reads it from your clipboard.",
                modifier = Modifier.testTag("step_paste_key"),
                shape = ParloShape.grouped(1, 2),
                busy = status == SetupStatus.CHECKING,
                onClick = { clipboardText(context)?.let(onPasteKey) },
            )
        }
        Spacer(Modifier.height(12.dp))
        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.Center, verticalAlignment = Alignment.CenterVertically) {
            Icon(Icons.Filled.Lock, null, Modifier.size(14.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
            Spacer(Modifier.width(6.dp))
            Text("Stored encrypted on this phone", style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
        Button(onClick = onStart, enabled = connected, modifier = Modifier.fillMaxWidth().height(ParloSize.targetWalk).testTag("start_first_walk"), shape = ParloShape.extraLarge) {
            Icon(Icons.AutoMirrored.Rounded.DirectionsWalk, null, Modifier.size(28.dp))
            Spacer(Modifier.width(ParloSpacing.space3))
            Text("Start your first walk", style = MaterialTheme.typography.titleLarge)
        }
        Text(
            "Your tutor will help you find your level in your chosen language. Earbuds are optional.",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth(),
        )
    }
}

private fun clipboardText(context: Context): String? {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.trim()?.takeIf { it.isNotBlank() }
}

internal fun maskKey(key: String): String = if (key.length < 10) "" else key.take(4) + "••••" + key.takeLast(4)
