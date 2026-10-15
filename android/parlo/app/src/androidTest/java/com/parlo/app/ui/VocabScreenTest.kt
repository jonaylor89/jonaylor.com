package com.parlo.app.ui

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasText
import androidx.compose.ui.test.hasContentDescription
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.parlo.app.ParloApp
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.data.db.VocabSource
import com.parlo.app.data.db.VocabStatus
import com.parlo.app.ui.theme.ParloTheme
import com.parlo.app.ui.vocab.VocabListScreen
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith

/** Renders the Vocab screen against the app's real Room store and exercises the Suggested tray. */
@RunWith(AndroidJUnit4::class)
class VocabScreenTest {
    @get:Rule val rule = createComposeRule()

    private val repo = ParloApp.container(ApplicationProvider.getApplicationContext()).vocab
    private val language = "Testlang-${System.nanoTime()}"

    @Before
    fun seed() = runBlocking<Unit> {
        repo.save("perro", "dog", "El perro corre.", language, sessionId = null)
        val now = System.currentTimeMillis()
        repo.restore(
            listOf(
                VocabEntity(
                    word = "la cuenta", translation = "the bill", exampleSentence = "¿Me trae la cuenta?",
                    language = language, savedAt = now, source = VocabSource.TUTOR.name,
                    status = VocabStatus.SUGGESTED.name, reason = "You asked how to say it",
                ),
                VocabEntity(
                    word = "zumo", translation = "juice", exampleSentence = "", language = language,
                    savedAt = now + 1, source = VocabSource.MINED.name,
                    status = VocabStatus.SUGGESTED.name, reason = "Found in your transcript",
                ),
            ),
        )
    }

    @After
    fun cleanup() = runBlocking<Unit> {
        repo.observeAll().first().filter { it.language == language }.forEach { repo.delete(it) }
    }

    private fun show() = rule.setContent { ParloTheme { VocabListScreen(onBack = {}) } }

    @Test
    fun suggestionsAreSeparatedFromSavedWordsAndCanBeKeptOrDismissed() {
        show()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("la cuenta")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Suggested · 2", substring = true).assertIsDisplayed()
        rule.onNodeWithText("You asked how to say it", substring = true).assertIsDisplayed()
        rule.onNodeWithContentDescription("Suggested la cuenta").assertIsDisplayed()
        rule.onNodeWithContentDescription("Suggested perro").assertDoesNotExist()

        rule.onNodeWithContentDescription("Keep la cuenta").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Suggested · 1", substring = true)).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("Suggested la cuenta").assertDoesNotExist()
        rule.onNodeWithText("la cuenta").assertIsDisplayed() // now in the saved list
        rule.onNodeWithText("$language · 2").assertIsDisplayed()

        rule.onNodeWithContentDescription("Skip zumo").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("zumo")).fetchSemanticsNodes().isEmpty() }
        rule.onNodeWithText("Suggested", substring = true).assertDoesNotExist()
        val rows = runBlocking { repo.observeAll().first().filter { it.language == language } }
        assert(rows.map { it.word }.toSet() == setOf("perro", "la cuenta")) { rows.toString() }
        assert(rows.none { it.isSuggested })
    }

    @Test
    fun skippingASuggestionCanBeUndone() {
        show()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("zumo")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("Skip zumo").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Undo")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithContentDescription("Suggested zumo").assertDoesNotExist()
        rule.onNodeWithText("Undo").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasContentDescription("Suggested zumo")).fetchSemanticsNodes().isNotEmpty() }
        val rows = runBlocking { repo.observeAll().first().filter { it.language == language } }
        assert(rows.any { it.word == "zumo" && it.isSuggested }) { rows.toString() }
    }

    @Test
    fun keepAllPromotesEverySuggestion() {
        show()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Keep all")).fetchSemanticsNodes().isNotEmpty() }
        rule.onNodeWithText("Keep all").performClick()
        rule.waitUntil(5_000) { rule.onAllNodes(hasText("Keep all")).fetchSemanticsNodes().isEmpty() }
        rule.onNodeWithText("$language · 3").assertIsDisplayed()
    }
}
