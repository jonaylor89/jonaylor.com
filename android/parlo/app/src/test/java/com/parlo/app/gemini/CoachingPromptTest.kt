package com.parlo.app.gemini

import com.parlo.app.model.CorrectionStyle
import com.parlo.app.model.Encouragement
import com.parlo.app.model.Level
import com.parlo.app.model.SessionConfig
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.*
import org.junit.Test

class CoachingPromptTest {
    @Test fun `tutor owns the next move without rushing the learner`() {
        val prompt = PromptBuilder.systemInstruction(SessionConfig())
        assertTrue(prompt.contains("You drive what happens next"))
        assertTrue(prompt.contains("SAME reply"))
        assertTrue(prompt.contains("Never stop after only praise"))
        assertTrue(prompt.contains("one clear invitation"))
        assertTrue(prompt.contains("Then wait for their answer"))
        assertTrue(prompt.contains("Explicit stop/end requests and the final recap are exceptions"))
        assertTrue(prompt.contains("don't fill it repeatedly"))
    }

    @Test fun `beginner difficulty never implies a childlike coaching tone`() {
        for (tone in Encouragement.entries) {
            val config = SessionConfig(level = Level.SUPER_BEGINNER, encouragement = tone, onboarding = true)
            val prompt = PromptBuilder.systemInstruction(config)
            assertTrue(prompt.contains("Encouragement (${tone.label})"))
            assertTrue(prompt.contains(tone.instruction))
            assertTrue(prompt.contains("Always speak adult-to-adult"))
            assertFalse(prompt.contains("celebrate small wins"))
            assertFalse(prompt.contains("Accept one-word answers, English answers, and rough pronunciation warmly"))
            assertTrue(PromptBuilder.learnerInstruction(config).contains(tone.instruction))
            assertTrue(PromptBuilder.recapMessage(config).contains(tone.instruction))
        }
    }

    @Test fun `just chat still takes initiative without imposing a curriculum`() {
        val prompt = PromptBuilder.systemInstruction(SessionConfig(followPlan = false))
        assertTrue(prompt.contains("JUST CHAT"))
        assertTrue(prompt.contains("In Just chat, take conversational initiative"))
        assertTrue(prompt.contains("without imposing a lesson or review agenda"))
    }

    @Test fun `changing tone live gives the new instruction without changing level or corrections`() {
        val old = SessionConfig(level = Level.ADVANCED, correctionStyle = CorrectionStyle.NONE, encouragement = Encouragement.WARM)
        val changed = old.copy(encouragement = Encouragement.MATTER_OF_FACT)
        val instruction = PromptBuilder.switchMessage(old, changed)
        assertTrue(instruction.contains(Encouragement.MATTER_OF_FACT.instruction))
        assertFalse(instruction.contains("Encouragement (Warm)"))
        assertFalse(instruction.contains("at Advanced level"))
        assertFalse(instruction.contains("correction style"))
        assertEquals(old.level, changed.level)
        assertEquals(old.correctionStyle, changed.correctionStyle)
    }

    @Test fun `voice tools advertise all tone positions and old configurations get the calmer default`() {
        val function = PromptBuilder.toolDeclarations().single().functionDeclarations.single { it.name == "update_walk" }
        val values = function.parameters!!.jsonObject["properties"]!!.jsonObject["encouragement"]!!.jsonObject["enum"]!!.jsonArray
        assertEquals(Encouragement.entries.map { it.name }, values.map { it.jsonPrimitive.content })
        assertEquals(Encouragement.LOW_KEY, Json.decodeFromString<SessionConfig>("""{"language":"German"}""").encouragement)
        assertEquals(Encouragement.MATTER_OF_FACT, Encouragement.parse("Matter-of-fact"))
        assertEquals(Encouragement.VERY_ENCOURAGING, Encouragement.parse("VERY_ENCOURAGING"))
        assertEquals(Encouragement.LOW_KEY, Encouragement.parse("obsolete-setting"))
        assertNull(Encouragement.parseOrNull("obsolete-setting"))
    }
}
