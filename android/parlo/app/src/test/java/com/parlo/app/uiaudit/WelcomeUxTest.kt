package com.parlo.app.uiaudit

import android.app.Application
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertHeightIsAtLeast
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import com.github.takahirom.roborazzi.captureRoboImage
import com.parlo.app.ui.SetupStatus
import com.parlo.app.ui.onboarding.WelcomeScreen
import com.parlo.app.ui.theme.ParloTheme
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(application = Application::class, sdk = [34], qualifiers = "w320dp-h480dp-mdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class WelcomeUxTest {
    @get:Rule val rule = createComposeRule()

    private fun showWelcome(
        status: SetupStatus,
        onPasteKey: (String) -> Unit = {},
        onStart: () -> Unit = {},
        onRetry: () -> Unit = {},
        secondaryAction: (@Composable () -> Unit)? = null,
    ) {
        rule.setContent {
            CompositionLocalProvider(LocalDensity provides Density(LocalDensity.current.density, fontScale = 2f)) {
                ParloTheme {
                    Surface(Modifier.fillMaxSize()) {
                        WelcomeScreen(
                            status = status,
                            maskedKey = if (status == SetupStatus.NO_KEY) "" else "AIza••••x3fQ",
                            onPasteKey = onPasteKey,
                            onStart = onStart,
                            // Simulate padding already supplied by the outer MainScreen Scaffold.
                            modifier = Modifier.padding(top = 24.dp, bottom = 24.dp),
                            languageChoice = {
                                Column(Modifier.testTag("test_language_choice")) {
                                    Text("Which language today?")
                                    TextButton(onClick = {}) { Text("Spanish · Change language") }
                                }
                            },
                            onRetry = onRetry,
                            secondaryAction = secondaryAction,
                        )
                    }
                }
            }
        }
    }

    @Test fun `ready start stays visible at large text without scrolling and fires once`() {
        var starts = 0
        showWelcome(SetupStatus.READY, onStart = { starts++ }, secondaryAction = {
            TextButton(onClick = {}, modifier = Modifier.testTag("test_restore")) { Text("Restore progress") }
        })

        rule.onNodeWithTag("welcome").assertIsDisplayed()
        rule.onAllNodesWithTag("start_first_walk").assertCountEquals(1)
        rule.onAllNodesWithText("Start your first walk").assertCountEquals(1)
        val start = rule.onNodeWithTag("start_first_walk")
        start.assertIsDisplayed().assertIsEnabled().assertHeightIsAtLeast(72.dp)
        rule.onNodeWithText("Start your first walk", useUnmergedTree = true).assertIsDisplayed()
        val initialBounds = start.fetchSemanticsNode().boundsInRoot
        val welcomeBounds = rule.onNodeWithTag("welcome").fetchSemanticsNode().boundsInRoot
        assertTrue("Start must stay inside the inset content area", initialBounds.bottom <= welcomeBounds.bottom)
        assertTrue("Start must fit the narrow screen", initialBounds.right <= welcomeBounds.right)
        rule.onRoot().captureRoboImage("build/uiaudit/60_welcome_ready_large_text.png")
        start.performClick()
        assertEquals(1, starts)

        rule.onNodeWithTag("test_restore").performScrollTo().assertIsDisplayed()
        start.assertIsDisplayed()
        assertEquals("Scrolling must not move the start action", initialBounds, start.fetchSemanticsNode().boundsInRoot)
    }

    @Test fun `offline retry uses saved key rather than paste callback`() {
        var retries = 0
        var pastes = 0
        showWelcome(SetupStatus.OFFLINE, onRetry = { retries++ }, onPasteKey = { pastes++ })

        rule.onNodeWithTag("welcome_content").performScrollToNode(hasTestTag("retry_connection"))
        rule.onNodeWithText("Try again").assertIsDisplayed()
        rule.onNodeWithTag("retry_connection").assertIsEnabled().performClick()
        assertEquals(1, retries)
        assertEquals(0, pastes)
        rule.onNodeWithTag("step_paste_key").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Replace key").assertIsDisplayed()
        rule.onNodeWithTag("start_first_walk").assertDoesNotExist()
    }

    @Test fun `no model exposes refresh models and routes it to retry`() {
        var refreshes = 0
        var pastes = 0
        showWelcome(SetupStatus.NO_MODEL, onRetry = { refreshes++ }, onPasteKey = { pastes++ })

        rule.onNodeWithTag("retry_connection").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Refresh models").assertIsDisplayed().performClick()
        assertEquals(1, refreshes)
        assertEquals(0, pastes)
    }

    @Test fun `secondary restore follows connection setup and remains reachable`() {
        var restores = 0
        showWelcome(SetupStatus.NO_KEY, secondaryAction = {
            TextButton(onClick = { restores++ }, modifier = Modifier.testTag("test_restore")) {
                Text("Already learning with Parlo? Restore progress")
            }
        })

        rule.onNodeWithTag("step_get_key").assertExists()
        rule.onNodeWithTag("step_paste_key").assertExists()
        rule.onNodeWithTag("test_restore").performScrollTo().assertIsDisplayed().performClick()
        assertEquals(1, restores)
        val language = rule.onNodeWithTag("test_language_choice").fetchSemanticsNode()
        val connection = rule.onNodeWithTag("welcome_connection").fetchSemanticsNode()
        val secondary = rule.onNodeWithTag("welcome_secondary").fetchSemanticsNode()
        assertTrue("Language comes before connection", language.positionInRoot.y + language.size.height <= connection.positionInRoot.y)
        assertTrue("Secondary content comes after connection", connection.positionInRoot.y + connection.size.height <= secondary.positionInRoot.y)
    }

    @Test fun `empty clipboard gives visible feedback without submitting a key`() {
        val context = ApplicationProvider.getApplicationContext<Application>()
        (context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager).clearPrimaryClip()
        var pastes = 0
        showWelcome(SetupStatus.NO_KEY, onPasteKey = { pastes++ })

        rule.onNodeWithTag("step_paste_key").performScrollTo().performClick()
        rule.onNodeWithText("Clipboard is empty").assertIsDisplayed()
        rule.onNodeWithTag("step_paste_key").performScrollTo().assertIsDisplayed()
        rule.onNodeWithText("Copy your Gemini key, then tap here again.").assertIsDisplayed()
        assertEquals(0, pastes)
    }
}
