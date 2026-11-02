package com.parlo.app.ui.components

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
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
        color = MaterialTheme.colorScheme.tertiaryContainer,
        shape = RoundedCornerShape(16.dp),
    ) {
        Column(Modifier.padding(12.dp), verticalArrangement = Arrangement.spacedBy(4.dp)) {
            Text("${stringResource(R.string.app_name)} · ${BuildConfig.VERSION_NAME}", style = MaterialTheme.typography.labelLarge)
            Text("Developer build. Separate from Parlo, with its own progress and Gemini key.",
                style = MaterialTheme.typography.bodySmall)
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
