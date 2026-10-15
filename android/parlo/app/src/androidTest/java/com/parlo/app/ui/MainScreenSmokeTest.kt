package com.parlo.app.ui

import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.parlo.app.MainActivity
import com.parlo.app.ParloApp
import com.parlo.app.model.CorrectionStyle
import com.parlo.app.model.Level
import com.parlo.app.model.SessionConfig
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Launches the real activity (no API key configured) and walks the main screen.
 * Nothing here talks to Gemini.
 */
@RunWith(AndroidJUnit4::class)
class MainScreenSmokeTest {
    @get:Rule val rule = createEmptyComposeRule()

    private val app get() = ApplicationProvider.getApplicationContext<ParloApp>()
    private val sessions get() = ParloApp.container(app).sessions
    private var scenario: ActivityScenario<MainActivity>? = null

    private fun launch() {
        scenario?.close()
        scenario = ActivityScenario.launch(MainActivity::class.java)
        rule.waitForIdle()
    }

    @Before
    fun resetToFirstRun() = runBlocking {
        sessions.observeSessions().first().forEach { sessions.deleteSession(it.id) }
        launch()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Learn a language on your walk.")).fetchSemanticsNodes().isNotEmpty() }
    }

    @After
    fun closeActivity() {
        scenario?.close()
    }

    private fun becomeReturningUser() = runBlocking {
        val started = System.currentTimeMillis() - 60_000
        val id = sessions.startSession(SessionConfig(), started)
        sessions.finishSession(id, started + 30_000, null, SessionConfig())
        check(sessions.observeSessions().first().any { it.endedAt != null })
        launch()
        rule.waitUntil(10_000) { rule.onAllNodesWithTag("next_walk").fetchSemanticsNodes().isNotEmpty() }
    }

    private fun openWalkConfig() {
        becomeReturningUser()
        rule.onNodeWithContentDescription("Walk settings").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Today's walk")).fetchSemanticsNodes().isNotEmpty() }
    }

    private fun openLanguagePicker() {
        openWalkConfig()
        rule.onNodeWithTag("language_card").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Search languages, accents, places")).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun withoutAKeyFirstRunShowsVoiceOnboardingInsteadOfTheOldMainScreen() {
        rule.onNodeWithTag("welcome").assertIsDisplayed()
        rule.onNodeWithText("Learn a language on your walk.").assertIsDisplayed()
        rule.onNodeWithText("Paste your key").assertIsDisplayed()
        rule.onNodeWithText("Start your first walk").assertIsDisplayed()
        rule.onAllNodesWithText("Finish setup").assertCountEquals(0)
        rule.onAllNodesWithText("Start Walk Session").assertCountEquals(0)
        rule.onAllNodes(hasContentDescription("Vocabulary")).assertCountEquals(0)
        rule.onAllNodesWithText("Scenario").assertCountEquals(0)
    }

    @Test
    fun walkConfigSheetHoldsLevelAndCorrections() {
        openWalkConfig()
        Level.entries.forEach { rule.onAllNodesWithText(it.shortLabel).onFirst().assertIsDisplayed() }
        CorrectionStyle.entries.forEach { rule.onAllNodesWithText(it.label).onFirst().assertIsDisplayed() }
        rule.onAllNodesWithText("Scenario").assertCountEquals(0)
        rule.onNodeWithText(Level.SUPER_BEGINNER.shortLabel).performClick()
        rule.onAllNodesWithText(Level.SUPER_BEGINNER.description, substring = true).onFirst().assertIsDisplayed()
        rule.onNodeWithText(Level.ADVANCED.shortLabel).performClick()
        rule.onAllNodesWithText(Level.ADVANCED.description, substring = true).onFirst().assertIsDisplayed()
        rule.onAllNodesWithText(Level.SUPER_BEGINNER.description, substring = true).assertCountEquals(0)
        rule.onNodeWithText("Done").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Today's walk")).fetchSemanticsNodes().isEmpty() }
        // Summary card reflects the change.
        rule.onNodeWithText(Level.ADVANCED.label, substring = true).assertIsDisplayed()
    }

    @Test
    fun finishSetupOpensSettingsWithKeyFieldAndFreeKeyLink() {
        becomeReturningUser()
        rule.onNodeWithText("Add key").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Gemini API key")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Gemini API key").assertIsDisplayed()
        rule.onNodeWithText("Get a free key").assertIsDisplayed()
        rule.onNodeWithText("Match wallpaper colours").assertExists()
        rule.onAllNodesWithText("bidiGenerateContent", substring = true).assertCountEquals(0)
    }

    @Test
    fun languagePickerOpensOnLanguagesWithCurrentPinned() {
        openLanguagePicker()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("CURRENT")).fetchSemanticsNodes().isNotEmpty() }
        rule.onAllNodes(hasContentDescription("Back to languages")).assertCountEquals(0)
        rule.onNodeWithTag("language_search").performTextInput("Québec")
        rule.onNodeWithText("Québec French (Montréal)").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Québec French (Montréal)", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Français", substring = true).assertIsDisplayed()
    }

    @Test
    fun languagePickerAcceptsCustomAccent() {
        openLanguagePicker()
        rule.onAllNodesWithText("Spanish").onFirst().performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Accent")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithTag("language_search").performTextInput("Rural Extremaduran Spanish")
        rule.onNodeWithTag("custom_row").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Rural Extremaduran Spanish", substring = true)).fetchSemanticsNodes().isNotEmpty() }
    }

    @Test
    fun vocabAndHistoryScreensAreReachable() {
        becomeReturningUser()
        rule.onNodeWithContentDescription("Vocabulary").performClick()
        rule.onNodeWithText("Flashcards").assertIsDisplayed()
        rule.onNodeWithText("Vocabulary").assertIsDisplayed()
        scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() }
        rule.onNodeWithContentDescription("Session history").performClick()
        rule.onNodeWithText("Past walks").assertIsDisplayed()
    }
}
