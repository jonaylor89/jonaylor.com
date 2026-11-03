package com.parlo.app.data

import android.app.Application
import androidx.test.core.app.ApplicationProvider
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.CorrectionStyle
import okhttp3.OkHttpClient
import com.parlo.app.uiaudit.KeystoreRunner
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

@RunWith(KeystoreRunner::class)
@Config(sdk = [34], application = Application::class)
class SettingsRepositoryTest {
    private lateinit var settings: SettingsRepository

    @Before
    fun setUp() = runBlocking {
        settings = SettingsRepository(ApplicationProvider.getApplicationContext())
        settings.saveConfig(SessionConfig())
    }

    @Test
    fun `voice changes remain authoritative for subsequent edits and the next walk`() = runBlocking {
        val voiceSelection = SessionConfig(language = "Japanese", dialect = "Kansai Japanese", voice = "Kore")
        settings.saveConfig(voiceSelection)
        settings.updateConfig { it.copy(correctionStyle = CorrectionStyle.NONE) }
        val nextWalk = settings.currentConfig()
        assertEquals("Japanese", nextWalk.language)
        assertEquals("Kansai Japanese", nextWalk.dialect)
        assertEquals("Kore", nextWalk.voice)
        assertEquals(nextWalk, settings.config.first())
    }

    @Test
    fun `concurrent edits transform latest preferences rather than a shared stale snapshot`() = runBlocking {
        coroutineScope {
            launch { settings.updateConfig { it.copy(language = "Italian", dialect = "Roman Italian") } }
            launch { settings.updateConfig { it.copy(voice = "Aoede") } }
        }
        assertEquals("Italian", settings.currentConfig().language)
        assertEquals("Aoede", settings.currentConfig().voice)
    }

    @Test
    fun `each language restores its own level accent topic and correction preference`() = runBlocking {
        settings.saveConfig(SessionConfig(language = "German", dialect = "Austrian German", level = com.parlo.app.model.Level.ADVANCED,
            topic = "Prepare for an interview", topicTitle = "Interview", correctionStyle = CorrectionStyle.NONE))
        settings.selectLanguage("Hungarian")
        assertEquals(com.parlo.app.model.Level.SUPER_BEGINNER, settings.currentConfig().level)
        assertEquals("", settings.currentConfig().topic)
        assertFalse(settings.currentConfig().dialect.contains("German"))
        settings.updateConfig { it.copy(level = com.parlo.app.model.Level.BEGINNER, followPlan = false) }
        settings.selectLanguage("German")
        val german = settings.currentConfig()
        assertEquals(com.parlo.app.model.Level.ADVANCED, german.level)
        assertEquals("Austrian German", german.dialect)
        assertEquals("Interview", german.topicTitle)
        assertEquals(CorrectionStyle.NONE, german.correctionStyle)
        settings.selectLanguage("Hungarian")
        assertEquals(com.parlo.app.model.Level.BEGINNER, settings.currentConfig().level)
        assertFalse(settings.currentConfig().followPlan)
        settings.selectLanguage("German", level = com.parlo.app.model.Level.BEGINNER)
        // Explicit level wins even when it matches the previous language's level.
        assertEquals(com.parlo.app.model.Level.BEGINNER, settings.currentConfig().level)
    }

    @Test
    fun `just chat survives a restart and another language's lesson`() = runBlocking {
        settings.saveConfig(SessionConfig(language = "German", followPlan = false))
        settings.selectLanguage("Catalan")
        settings.updateConfig { it.copy(topic = "Ordering food", topicTitle = "Cafe", followPlan = true) }
        settings.selectLanguage("German")
        assertFalse(settings.currentConfig().followPlan)
        assertEquals("", settings.currentConfig().topic)
        assertFalse(settings.currentConfig().onboarding)
    }

    @Test
    fun `encouragement persists globally across repository recreation and language switching`() = runBlocking {
        settings.saveConfig(SessionConfig(language = "German", encouragement = com.parlo.app.model.Encouragement.WARM))
        settings.selectLanguage("Hungarian")
        settings.updateConfig { it.copy(encouragement = com.parlo.app.model.Encouragement.MATTER_OF_FACT) }
        settings = SettingsRepository(ApplicationProvider.getApplicationContext())
        assertEquals(com.parlo.app.model.Encouragement.MATTER_OF_FACT, settings.currentConfig().encouragement)
        settings.selectLanguage("German") // The old German snapshot was warm; tone is a global preference.
        assertEquals(com.parlo.app.model.Encouragement.MATTER_OF_FACT, settings.currentConfig().encouragement)
        settings.updateConfig { it.copy(voice = "Kore", level = com.parlo.app.model.Level.BEGINNER) }
        assertEquals(com.parlo.app.model.Encouragement.MATTER_OF_FACT, settings.currentConfig().encouragement)
        settings.selectLanguage("Japanese")
        assertEquals(com.parlo.app.model.Encouragement.MATTER_OF_FACT, settings.currentConfig().encouragement)
    }

    @Test
    fun `cached models use the new ranking even before a network refresh`() = runBlocking {
        settings.saveCachedModels(listOf(
            "gemini-2.5-flash-native-audio-preview-12-2025",
            "gemini-3.8-live-extended-thinking",
            "gemini-3.8-live",
        ))
        val models = ModelRepository(settings, LiveModelDiscovery(OkHttpClient()))
        models.loadCached()
        assertEquals(listOf("gemini-3.8-live", "gemini-2.5-flash-native-audio-preview-12-2025"), models.models.value)
    }

    @Test
    fun `automatic model stays automatic and transient onboarding is not persisted`() = runBlocking {
        settings.saveConfig(SessionConfig(onboarding = true, topic = "Ordering tapas", topicTitle = "At the bar"))
        val config = settings.currentConfig()
        assertEquals("", config.model)
        assertEquals(false, config.onboarding)
        assertEquals("Ordering tapas", config.topic)
        assertEquals("At the bar", config.topicTitle)
        settings.updateConfig { it.copy(model = "gemini-3.1-flash-live-preview") }
        assertEquals("gemini-3.1-flash-live-preview", settings.currentConfig().model)
        settings.updateConfig { it.copy(model = "") }
        assertEquals("", settings.currentConfig().model)
    }
}
