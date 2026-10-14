package com.parlo.app.widget

import androidx.compose.runtime.Composable
import androidx.glance.GlanceTheme
import androidx.glance.material3.ColorProviders
import com.parlo.app.ui.theme.DarkScheme
import com.parlo.app.ui.theme.LightScheme

/** Same Parlo schemes as the app; light/dark follows the system, dynamic colour when the user enabled it. */
private val ParloWidgetColors = ColorProviders(light = LightScheme, dark = DarkScheme)

@Composable
fun ParloWidgetTheme(dynamicColor: Boolean, content: @Composable () -> Unit) {
    if (dynamicColor) GlanceTheme(content = content) else GlanceTheme(colors = ParloWidgetColors, content = content)
}
