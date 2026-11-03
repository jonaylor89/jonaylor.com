package com.parlo.app.uiaudit

import android.app.Application
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Surface
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.unit.Density
import androidx.compose.ui.unit.dp
import com.github.takahirom.roborazzi.captureRoboImage
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.model.SessionConfig
import com.parlo.app.ui.LastWalk
import com.parlo.app.ui.MainUiState
import com.parlo.app.ui.components.WalkFab
import com.parlo.app.ui.components.WalkFabState
import com.parlo.app.ui.main.HomeContent
import com.parlo.app.ui.main.VocabularyWordSheet
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
class HomeLayoutTest {
    @get:Rule val rule = createComposeRule()
    private val word = VocabEntity(id = 4, word = "madrugar", translation = "to get up early", exampleSentence = "Mañana tengo que madrugar.", language = "Spanish", savedAt = 1)
    private val walk = LastWalk(1, "Spanish", "Castilian Spanish (Madrid)", "INTERMEDIATE", 720_000, listOf(word),
        "Talk about a past shopping trip.", "Shopping at the market", "Buy fruit and ask a follow-up question.", false)

    private fun home(fontScale: Float = 1f, onSettings: () -> Unit = {}, onStart: () -> Unit = {},
        onWord: (VocabEntity) -> Unit = {}) {
        rule.setContent {
            val density = LocalDensity.current
            var config by androidx.compose.runtime.remember { mutableStateOf(SessionConfig()) }
            ParloTheme {
                CompositionLocalProvider(LocalDensity provides Density(density.density, fontScale)) {
                    Scaffold(bottomBar = {
                        Surface(color = MaterialTheme.colorScheme.surface) {
                            Box(Modifier.padding(16.dp)) {
                                WalkFab(WalkFabState.READY, config.language, onStart,
                                    Modifier.fillMaxWidth().testTag("start_walk"))
                            }
                        }
                    }) { padding ->
                        HomeContent(
                            ui = MainUiState(config = config, languages = listOf(SessionConfig(language = "Japanese")),
                                lastWalk = walk, walkCount = 12, lastPractisedAt = 1000, goal = "Feel comfortable eating out"),
                            onSelectLanguage = { config = config.copy(language = it) }, onAddLanguage = {},
                            onWalkSettings = onSettings, onModeSelected = { config = config.copy(followPlan = it) },
                            onWordSelected = onWord, onOpenJourney = {}, onOpenVocab = {}, onOpenHistory = {},
                            modifier = Modifier.padding(padding),
                        )
                    }
                }
            }
        }
    }

    @Test fun `home prioritises language and one walk instead of competing settings`() {
        var settings = false
        var starts = 0
        home(onSettings = { settings = true }, onStart = { starts++ })
        rule.onNodeWithText("Which language today?").assertIsDisplayed()
        rule.onNodeWithTag("next_walk").assertIsDisplayed()
        rule.onNodeWithText("Shopping at the market").assertExists()
        rule.onNodeWithText("Make it harder").assertDoesNotExist()
        rule.onNodeWithText("Intermediate").assertDoesNotExist()
        rule.onNodeWithText("Castilian Spanish (Madrid)").assertDoesNotExist()
        rule.onRoot().captureRoboImage("build/uiaudit/60_home_ready.png")
        rule.onNodeWithText("Just chat").performScrollTo().performClick().assertIsSelected()
        assertEquals(0, starts) // Choosing a mode is not a misleading second Start button.
        rule.onNodeWithTag("start_walk").performClick()
        assertEquals(1, starts)
        rule.onNodeWithContentDescription("Walk settings").performScrollTo().performClick()
        assertTrue(settings)
    }

    @Test @Config(qualifiers = "w320dp-h915dp-xxhdpi")
    fun `large text stacks modes and measured start bar never covers the journal`() {
        home(fontScale = 2f)
        rule.onNodeWithTag("practice_mode").performScrollTo()
        val guided = rule.onNodeWithText("Guided practice").fetchSemanticsNode().boundsInRoot
        val chat = rule.onNodeWithText("Just chat").fetchSemanticsNode().boundsInRoot
        assertTrue("Long mode labels should stack, not clip", guided.bottom <= chat.top)
        rule.onNodeWithTag("start_walk").assertIsDisplayed()
        rule.onNodeWithTag("learning_journal").performScrollTo().assertIsDisplayed()
        val journal = rule.onNodeWithTag("learning_journal").fetchSemanticsNode().boundsInRoot
        val start = rule.onNodeWithTag("start_walk").fetchSemanticsNode().boundsInRoot
        assertTrue("Content must stop above the actual Start bar", journal.bottom <= start.top)
        rule.onRoot().captureRoboImage("build/uiaudit/61_home_large_text.png")
    }

    @Test fun `saved word taps explore instead of invoking deletion`() {
        var explored: VocabEntity? = null
        home(onWord = { explored = it })
        rule.onNodeWithTag("saved_word_4").performScrollTo().performClick()
        assertEquals(word, explored)
        rule.onNodeWithContentDescription("Drop madrugar").assertDoesNotExist()
    }

    @Test fun `word details put meaning before explicit removal`() {
        var removed = false
        rule.setContent {
            ParloTheme { VocabularyWordSheet(word, {}, {}, { removed = true }) }
        }
        rule.onNodeWithText("to get up early").assertIsDisplayed()
        rule.onNodeWithText("Mañana tengo que madrugar.").assertExists()
        assertFalse(removed)
        rule.onNodeWithText("Remove saved word").performClick()
        assertTrue(removed)
    }
}
