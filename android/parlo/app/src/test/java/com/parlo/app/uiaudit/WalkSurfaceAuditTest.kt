package com.parlo.app.uiaudit

import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onRoot
import com.github.takahirom.roborazzi.captureRoboImage
import com.parlo.app.model.AudioState
import com.parlo.app.model.ConnectionState
import com.parlo.app.model.LearnerProfile
import com.parlo.app.model.LiveSessionState
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.Speaker
import com.parlo.app.model.TranscriptTurn
import com.parlo.app.model.TryPhrase
import com.parlo.app.ui.SetupStatus
import com.parlo.app.ui.main.WalkScreen
import com.parlo.app.ui.onboarding.WelcomeScreen
import com.parlo.app.ui.theme.ParloTheme
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Tool-driven walk states (update_learner_profile, show_phrase) that a live socket can't reach deterministically. */
@RunWith(RobolectricTestRunner::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(sdk = [34], qualifiers = "w412dp-h915dp-xxhdpi")
class WalkSurfaceAuditTest {
    @get:Rule val rule = createComposeRule()

    private fun render(name: String, live: LiveSessionState) {
        rule.setContent {
            ParloTheme {
                Surface(Modifier.fillMaxSize()) {
                    WalkScreen(live = live, onToggleMute = {}, onSlower = {}, onEnglish = {}, onEnd = {}, modifier = Modifier.padding(16.dp))
                }
            }
        }
        rule.onRoot().captureRoboImage("build/uiaudit/$name.png")
    }

    private val onboarding = LiveSessionState(
        connection = ConnectionState.CONNECTED,
        audio = AudioState.SPEAKING,
        config = SessionConfig(language = "Spanish", dialect = "Mexican Spanish (Mexico City)", onboarding = true),
        profile = LearnerProfile(language = "Spanish", dialect = "Mexican Spanish (Mexico City)"),
        transcript = listOf(TranscriptTurn(1, Speaker.TUTOR, "Great, Mexican Spanish it is. Is this for travel, work, or family?", 0)),
    )

    private val walking = LiveSessionState(
        connection = ConnectionState.CONNECTED,
        audio = AudioState.LISTENING,
        config = SessionConfig(topicTitle = "At the mercado"),
        phrase = TryPhrase("¿Me da medio kilo de tomates?", "Can I have half a kilo of tomatoes?"),
        caughtWords = listOf("la báscula", "medio kilo"),
        transcript = listOf(TranscriptTurn(1, Speaker.TUTOR, "Claro. ¿Y qué más necesita? Tenemos aguacates muy buenos hoy.", 0)),
    )

    @Test fun k_onboarding_tiles() = render("30_onboarding_tiles", onboarding)
    @Test @Config(qualifiers = "+night") fun l_onboarding_tiles_dark() = render("31_onboarding_tiles_dark", onboarding)
    @Test fun m_walk_try_saying() = render("32_walk_try_saying", walking)
    @Test @Config(qualifiers = "+night") fun n_walk_try_saying_dark() = render("33_walk_try_saying_dark", walking)
    @Test fun o_walk_muted() = render("34_walk_muted", walking.copy(muted = true, audio = AudioState.MUTED, phrase = null))

    @Test fun p_welcome_connected() {
        rule.setContent {
            ParloTheme { Surface(Modifier.fillMaxSize()) { WelcomeScreen(SetupStatus.READY, "AIza••••x3fQ", {}, {}) } }
        }
        rule.onRoot().captureRoboImage("build/uiaudit/35_welcome_connected.png")
    }
}
