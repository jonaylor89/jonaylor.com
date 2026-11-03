package com.parlo.app.uiaudit

import android.app.Application
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import com.parlo.app.data.db.LearningEpisodeEntity
import com.parlo.app.model.SessionConfig
import com.parlo.app.ui.MainUiState
import com.parlo.app.ui.main.JourneyStatus
import com.parlo.app.ui.main.LanguageJourneyPicker
import com.parlo.app.ui.theme.ParloTheme
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34], application = Application::class, qualifiers = "w412dp-h915dp-xxhdpi")
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LanguageJourneyTest {
    @get:Rule val rule = createComposeRule()

    @Test fun `home asks which language and allows a one-tap switch`() {
        val config = mutableStateOf(SessionConfig(language = "Japanese"))
        var more = false
        rule.setContent {
            ParloTheme { Surface(Modifier.fillMaxSize()) {
                Column(Modifier.padding(16.dp)) {
                    LanguageJourneyPicker(config.value, listOf(SessionConfig(language = "Portuguese"), SessionConfig(language = "Arabic")),
                        { config.value = config.value.copy(language = it) }, { more = true })
                    JourneyStatus(MainUiState(config = config.value, goal = "Talk with family", walkCount = 12,
                        lastPractisedAt = 1_700_000_000_000,
                        learningEpisodes = listOf(LearningEpisodeEntity(id = 1, sessionId = 1, language = "japanese", fromTurnId = 1,
                            throughTurnId = 2, occurredAt = 1_700_000_000_000, summary = "Family", demonstrated = "Asked a follow-up question independently."))), {})
                }
            } }
        }
        rule.onNodeWithText("Which language today?").assertExists()
        rule.onNodeWithTag("journey_japanese").assertIsSelected()
        rule.onNodeWithText("Portuguese").assertExists()
        rule.onNodeWithText("Arabic").assertExists()
        rule.onRoot().captureRoboImage("build/uiaudit/40_language_journeys.png")
        rule.onNodeWithTag("journey_portuguese").performClick().assertIsSelected().assertIsDisplayed()
        rule.onNodeWithText("Add language").performClick()
        assertTrue(more)
    }

    @Test fun `single language home does not suggest an arbitrary preset set`() {
        rule.setContent {
            ParloTheme {
                LanguageJourneyPicker(SessionConfig(language = "Swahili"), emptyList(), {}, {})
            }
        }
        rule.onNodeWithTag("journey_swahili").assertIsSelected()
        for (language in listOf("german", "hungarian", "spanish", "catalan")) {
            rule.onNodeWithTag("journey_$language").assertDoesNotExist()
        }
        rule.onNodeWithText("Add language").assertExists()
        rule.onNodeWithText("Which language today?").assertExists()
    }

    @Test fun `multiple accents do not duplicate a language in the switcher`() {
        rule.setContent {
            ParloTheme {
                LanguageJourneyPicker(SessionConfig(language = "Portuguese"), listOf(
                    SessionConfig(language = "Portuguese", dialect = "European Portuguese"),
                    SessionConfig(language = "portuguese", dialect = "Brazilian Portuguese"),
                    SessionConfig(language = "Arabic"),
                ), {}, {})
            }
        }
        rule.onAllNodesWithTag("journey_portuguese").assertCountEquals(1)
        rule.onNodeWithTag("journey_arabic").assertExists()
    }

    @Test fun `larger personal language collections remain reachable and selected language stays visible`() {
        val languages = (1..10).map { SessionConfig(language = "Language $it") }
        val config = mutableStateOf(languages.first())
        rule.setContent {
            ParloTheme {
                LanguageJourneyPicker(config.value, languages, { config.value = config.value.copy(language = it) }, {})
            }
        }
        rule.onNodeWithTag("your_languages").performScrollToNode(hasTestTag("journey_language 10"))
        rule.onNodeWithTag("journey_language 10").performClick()
        rule.onNodeWithTag("journey_language 10").assertIsSelected().assertIsDisplayed()
        rule.onNodeWithText("Add language").assertIsDisplayed()
    }
}
