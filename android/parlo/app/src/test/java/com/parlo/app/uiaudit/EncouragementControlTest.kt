package com.parlo.app.uiaudit

import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.ProgressBarRangeInfo
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performSemanticsAction
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.test.swipe
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import com.parlo.app.model.Encouragement
import com.parlo.app.ui.settings.EncouragementControl
import com.parlo.app.ui.theme.ParloTheme
import org.junit.Assert.*
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w412dp-h915dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class EncouragementControlTest {
    @get:Rule val rule = createComposeRule()
    private fun render(fontScale: Float = 1f, onChange: (Encouragement) -> Unit) {
        rule.setContent {
            var value by remember { mutableStateOf(Encouragement.LOW_KEY) }
            val density = LocalDensity.current
            ParloTheme {
                CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                    Surface(Modifier.fillMaxSize()) {
                        Column(Modifier.verticalScroll(rememberScrollState()).padding(20.dp)) {
                            EncouragementControl(value) { value = it; onChange(it) }
                        }
                    }
                }
            }
        }
    }

    @Test fun `dial exposes five accessible positions and applies the selected tone`() {
        val changes = mutableListOf<Encouragement>()
        render(onChange = { changes += it })
        val slider = rule.onNodeWithTag("encouragement_slider")
        slider.assert(SemanticsMatcher.expectValue(SemanticsProperties.ProgressBarRangeInfo, ProgressBarRangeInfo(1f, 0f..4f, 3)))
        slider.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Low-key"))
        rule.onNodeWithText("“${Encouragement.LOW_KEY.example}”").assertExists()
        rule.onRoot().captureRoboImage("build/uiaudit/70_encouragement.png")
        slider.performSemanticsAction(SemanticsActions.SetProgress) { it(0f) }
        assertEquals(listOf(Encouragement.MATTER_OF_FACT), changes)
        slider.assert(SemanticsMatcher.expectValue(SemanticsProperties.StateDescription, "Matter-of-fact"))
        rule.onNodeWithText(Encouragement.MATTER_OF_FACT.description).assertExists()
        slider.performSemanticsAction(SemanticsActions.SetProgress) { it(4f) }
        assertEquals(Encouragement.VERY_ENCOURAGING, changes.last())
        assertEquals(2, changes.size)
    }

    @Test fun `dragging commits once rather than changing live instructions at each tick`() {
        val changes = mutableListOf<Encouragement>()
        render(onChange = { changes += it })
        rule.onNodeWithTag("encouragement_slider").performTouchInput {
            swipe(start = Offset(width * 0.25f, center.y), end = Offset(0f, center.y), durationMillis = 500)
        }
        rule.waitForIdle()
        assertEquals(listOf(Encouragement.MATTER_OF_FACT), changes)
    }

    @Test @Config(qualifiers = "w320dp-h915dp-xxhdpi")
    fun `large text control and descriptions remain reachable`() {
        render(fontScale = 2f, onChange = {})
        rule.onNodeWithTag("encouragement_slider").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Always adult-to-adult, in every language. Changes tone, not difficulty or corrections. The tutor still leads at every setting.")
            .performScrollTo().assertIsDisplayed()
        rule.onRoot().captureRoboImage("build/uiaudit/71_encouragement_large_text.png")
    }
}
