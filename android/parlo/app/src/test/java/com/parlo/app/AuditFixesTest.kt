package com.parlo.app

import com.parlo.app.data.LiveModelDiscovery
import com.parlo.app.gemini.GeminiApi
import com.parlo.app.model.LanguageCatalog
import com.parlo.app.model.SessionError
import com.parlo.app.service.collapseRepeat
import com.parlo.app.ui.history.sessionTitle
import com.parlo.app.ui.settings.modelLabel
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class AuditFixesTest {
    @Test fun `non-conversational live models are filtered`() {
        assertFalse(LiveModelDiscovery.isConversational("gemini-3.5-transcribe-live"))
        assertFalse(LiveModelDiscovery.isConversational("gemini-3.8-live-extended-thinking"))
        assertFalse(LiveModelDiscovery.isConversational("gemini-robotics-er-2-streaming-preview"))
        assertFalse(LiveModelDiscovery.isConversational("gemini-3.5-live-translate-preview"))
        assertTrue(LiveModelDiscovery.isConversational("gemini-2.5-flash-native-audio-preview-12-2025"))
    }

    @Test fun `close 1007 is a fatal config error`() {
        val err = GeminiApi.classifyError(1007, "Thinking level must be specified for this model.", "m")
        assertTrue(err is SessionError.UnsupportedConfig)
    }

    @Test fun `repeated transcript collapses to one copy`() {
        assertEquals("¡Hecho! ¿Y hoy?", collapseRepeat("¡Hecho! ¿Y hoy?¡Hecho! ¿Y hoy?"))
        assertEquals("Hola, hola amigo", collapseRepeat("Hola, hola amigo"))
    }

    @Test fun `free-text dialect maps onto the catalog`() {
        val default = LanguageCatalog.defaultDialectFor("Spanish")
        assertEquals(default, LanguageCatalog.canonicalDialect("Spanish", "Standard"))
        val first = LanguageCatalog.dialectsOf("Spanish").first().name
        assertEquals(first, LanguageCatalog.canonicalDialect("Spanish", first.lowercase()))
    }

    @Test fun `history title always names the language`() {
        assertEquals("Italian · Standard", sessionTitle("Italian", "Standard"))
        assertEquals("Castilian Spanish", sessionTitle("Spanish", "Castilian Spanish"))
        assertEquals("Italian", sessionTitle("Italian", ""))
    }

    @Test fun `model label is readable`() {
        assertEquals(
            "Gemini 2.5 Flash Native Audio Preview",
            modelLabel("models/gemini-2.5-flash-native-audio-preview-12-2025"),
        )
    }
}
