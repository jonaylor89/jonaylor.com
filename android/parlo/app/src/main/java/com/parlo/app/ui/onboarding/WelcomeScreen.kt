package com.parlo.app.ui.onboarding

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.OpenInNew
import androidx.compose.material.icons.automirrored.rounded.DirectionsWalk
import androidx.compose.material.icons.filled.ContentPaste
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import com.parlo.app.ui.SetupStatus
import com.parlo.app.ui.components.DevelopmentBuildNotice
import com.parlo.app.ui.components.OrbState
import com.parlo.app.ui.components.StepRow
import com.parlo.app.ui.components.VoiceOrb
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSize
import com.parlo.app.ui.theme.ParloSpacing

private const val AI_STUDIO_KEYS = "https://aistudio.google.com/app/apikey"

/** Activation first; the caller owns system insets through [modifier]. */
@Composable
fun WelcomeScreen(
    status: SetupStatus,
    maskedKey: String,
    onPasteKey: (String) -> Unit,
    onStart: () -> Unit,
    modifier: Modifier = Modifier,
    languageChoice: (@Composable () -> Unit)? = null,
    onRetry: () -> Unit = {},
    secondaryAction: (@Composable () -> Unit)? = null,
) {
    val context = LocalContext.current
    val connected = status == SetupStatus.READY
    var clipboardEmpty by rememberSaveable(status) { mutableStateOf(false) }
    val openKeyPage = {
        context.startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(AI_STUDIO_KEYS)).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
    }

    // No nested Scaffold or system-bar padding: MainScreen already supplies both insets.
    Column(modifier.fillMaxSize().testTag("welcome")) {
        Column(
            Modifier.weight(1f).fillMaxWidth().verticalScroll(rememberScrollState())
                .testTag("welcome_content").padding(ParloSpacing.space4),
            verticalArrangement = Arrangement.spacedBy(ParloSpacing.space4),
        ) {
            Row(
                horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space3),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                VoiceOrb(OrbState.LISTENING, size = ParloSize.targetMin)
                Text("Talk as you walk.", style = MaterialTheme.typography.headlineMedium, modifier = Modifier.weight(1f))
            }
            languageChoice?.invoke()

            Column(
                Modifier.fillMaxWidth().testTag("welcome_connection"),
                verticalArrangement = Arrangement.spacedBy(ParloSpacing.space3),
            ) {
                Text("Connect Gemini", style = MaterialTheme.typography.titleLarge)
                if (status == SetupStatus.NO_KEY) {
                    StepRow(
                        done = false,
                        icon = Icons.AutoMirrored.Filled.OpenInNew,
                        title = "Get a Gemini key",
                        body = "Create and copy a key in Google AI Studio.",
                        modifier = Modifier.testTag("step_get_key"),
                        onClick = openKeyPage,
                    )
                } else {
                    Surface(
                        color = if (connected) MaterialTheme.colorScheme.primaryContainer else MaterialTheme.colorScheme.surfaceContainer,
                        shape = ParloShape.large,
                        modifier = Modifier.fillMaxWidth(),
                    ) {
                        Column(
                            Modifier.padding(ParloSpacing.space4).semantics { liveRegion = LiveRegionMode.Polite },
                            verticalArrangement = Arrangement.spacedBy(ParloSpacing.space1),
                        ) {
                            Text(
                                when (status) {
                                    SetupStatus.READY -> "Connected"
                                    SetupStatus.CHECKING -> "Checking your key…"
                                    SetupStatus.BAD_KEY -> "That key didn't work"
                                    SetupStatus.OFFLINE -> "Couldn't reach Gemini"
                                    SetupStatus.NO_MODEL -> "No voice model found"
                                    SetupStatus.NO_KEY -> "Connect Gemini"
                                },
                                style = MaterialTheme.typography.titleMedium,
                            )
                            Text(
                                when (status) {
                                    SetupStatus.READY -> "Your voice tutor is ready."
                                    SetupStatus.CHECKING -> "Finding an available voice model."
                                    SetupStatus.BAD_KEY -> "Check your key in AI Studio, then paste a replacement."
                                    SetupStatus.OFFLINE -> "Check your connection, then try again. Your key is saved."
                                    SetupStatus.NO_MODEL -> "Refresh the available models, or check your key's access in AI Studio."
                                    SetupStatus.NO_KEY -> "Use your own Gemini key."
                                },
                                style = MaterialTheme.typography.bodyMedium,
                            )
                            if (maskedKey.isNotBlank()) {
                                Text(maskedKey, style = MaterialTheme.typography.bodySmall)
                            }
                        }
                    }
                }
                if (status == SetupStatus.OFFLINE || status == SetupStatus.NO_MODEL) {
                    Button(
                        onClick = onRetry,
                        modifier = Modifier.fillMaxWidth().heightIn(min = ParloSize.targetMin).testTag("retry_connection"),
                    ) {
                        Text(if (status == SetupStatus.OFFLINE) "Try again" else "Refresh models", textAlign = TextAlign.Center)
                    }
                }
                StepRow(
                    done = false,
                    icon = Icons.Filled.ContentPaste,
                    title = when {
                        clipboardEmpty -> "Clipboard is empty"
                        status == SetupStatus.NO_KEY -> "Paste your key"
                        else -> "Replace key"
                    },
                    body = when {
                        clipboardEmpty -> "Copy your Gemini key, then tap here again."
                        status == SetupStatus.NO_KEY -> "Reads your clipboard."
                        else -> "Reads a new key from your clipboard."
                    },
                    modifier = Modifier.testTag("step_paste_key").semantics { liveRegion = LiveRegionMode.Polite },
                    busy = status == SetupStatus.CHECKING,
                    onClick = {
                        val key = clipboardText(context)
                        clipboardEmpty = key == null
                        if (key != null) onPasteKey(key)
                    },
                )
                Text(
                    "Your API key is encrypted on this phone. During walks, audio and recent transcript are sent to Gemini.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }

            Column(
                Modifier.fillMaxWidth().testTag("welcome_secondary"),
                verticalArrangement = Arrangement.spacedBy(ParloSpacing.space2),
            ) {
                if (status != SetupStatus.NO_KEY) {
                    TextButton(
                        onClick = openKeyPage,
                        modifier = Modifier.fillMaxWidth().heightIn(min = ParloSize.targetMin).testTag("step_get_key"),
                    ) {
                        Text("Manage keys in AI Studio", textAlign = TextAlign.Center)
                    }
                }
                Text(
                    "Your tutor helps you find your level. Earbuds are optional.",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                secondaryAction?.invoke()
            }
            DevelopmentBuildNotice()
        }
        if (connected) {
            // A separate sibling reserves real clearance; nothing scrolls underneath the action.
            Surface {
                Button(
                    onClick = onStart,
                    modifier = Modifier.fillMaxWidth().padding(ParloSpacing.space4)
                        .heightIn(min = ParloSize.targetWalk).testTag("start_first_walk"),
                    shape = ParloShape.extraLarge,
                ) {
                    Icon(Icons.AutoMirrored.Rounded.DirectionsWalk, null, Modifier.size(ParloSize.icon))
                    Spacer(Modifier.width(ParloSpacing.space3))
                    Text(
                        "Start your first walk",
                        style = MaterialTheme.typography.titleLarge,
                        textAlign = TextAlign.Center,
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
    }
}

private fun clipboardText(context: Context): String? {
    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    return cm.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.coerceToText(context)?.toString()?.trim()?.takeIf { it.isNotBlank() }
}

internal fun maskKey(key: String): String = if (key.length < 10) "" else key.take(4) + "••••" + key.takeLast(4)
