package com.parlo.app.ui.theme

import android.app.UiModeManager
import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.dynamicDarkColorScheme
import androidx.compose.material3.dynamicLightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext

/** Settings → Display → Sunlight contrast. */
enum class ParloContrast(val label: String) {
    /** Follows the system contrast setting, and switches the walk screen to high contrast in bright sunlight. */
    AUTO("Automatic"),
    STANDARD("Standard"),
    /** "Sunlight" (light) and "Night walk" (dark): M3 contrast level 1.0. */
    HIGH("High");

    companion object {
        fun parse(value: String?) = entries.firstOrNull { it.name == value } ?: AUTO
    }
}

private val ParloShapes = Shapes(
    extraSmall = ParloShape.extraSmall,
    small = ParloShape.small,
    medium = ParloShape.medium,
    large = ParloShape.large,
    extraLarge = ParloShape.extraLarge,
)

/** The inputs a nested [ParloTheme] needs to re-theme part of the screen (the walk screen in sunlight). */
private data class ThemeInputs(val dynamicColor: Boolean, val contrast: ParloContrast, val highContrast: Boolean)

private val LocalThemeInputs = staticCompositionLocalOf { ThemeInputs(false, ParloContrast.AUTO, false) }

internal fun schemeFor(dark: Boolean, highContrast: Boolean): ColorScheme = when {
    dark && highContrast -> NightScheme
    dark -> DarkScheme
    highContrast -> SunlightScheme
    else -> LightScheme
}

private fun fixedFor(dark: Boolean, highContrast: Boolean): ParloFixedColors = when {
    dark && highContrast -> NightFixed
    dark -> DarkFixed
    highContrast -> SunlightFixed
    else -> LightFixed
}

/**
 * Parlo's Trail / Sunpath / Persimmon palette, light or dark with the system. [dynamicColor] swaps the
 * Material roles for wallpaper colours on Android 12+ but keeps the tutor's Persimmon (tertiary) and the
 * language tones, so who is speaking stays recognisable.
 */
@Composable
fun ParloTheme(
    dynamicColor: Boolean = false,
    contrast: ParloContrast = ParloContrast.AUTO,
    content: @Composable () -> Unit,
) {
    val context = LocalContext.current
    val high = when (contrast) {
        ParloContrast.HIGH -> true
        ParloContrast.STANDARD -> false
        ParloContrast.AUTO -> remember(context) { systemPrefersHighContrast(context) }
    }
    ProvideParloTheme(dynamicColor, contrast, high, content)
}

@Composable
private fun ProvideParloTheme(dynamicColor: Boolean, contrast: ParloContrast, high: Boolean, content: @Composable () -> Unit) {
    val dark = isSystemInDarkTheme()
    val parlo = schemeFor(dark, high)
    // High contrast always uses Parlo's audited palette: wallpaper colours aren't contrast-checked.
    val scheme = if (dynamicColor && !high && Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val ctx = LocalContext.current
        (if (dark) dynamicDarkColorScheme(ctx) else dynamicLightColorScheme(ctx)).copy(
            tertiary = parlo.tertiary,
            onTertiary = parlo.onTertiary,
            tertiaryContainer = parlo.tertiaryContainer,
            onTertiaryContainer = parlo.onTertiaryContainer,
        )
    } else {
        parlo
    }
    MaterialTheme(colorScheme = scheme, shapes = ParloShapes, typography = ParloTypography) {
        CompositionLocalProvider(
            LocalParloColors provides parloColors(scheme, fixedFor(dark, high), dark),
            LocalParloTextStyles provides ParloTextStyles(),
            LocalThemeInputs provides ThemeInputs(dynamicColor, contrast, high),
            content = content,
        )
    }
}

/**
 * The walk screen is read at arm's length outdoors. With contrast on Automatic it switches to the
 * Sunlight / Night walk theme while the ambient light sensor reads above 10,000 lux (back below 5,000).
 */
@Composable
fun SunlightAwareTheme(content: @Composable () -> Unit) {
    val inputs = LocalThemeInputs.current
    if (inputs.contrast != ParloContrast.AUTO || inputs.highContrast) {
        content()
        return
    }
    val bright = rememberBrightSunlight()
    if (!bright) content() else ProvideParloTheme(inputs.dynamicColor, inputs.contrast, high = true, content = content)
}

@Composable
private fun rememberBrightSunlight(): Boolean {
    val context = LocalContext.current
    var bright by remember { mutableStateOf(false) }
    DisposableEffect(context) {
        val sensors = context.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
        val light = sensors?.getDefaultSensor(Sensor.TYPE_LIGHT)
        val listener = object : SensorEventListener {
            override fun onSensorChanged(event: SensorEvent) {
                val lux = event.values.firstOrNull() ?: return
                bright = if (bright) lux > SUNLIGHT_EXIT_LUX else lux > SUNLIGHT_ENTER_LUX
            }
            override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
        }
        if (light != null) sensors.registerListener(listener, light, SensorManager.SENSOR_DELAY_NORMAL)
        onDispose { sensors?.unregisterListener(listener) }
    }
    return bright
}

private const val SUNLIGHT_ENTER_LUX = 10_000f
private const val SUNLIGHT_EXIT_LUX = 5_000f

/** Android 14+ exposes the system contrast slider; "medium" or above maps to Parlo's high-contrast themes. */
private fun systemPrefersHighContrast(context: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.UPSIDE_DOWN_CAKE) return false
    val ui = context.getSystemService(Context.UI_MODE_SERVICE) as? UiModeManager ?: return false
    return runCatching { ui.contrast >= 0.5f }.getOrDefault(false)
}
