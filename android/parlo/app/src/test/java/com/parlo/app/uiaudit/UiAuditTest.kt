package com.parlo.app.uiaudit

import androidx.compose.ui.test.ExperimentalTestApi
import android.Manifest
import android.content.ComponentName
import androidx.compose.ui.test.junit4.createEmptyComposeRule
import androidx.test.core.app.ActivityScenario
import androidx.test.core.app.ApplicationProvider
import com.parlo.app.service.LiveSessionService
import org.junit.Before
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithContentDescription
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.compose.ui.test.performTextClearance
import androidx.compose.ui.test.performTextInput
import com.github.takahirom.roborazzi.ExperimentalRoborazziApi
import com.github.takahirom.roborazzi.captureScreenRoboImage
import com.parlo.app.MainActivity
import com.parlo.app.ParloApp
import com.parlo.app.data.VocabCapture
import com.parlo.app.data.db.VocabSource
import com.parlo.app.model.Level
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.Speaker
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode
import java.io.File

/** Opt-in UX audit: renders the real MainActivity (real Gemini discovery) and screenshots each state. */
@RunWith(KeystoreRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h915dp-xxhdpi")
@OptIn(ExperimentalRoborazziApi::class, ExperimentalTestApi::class)
class UiAuditTest {
    @get:Rule val rule = createEmptyComposeRule()
    private val key = System.getenv("GEMINI_API_KEY").orEmpty()
    private val out = File("build/ui-audit").apply { mkdirs() }
    private val app get() = ApplicationProvider.getApplicationContext<ParloApp>()
    private val container get() = ParloApp.container(app)
    private var scenario: ActivityScenario<MainActivity>? = null

    /** Binds the real LiveSessionService so the UI drives a real Gemini Live session. */
    @Before fun bindRealService() {
        val intent = LiveSessionService.bindIntent(app)
        val svc = Robolectric.buildService(LiveSessionService::class.java, intent).create().get()
        shadowOf(app).setComponentNameAndServiceForBindServiceForIntent(intent, ComponentName(app, LiveSessionService::class.java), svc.onBind(intent))
    }

    private fun launch() { scenario = ActivityScenario.launch(MainActivity::class.java); rule.waitForIdle() }
    private fun back() { scenario!!.onActivity { it.onBackPressedDispatcher.onBackPressed() } }

    private fun shot(name: String) {
        rule.waitForIdle()
        captureScreenRoboImage(File(out, "$name.png").path)
    }

    private fun has(t: String) = rule.onAllNodesWithText(t, substring = true, useUnmergedTree = true).fetchSemanticsNodes().isNotEmpty()
    init { org.robolectric.shadows.ShadowLog.stream = System.out }

    private fun waitText(t: String, ms: Long = 40_000) = rule.waitUntil(ms) { has(t) }
    private fun setKey(k: String) { container.settings.setApiKey(k); rule.waitForIdle() }

    @Test fun a_first_run_and_settings() {
        launch()
        shot("01_welcome")
        assumeTrue(key.isNotBlank())
        app.getSystemService(android.content.ClipboardManager::class.java)
            .setPrimaryClip(android.content.ClipData.newPlainText("key", key))
        rule.onNodeWithTag("step_paste_key").performClick()
        waitText("Connected")
        shot("02_welcome_connected")
    }

    @Test fun b_ready_walk_config_language_picker() {
        assumeTrue(key.isNotBlank())
        setKey(key)
        launch()
        seedReturning(); waitText("Start walk")
        shot("05_main_ready")
        rule.onNodeWithContentDescription("Walk settings").performClick()
        shot("06_walk_config_sheet")
        rule.onNodeWithContentDescription("Change language and accent").performClick()
        shot("07_language_picker")
        rule.onNodeWithTag("language_search").performTextInput("kansai")
        shot("08_search_kansai")
        rule.onNodeWithTag("language_search").performTextClearance()
        rule.onNodeWithTag("language_search").performTextInput("Klingon")
        shot("09_search_custom")
    }

    @Test fun c_start_permission_rationale() {
        assumeTrue(key.isNotBlank())
        setKey(key)
        launch()
        seedReturning(); waitText("Start walk")
        rule.onNodeWithTag("start_walk").performClick()
        shot("10_permission_rationale")
    }

    @Test fun d_key_revoked_after_working() {
        assumeTrue(key.isNotBlank())
        setKey(key)
        launch()
        seedReturning(); waitText("Start walk")
        setKey("AIzaSyD-invalid-key-for-parlo-ux-audit00")
        val flagged = runCatching { waitText("didn't work", 20_000) }.isSuccess
        println("UIAUDIT revoked-key flagged on main screen: $flagged")
        shot("11_main_after_key_revoked")
        rule.onNodeWithContentDescription("Settings").performClick()
        shot("12_settings_after_key_revoked")
    }

    @Test fun e_bad_key_fresh() {
        setKey("AIzaSyD-invalid-key-for-parlo-ux-audit00")
        launch()
        val flagged = runCatching { waitText("didn't work", 30_000) }.isSuccess
        println("UIAUDIT fresh bad key flagged: $flagged")
        shot("13_main_bad_key")
    }

    @Test fun f_vocab_history_from_real_walk() {
        seedRealWalk()
        launch()
        if (key.isNotBlank()) { setKey(key); runCatching { seedReturning(); waitText("Start walk") } }
        shot("14_main_home_after_walk")
        rule.onNodeWithContentDescription("Vocabulary").performClick()
        shot("15_vocab")
        rule.onNodeWithText("Flashcards").performClick()
        shot("16_vocab_flashcards")
        back()
        rule.onNodeWithContentDescription("Session history").performClick()
        shot("17_history")
        rule.onAllNodesWithText("Beginner", substring = true)[0].performClick()
        shot("18_session_detail")
    }

    @Test fun h_live_walk_through_ui() {
        assumeTrue(key.isNotBlank())
        shadowOf(app).grantPermissions(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS, Manifest.permission.BLUETOOTH_CONNECT)
        setKey(key)
        launch()
        seedReturning(); waitText("Start walk")
        rule.onNodeWithTag("start_walk").performClick()
        shot("20_walk_connecting")
        rule.waitUntil(30_000) { rule.onAllNodesWithTag("walk_screen").fetchSemanticsNodes().isNotEmpty() }
        shot("21_walk_connected")
        val t0 = System.currentTimeMillis()
        val greeted = runCatching { waitText("Show transcript", 25_000) }.isSuccess
        println("UIAUDIT tutor greeted within 25s of connect: $greeted (${System.currentTimeMillis() - t0}ms)")
        shot("22_walk_after_25s")
        rule.onNodeWithContentDescription("Mute").performClick()
        shot("23_walk_muted")
        rule.onNodeWithContentDescription("Unmute").performClick()
        rule.onNodeWithContentDescription("End").performClick()
        shot("24_walk_ending")
        val ended = runCatching { waitText("Start walk", 90_000) }.isSuccess
        println("UIAUDIT walk ended back to idle: $ended")
        shot("25_after_walk")
    }

    @Test @Config(qualifiers = "+night")
    fun g_dark_ready() {
        assumeTrue(key.isNotBlank())
        setKey(key)
        launch()
        seedReturning(); waitText("Start walk")
        shot("19_main_ready_dark")
    }

    @Test fun i_post_walk_recap_and_next_walk() {
        seedReviewedWalk()
        launch()
        if (key.isNotBlank()) { setKey(key); runCatching { waitText("Shopping at the market") } }
        shot("26_last_walk_recap")
        rule.onNodeWithContentDescription("Drop madrugar").performClick()
        shot("27_word_dropped_undo")
    }

    @Test @Config(qualifiers = "+night")
    fun j_post_walk_recap_dark() {
        seedReviewedWalk()
        launch()
        if (key.isNotBlank()) { setKey(key); runCatching { waitText("Shopping at the market") } }
        shot("28_last_walk_recap_dark")
    }

    /** Any finished walk means the user is past onboarding. */
    private fun seedReturning() = runBlocking {
        if (container.sessions.observeSessions().first().any { it.endedAt != null }) return@runBlocking
        val start = System.currentTimeMillis() - 60 * 60_000
        val id = container.sessions.startSession(SessionConfig(), start)
        container.sessions.finishSession(id, start + 5 * 60_000, null, SessionConfig())
        container.sessions.markMined(id)
        rule.waitForIdle()
    }

    private fun seedReviewedWalk() = runBlocking {
        val c = container
        val start = System.currentTimeMillis() - 30 * 60_000
        val cfg = SessionConfig().copy(language = "Spanish", dialect = "Castilian Spanish (Madrid)", level = Level.INTERMEDIATE)
        val id = c.sessions.startSession(cfg, start)
        c.sessions.addTurn(id, Speaker.USER, "Ayer yo ha ido al mercado y compré muchos manzanas.", start)
        c.sessions.finishSession(id, start + 12 * 60_000, "Great walk!", cfg)
        c.vocab.capture("fui", "I went", "Ayer fui al mercado.", "Spanish", id, VocabSource.TUTOR, VocabCapture.reasonLabel("corrected"))
        c.vocab.capture("muchas", "many (fem.)", "Compré muchas manzanas.", "Spanish", id, VocabSource.TUTOR, VocabCapture.reasonLabel("corrected"))
        c.vocab.capture("madrugar", "to get up early", "", "Spanish", id, VocabSource.MINED, VocabCapture.reasonLabel("asked_meaning"))
        c.vocab.capture("despacio", "slowly", "", "Spanish", id, VocabSource.MINED, VocabCapture.reasonLabel("asked_how_to_say"))
        c.sessions.saveReview(id, "Past tense of ir: say \"fui\", not \"ha ido\".", "Shopping at the market", "Role-play buying fruit at a market stall; practise fui and quantities.")
        c.sessions.markMined(id)
    }

    /** Mirrors what the real Gemini Spanish walk (RealGeminiIntegrationTest.full_spanish_walk) persisted. */
    private fun seedRealWalk() = runBlocking {
        val c = container
        val start = System.currentTimeMillis() - 30 * 60_000
        val cfg = SessionConfig().copy(language = "Spanish", dialect = "Castilian Spanish", level = Level.INTERMEDIATE)
        val id = c.sessions.startSession(cfg, start)
        val turns = listOf(
            Speaker.TUTOR to "¡Hola! ¿Qué tal el paseo? ¿Hace buen día por ahí?",
            Speaker.USER to "Hola, me llamo Juan.",
            Speaker.USER to "Hoy estoy caminando por el parque.",
            Speaker.TUTOR to "¡Encantado, Juan! ¡Qué bien! ¿Te gusta caminar por el parque habitualmente?",
            Speaker.USER to "Perdona, ¿qué significa la palabra madrugar? Vale, guarda esa palabra, por favor.",
            Speaker.TUTOR to "¡Hecho! \"Habitualmente\" guardada. ¿Y qué tiempo hace hoy?¡Hecho! \"Habitualmente\" guardada. ¿Y qué tiempo hace hoy?",
            Speaker.USER to "Ayer yo ha ido al mercado y compré muchos manzanas.",
            Speaker.TUTOR to "¡Ah, qué bien! ¿Y qué más compraste en el mercado, Juan?",
            Speaker.SYSTEM to "Switched by voice to Italian · Standard · Beginner",
            Speaker.TUTOR to "Parliamo italiano adesso. Ti piace camminare nel parco?",
        )
        turns.forEachIndexed { i, (s, t) -> c.sessions.addTurn(id, s, t, start + i * 30_000L) }
        val recap = "Oggi abbiamo parlato in italiano, che bello! All'inizio hai detto \"io ha ido\" in spagnolo, remember? We noted \"habitualmente\" (usually) and \"mercado\" (market). Continua a praticare e migliorerai prestissimo! Ciao!"
        c.sessions.finishSession(id, start + 12 * 60_000, recap, cfg.copy(language = "Italian", dialect = "Standard", level = Level.BEGINNER))
        c.vocab.save("habitualmente", "usually", "¿Te gusta caminar por el parque habitualmente?", "Spanish", id)
        c.vocab.capture("ha ido", "I have gone", "Ayer yo ha ido al mercado", "Spanish", id, VocabSource.TUTOR, VocabCapture.reasonLabel("struggled"))
        c.vocab.capture("muchos", "many", "compré muchos manzanas", "Spanish", id, VocabSource.TUTOR, VocabCapture.reasonLabel("struggled"))
        listOf(
            Triple("madrugar", "to wake up early", "asked_meaning"),
            Triple("despacio", "slowly", "asked_how_to_say"),
            Triple("Cambiemos al italiano, por favor.", "Let's switch to Italian, please.", "struggled"),
            Triple("Encantado", "Nice to meet you (male)", "introduced"),
            Triple("Hecho", "Done!", "introduced"),
            Triple("específico", "specific", "introduced"),
        ).forEach { (w, t, r) -> c.vocab.capture(w, t, "", "Spanish", id, VocabSource.MINED, VocabCapture.reasonLabel(r)) }
    }
}
