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
