package com.parlo.app

import com.parlo.app.data.VocabRepository
import com.parlo.app.data.db.SessionEntity
import com.parlo.app.data.db.VocabDao
import com.parlo.app.data.db.VocabEntity
import com.parlo.app.data.db.VocabSource
import com.parlo.app.data.db.VocabStatus
import com.parlo.app.gemini.FunctionCall
import com.parlo.app.gemini.PromptBuilder
import com.parlo.app.gemini.ToolHandler
import com.parlo.app.gemini.VocabMiner
import com.parlo.app.model.CorrectionStyle
import com.parlo.app.model.Level
import com.parlo.app.model.Scenario
import com.parlo.app.model.SessionConfig
import com.parlo.app.model.TryPhrase
import com.parlo.app.model.WalkMemory
import com.parlo.app.ui.lastWalkOf
import com.parlo.app.ui.walkLengthLabel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class WalkLoopTest {

    private class Dao : VocabDao {
        val rows = MutableStateFlow<List<VocabEntity>>(emptyList())
        override suspend fun insert(vocab: VocabEntity): Long {
            val id = vocab.id.takeIf { it != 0L } ?: (rows.value.size + 1L)
            rows.value = rows.value + vocab.copy(id = id); return id
        }
        override suspend fun delete(vocab: VocabEntity) { rows.value = rows.value.filterNot { it.id == vocab.id } }
        override fun observeAll(): Flow<List<VocabEntity>> = rows
        override suspend fun countForSession(sessionId: Long) = rows.value.count { it.sessionId == sessionId }
        override suspend fun find(language: String, word: String) =
            rows.value.firstOrNull { it.language.equals(language, true) && it.word.equals(word, true) }
        override suspend fun wordsFor(language: String) = rows.value.filter { it.language.equals(language, true) }.map { it.word }
        override suspend fun recentWords(language: String, limit: Int) =
            rows.value.filter { it.language.equals(language, true) }.sortedByDescending { it.savedAt }.take(limit).map { it.word }
        override suspend fun setStatus(id: Long, status: String) { rows.value = rows.value.map { if (it.id == id) it.copy(status = status) else it } }
        override suspend fun keepAllSuggested() = Unit
        override suspend fun deleteAllSuggested() = Unit
    }

    private val dao = Dao()
    private val repo = VocabRepository(dao)
    private val updates = mutableListOf<ToolHandler.WalkUpdate>()
    private var ended = 0
    private val profiles = mutableListOf<ToolHandler.ProfileUpdate>()
    private val phrases = mutableListOf<TryPhrase>()
    private val agentic = ToolHandler(
        vocab = repo,
        currentLanguage = { "Spanish" },
        currentDialect = { "Castilian Spanish (Madrid)" },
        currentLevel = { Level.INTERMEDIATE },
        sessionId = { 1L },
        onVocabSaved = {},
        onLanguageSwitched = {},
        onProfileUpdated = { profiles += it },
        onShowPhrase = { phrases += it },
    )

    @Test
    fun `update_learner_profile canonicalises language, parses level, rejects empty`() = runTest {
        val r = agentic.handle(FunctionCall(id = "p", name = "update_learner_profile", args = buildJsonObject {
            put("language", "japanese"); put("goal", "travel in Osaka"); put("level", "super beginner")
        }))
        assertEquals("ok", r.response["result"]!!.jsonPrimitive.content)
        assertEquals(ToolHandler.ProfileUpdate(language = "Japanese", goal = "travel in Osaka", level = Level.SUPER_BEGINNER), profiles.single())
        val empty = agentic.handle(FunctionCall(name = "update_learner_profile", args = buildJsonObject {}))
        assertTrue(empty.response.containsKey("error"))
        assertEquals(1, profiles.size)
    }

    @Test
    fun `show_phrase needs a phrase and passes the translation`() = runTest {
        agentic.handle(FunctionCall(id = "s", name = "show_phrase", args = buildJsonObject {
            put("phrase", "¿Me da medio kilo?"); put("translation", "Can I have half a kilo?")
        }))
        assertEquals(TryPhrase("¿Me da medio kilo?", "Can I have half a kilo?"), phrases.single())
        val bad = agentic.handle(FunctionCall(name = "show_phrase", args = buildJsonObject {}))
        assertTrue(bad.response.containsKey("error"))
    }

    @Test
    fun `onboarding walk asks in English and uses the profile tool`() {
        val prompt = PromptBuilder.systemInstruction(SessionConfig(onboarding = true))
        assertTrue(prompt.contains("first walk"))
        assertTrue(prompt.contains("update_learner_profile"))
        assertFalse(PromptBuilder.systemInstruction(SessionConfig()).contains("update_learner_profile"))
        assertEquals(Level.ADVANCED, Level.INTERMEDIATE.harder())
        assertEquals(Level.ADVANCED, Level.ADVANCED.harder())
    }

    private val handler = ToolHandler(
        vocab = repo,
        currentLanguage = { "Spanish" },
        currentDialect = { "Madrid Spanish" },
        currentLevel = { Level.INTERMEDIATE },
        sessionId = { 3L },
        onVocabSaved = {},
        onLanguageSwitched = {},
        onWalkUpdated = { updates += it },
        onEndWalk = { ended++ },
    )

    @Test
    fun `tutor and mined captures are saved by default and drop restores cleanly`() = runTest {
        repo.capture("la cuenta", "the bill", "", "Spanish", 3L, VocabSource.TUTOR, "")
        repo.capture("madrugar", "get up early", "", "Spanish", 3L, VocabSource.MINED, "")
        assertTrue(dao.rows.value.all { it.status == VocabStatus.KEPT.name })
        assertNull(repo.capture("La Cuenta", "", "", "Spanish", 3L, VocabSource.MINED, ""))
        val dropped = dao.rows.value.first()
        repo.delete(dropped)
        assertEquals(1, dao.rows.value.size)
        repo.restore(listOf(dropped))
        assertEquals(2, dao.rows.value.size)
    }

    @Test
    fun `update_walk parses topic, scenario and correction style`() = runTest {
        val r = handler.handle(FunctionCall(id = "u", name = "update_walk", args = buildJsonObject {
            put("topic", "Haggling at a market"); put("scenario", "cafe"); put("correction_style", "EXPLICIT")
        }))
        assertEquals("ok", r.response["result"]!!.jsonPrimitive.content)
        assertEquals(ToolHandler.WalkUpdate("Haggling at a market", Scenario.CAFE, CorrectionStyle.EXPLICIT), updates.single())
        val empty = handler.handle(FunctionCall(name = "update_walk", args = buildJsonObject { put("scenario", "nonsense") }))
        assertTrue(empty.response.containsKey("error"))
        assertEquals(1, updates.size)
    }

    @Test
    fun `end_walk ends the session and tells the model to wait for the recap`() = runTest {
        val r = handler.handle(FunctionCall(id = "e", name = "end_walk"))
        assertEquals(1, ended)
        assertEquals("ending", r.response["result"]!!.jsonPrimitive.content)
        val names = PromptBuilder.toolDeclarations().flatMap { it.functionDeclarations }.map { it.name }
        assertTrue(names.containsAll(listOf("update_walk", "end_walk")))
    }

    @Test
    fun `prompt carries the topic and memory only for the same language`() {
        val c = SessionConfig(topic = "Ordering tapas at a bar; practise quantities", topicTitle = "Ordering tapas")
        val mem = WalkMemory("Spanish", focus = "Past tense of ir (fui, not ha ido).", reviewWords = listOf("madrugar", "la cuenta"))
        val prompt = PromptBuilder.systemInstruction(c, mem)
        assertTrue(prompt.contains("Current topic: Ordering tapas at a bar"))
        assertTrue(prompt.contains("fui, not ha ido"))
        assertTrue(prompt.contains("madrugar, la cuenta"))
        assertFalse(PromptBuilder.systemInstruction(c.copy(language = "Italian"), mem).contains("Memory from earlier walks"))
        assertFalse(PromptBuilder.systemInstruction(SessionConfig()).contains("Memory from earlier walks"))
        assertTrue(PromptBuilder.switchMessage(SessionConfig(), c).contains("switch the topic to: Ordering tapas"))
    }

    @Test
    fun `walk review parses focus and next walk, and still accepts a bare word array`() {
        val miner = VocabMiner(OkHttpClient())
        fun wrap(t: String) = """{"candidates":[{"content":{"parts":[{"text":${kotlinx.serialization.json.JsonPrimitive(t)}}]}}]}"""
        val r = miner.parseReview(wrap("""{"words":[{"word":"fui","translation":"I went"}],"focus":"Use fui for past trips.","next_walk":{"title":"Weekend plans","prompt":"Ask about last weekend."}}"""), emptyList(), 6)
        assertEquals(listOf("fui"), r.words.map { it.word })
        assertEquals("Use fui for past trips.", r.focus)
        assertEquals("Weekend plans", r.nextWalkTitle)
        assertEquals("Ask about last weekend.", r.nextWalkPrompt)
        val legacy = miner.parseReview(wrap("""[{"word":"perro","translation":"dog"}]"""), emptyList(), 6)
        assertEquals(listOf("perro"), legacy.words.map { it.word })
        assertEquals("", legacy.focus)
    }

    @Test
    fun `last walk uses only real numbers from the latest finished session`() {
        val sessions = listOf(
            SessionEntity(id = 1, startedAt = 1_000, endedAt = 2_000, language = "Spanish", dialect = "", level = "BEGINNER", scenario = "FREE", correctionStyle = "GENTLE", durationMs = 1_000),
            SessionEntity(id = 2, startedAt = 5_000, endedAt = 725_000, language = "Spanish", dialect = "", level = "BEGINNER", scenario = "FREE", correctionStyle = "GENTLE", durationMs = 720_000, focus = "fui", nextWalkTitle = "Weekend", nextWalkPrompt = "Ask about it"),
            SessionEntity(id = 3, startedAt = 9_000, endedAt = null, language = "Spanish", dialect = "", level = "BEGINNER", scenario = "FREE", correctionStyle = "GENTLE"),
        )
        val words = listOf(
            VocabEntity(id = 1, word = "fui", translation = "", exampleSentence = "", language = "Spanish", savedAt = 1, sessionId = 2),
            VocabEntity(id = 2, word = "old", translation = "", exampleSentence = "", language = "Spanish", savedAt = 1, sessionId = 1),
        )
        val w = lastWalkOf(sessions, words, mining = setOf(2L))!!
        assertEquals(2L, w.sessionId)
        assertEquals("12 min", w.lengthLabel)
        assertEquals(listOf("fui"), w.words.map { it.word })
        assertTrue(w.reviewing)
        assertEquals("Under a minute", walkLengthLabel(30_000))
        assertNull(lastWalkOf(emptyList(), words, emptySet()))
    }
}
