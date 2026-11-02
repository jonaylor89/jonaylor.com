package com.parlo.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.text.font.FontWeight
import com.parlo.app.ui.theme.Parlo
import com.parlo.app.ui.theme.ParloShape
import com.parlo.app.ui.theme.ParloSpacing
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import com.parlo.app.BuildConfig
import com.parlo.app.R

/** Visible even on the welcome screen, where the normal app bar is intentionally hidden. */
@Composable
internal fun DevelopmentBuildNotice(modifier: Modifier = Modifier) {
    if (!BuildConfig.IS_DEVELOPMENT) return
    Surface(
        modifier = modifier.fillMaxWidth().testTag("development_build_notice"),
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = ParloShape.large,
    ) {
        Row(Modifier.padding(ParloSpacing.space3), horizontalArrangement = Arrangement.spacedBy(ParloSpacing.space3), verticalAlignment = Alignment.CenterVertically) {
            // The coral DEV mark appears on the Dev build only, and only as large bold type.
            Surface(color = Parlo.colors.fixed.devBadge, contentColor = Parlo.colors.fixed.onDevBadge, shape = ParloShape.small) {
                Text("DEV", style = MaterialTheme.typography.headlineSmall.copy(fontWeight = FontWeight.ExtraBold), modifier = Modifier.padding(horizontal = 10.dp, vertical = 2.dp))
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(ParloSpacing.space1)) {
                Text("${stringResource(R.string.app_name)} · ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelLarge)
                Text("Developer build. Separate from Parlo, with its own progress and Gemini key.",
                    style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}

@Composable
internal fun BuildDetails() {
    Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.testTag("build_details")) {
        Text("${stringResource(R.string.app_name)} · ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelLarge)
        Text("${BuildConfig.APPLICATION_ID} · ${BuildConfig.BUILD_TYPE}", style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant)
        if (BuildConfig.IS_DEVELOPMENT) {
            Text("Development channel · Data and credentials are not shared with your regular Parlo installation.",
                style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}
